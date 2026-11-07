"""Fit driver, car and era-affinity ratings from every Grand Prix since 1950.

Model
-----
For every race start we take two observations of performance:

* the driver's finishing rank among classified finishers, and
* the driver's qualifying rank (the race grid before 1994),

each converted to a normal score (rank -> z, higher = better), so a race win is about +1.8
and last place about -1.8 whatever the field size.

Each observation is explained as::

    score = driver skill                      (one number per driver, their peak level)
          + car                               (one number per constructor per season)
          + privateer entry                   (pre-80s customer cars: driver's car vs the works car)
          + driver x era affinity             (how much better/worse they were in that generation)
          + age curve                         (shared by everyone, peak = 0)
          + experience curve                  (shared by everyone, by career starts so far)
          + noise

The model is fitted as one big sparse ridge regression. Teammates share a car, so the car term
soaks up the machinery and the driver term is driven by teammate comparisons, chained across
careers. Each group of terms gets its own penalty (strong for affinities so they only move away
from zero when the evidence is consistent). Penalties are picked by 5-fold cross-validation over
held-out Grands Prix.

Wet skill is fitted in a second stage on wet races only::

    wet race score = a * predicted dry pace + wet skill + noise

``a`` < 1 soaks up the extra chaos of wet races, so wet skill measures how much better a driver
did than their pace predicts *given* that rain shuffles everyone.

Calibration
-----------
Scores are converted to lap time by regressing 2014+ qualifying time gaps (%) on the model's
predicted pace, giving "% of lap time per score unit". The simulator therefore runs every car
in a modern-sized performance spread, whatever year it comes from.

Run ``python -m f1dpi.fit`` to rebuild ``model/ratings.json``.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy import sparse
from scipy.sparse.linalg import lsqr
from scipy.stats import norm

from . import eras as E
from .dataset import (STATUS_ACCIDENT, STATUS_FINISHED, STATUS_LAPPED, STATUS_MECHANICAL,
                      Tables, load_tables, qualifying_order, race_starts)
from .paths import MODEL_DIR, RATINGS_JSON
from .wet_races import WET_RACES

AGE_EDGES = [0, 22, 24.5, 27, 29.5, 32, 34.5, 37, 40, 99]
AGE_LABELS = ["<22", "22-24", "24-27", "27-29", "29-32", "32-34", "34-37", "37-40", "40+"]
EXP_EDGES = [0, 12, 30, 60, 100, 10_000]   # career starts so far
EXP_LABELS = ["0-11", "12-29", "30-59", "60-99", "100+"]
MULTI_ENTRANT_DRIVERS = 4   # constructor-seasons with this many drivers had customer/privateer cars
CALIBRATION_FROM = 2014


def normal_scores(rank: pd.Series, n: pd.Series) -> np.ndarray:
    """Blom normal scores; rank 1 -> high positive value."""
    return -norm.ppf((rank - 0.375) / (n + 0.25))


@dataclass
class Observations:
    df: pd.DataFrame          # one row per observation
    starts: pd.DataFrame      # race starts with derived columns


def build_observations(t: Tables) -> Observations:
    s = race_starts(t)
    s = s.sort_values(["date", "round_id"])
    s["career_start"] = s.groupby("driver_id").cumcount()
    s["era"] = s["year"].map(lambda y: E.era_for_year(y).key)
    s["car_key"] = s["team_ref"] + "@" + s["year"].astype(str)
    wet = set(WET_RACES)
    s["wet"] = [(y, n) in wet for y, n in zip(s["year"], s["race_name"])]

    # race finishing order among classified finishers
    fin = s[s["status"].isin([STATUS_FINISHED, STATUS_LAPPED]) & s["position"].notna()].copy()
    fin["rank"] = fin.groupby("round_id")["position"].rank(method="first")
    fin["n"] = fin.groupby("round_id")["rank"].transform("size")
    fin = fin[fin["n"] >= 5]
    fin["y"] = normal_scores(fin["rank"], fin["n"])
    fin["kind"] = "race"

    # qualifying order among starters
    q = qualifying_order(t).merge(s, on=["round_id", "driver_id"], how="inner")
    q["rank"] = q.groupby("round_id")["quali_rank"].rank(method="first")
    q["n"] = q.groupby("round_id")["rank"].transform("size")
    q = q[q["n"] >= 5]
    q["y"] = normal_scores(q["rank"], q["n"])
    q["kind"] = "quali"
    q["wet"] = False  # we don't know qualifying weather

    cols = ["round_id", "year", "date", "driver_id", "driver_ref", "car_key", "era", "age",
            "career_start", "wet", "kind", "y"]
    obs = pd.concat([fin[cols], q[cols]], ignore_index=True)
    obs = obs[obs["age"].notna()].reset_index(drop=True)
    return Observations(obs, s)


@dataclass
class Design:
    X: sparse.csr_matrix
    groups: dict            # group -> (start, stop)
    index: dict             # group -> list of labels


def build_design(obs: pd.DataFrame) -> Design:
    n = len(obs)
    rows = np.arange(n)
    R, C, V = [], [], []
    groups, index = {}, {}
    col = 0

    def add(group, codes, labels):
        nonlocal col
        codes = np.asarray(codes)
        ok = codes >= 0
        R.append(rows[ok])
        C.append(codes[ok] + col)
        V.append(np.ones(ok.sum()))
        groups[group] = (col, col + len(labels))
        index[group] = list(labels)
        col += len(labels)

    d_codes, d_labels = pd.factorize(obs["driver_ref"])
    add("driver", d_codes, d_labels)
    c_codes, c_labels = pd.factorize(obs["car_key"])
    add("car", c_codes, c_labels)
    # a team's strength across a whole rule set; without this, a driver who spent an entire era
    # at one team would get that team's multi-year strength credited to their era affinity
    te_codes, te_labels = pd.factorize(obs["car_key"].str.split("@").str[0] + "|" + obs["era"])
    add("team_era", te_codes, te_labels)
    de = obs["driver_ref"] + "|" + obs["era"]
    de_codes, de_labels = pd.factorize(de)
    add("affinity", de_codes, de_labels)
    a_codes = pd.cut(obs["age"], AGE_EDGES, labels=False, right=False).fillna(-1).astype(int).to_numpy()
    add("age", a_codes, AGE_LABELS)
    x_codes = pd.cut(obs["career_start"], EXP_EDGES, labels=False, right=False).fillna(-1).astype(int).to_numpy()
    add("experience", x_codes, EXP_LABELS)
    # privateer/customer entries: let each driver's car in a multi-entrant constructor-season
    # deviate from the works car instead of assuming everyone had identical machinery
    multi = obs.groupby("car_key")["driver_ref"].transform("nunique") >= MULTI_ENTRANT_DRIVERS
    ent = np.where(multi, obs["driver_ref"] + "|" + obs["car_key"], None)
    e_codes, e_labels = pd.factorize(pd.Series(ent), use_na_sentinel=True)
    add("entry", e_codes, e_labels)

    X = sparse.csr_matrix((np.concatenate(V), (np.concatenate(R), np.concatenate(C))),
                          shape=(n, col))
    return Design(X, groups, index)


def ridge(design: Design, y: np.ndarray, lambdas: dict, rows=None) -> np.ndarray:
    X = design.X if rows is None else design.X[rows]
    yy = y if rows is None else y[rows]
    scale = np.ones(X.shape[1])
    for g, (a, z) in design.groups.items():
        scale[a:z] = 1.0 / np.sqrt(lambdas[g])
    Xs = X @ sparse.diags(scale)
    c = lsqr(Xs, yy, damp=1.0, atol=1e-8, btol=1e-8, iter_lim=5000)[0]
    return c * scale


def cross_validate(design: Design, obs: pd.DataFrame, lambdas: dict, k: int = 5) -> float:
    y = obs["y"].to_numpy()
    fold = obs["round_id"].to_numpy() % k
    err = []
    for f in range(k):
        train = fold != f
        b = ridge(design, y, lambdas, np.where(train)[0])
        pred = design.X[np.where(~train)[0]] @ b
        err.append(np.mean((y[~train] - pred) ** 2))
    return float(np.mean(err))


DEFAULT_PENALTIES = {"driver": 1.0, "car": 1.0, "team_era": 1.0, "entry": 3.0,
                     "affinity": 30.0, "age": 1.0, "experience": 1.0}
# The affinity penalty is fixed rather than tuned. Cross-validation slightly prefers weaker
# penalties (~0.5% lower error), but then a driver who spent a whole era at one team (Verstappen
# and Perez at Red Bull 2022-24) gets the team's strength credited to their personal era
# affinity, and the car looks ordinary. 30 keeps affinities about teammate-relative form.


def tune(design: Design, obs: pd.DataFrame, verbose=True) -> dict:
    """Coordinate search over the penalty for each group of terms."""
    lam = dict(DEFAULT_PENALTIES)
    grid = {"driver": [0.3, 1, 3], "car": [0.3, 1, 3], "team_era": [0.3, 1, 3],
            "entry": [1, 3, 10]}
    best = cross_validate(design, obs, lam)
    if verbose:
        print(f"  start cv-mse={best:.4f}")
    for _ in range(3):
        improved = False
        for g, vals in grid.items():
            for v in vals:
                if v == lam[g]:
                    continue
                trial = dict(lam, **{g: v})
                e = cross_validate(design, obs, trial)
                if e < best - 1e-5:
                    best, lam, improved = e, trial, True
                    if verbose:
                        print(f"  {g}={v}: cv-mse={e:.4f}")
        if not improved:
            break
    if verbose:
        print(f"  chosen penalties {lam}  (cv-mse {best:.4f})")
    lam["_cv_mse"] = best
    return lam


def fit_wet(obs: pd.DataFrame, pred: np.ndarray, penalty: float = 15.0):
    """Stage 2: wet race score = a * predicted pace + wet skill[driver] + noise."""
    m = (obs["wet"] & (obs["kind"] == "race")).to_numpy()
    w = obs[m]
    p = pred[m]
    codes, labels = pd.factorize(w["driver_ref"])
    n = len(w)
    X = sparse.hstack([sparse.csr_matrix(p.reshape(-1, 1) * 100.0),     # ~unpenalised slope
                       sparse.csr_matrix((np.ones(n) / np.sqrt(penalty), (np.arange(n), codes)),
                                         shape=(n, len(labels)))]).tocsr()
    c = lsqr(X, w["y"].to_numpy(), damp=1.0, atol=1e-10, btol=1e-10)[0]
    slope = c[0] * 100.0
    skill = pd.Series(c[1:] / np.sqrt(penalty), index=labels)
    return slope, skill, int(m.sum())


def _effects(design: Design, b: np.ndarray, group: str) -> pd.Series:
    a, z = design.groups[group]
    return pd.Series(b[a:z], index=design.index[group])


def calibrate(t: Tables, obs: Observations, pace: pd.DataFrame) -> dict:
    """% lap time per score unit, from 2014+ qualifying gaps."""
    fl = t.fastest_laps
    q = fl[fl["session_type"].isin(["Q1", "Q2", "Q3"]) & (fl["year"] >= CALIBRATION_FROM)]
    best = q.groupby(["round_id", "driver_id"], as_index=False)["seconds"].min()
    best["gap"] = (best["seconds"] / best.groupby("round_id")["seconds"].transform("min") - 1) * 100
    best = best[best["gap"] < 4.0]
    m = best.merge(pace, on=["round_id", "driver_id"], how="inner")
    m["gap_c"] = m["gap"] - m.groupby("round_id")["gap"].transform("mean")
    m["p_c"] = m["pace"] - m.groupby("round_id")["pace"].transform("mean")
    k = float((m["gap_c"] * m["p_c"]).sum() / (m["p_c"] ** 2).sum())
    resid = m["gap_c"] - k * m["p_c"]
    return {"pct_per_unit": -k, "quali_resid_sd_pct": float(resid.std()), "n": int(len(m)),
            "r2": float(1 - resid.var() / m["gap_c"].var())}


def fit(t: Tables | None = None, tune_penalties: bool = True, verbose: bool = True) -> dict:
    t0 = time.time()
    t = t or load_tables()
    o = build_observations(t)
    obs = o.df
    if verbose:
        print(f"{len(obs):,} observations from {obs['round_id'].nunique():,} Grands Prix "
              f"({obs['year'].min()}-{obs['year'].max()})")
    design = build_design(obs)
    lam = tune(design, obs, verbose) if tune_penalties else dict(DEFAULT_PENALTIES, _cv_mse=None)
    y = obs["y"].to_numpy()
    b = ridge(design, y, lam)
    pred = design.X @ b
    resid = y - pred

    drv = _effects(design, b, "driver")
    car = _effects(design, b, "car")
    aff = _effects(design, b, "affinity")
    team_era = _effects(design, b, "team_era")
    # a car's total rating = its own season term + its team's era term
    car = car + pd.Series([team_era.get(k.split("@")[0] + "|" + E.era_for_year(int(k.split("@")[1])).key, 0.0)
                           for k in car.index], index=car.index)
    age = _effects(design, b, "age")
    exp_ = _effects(design, b, "experience")
    entry = _effects(design, b, "entry")
    # every observation has exactly one age bin and one experience bin, so shift both curves so
    # their best bin is 0 and move the constant into driver skill (predictions are unchanged)
    shift = float(age.max() + exp_.max())
    age, exp_ = age - age.max(), exp_ - exp_.max()
    drv = drv + shift

    wet_slope, wet, wet_n = fit_wet(obs, pred)
    if verbose:
        print(f"  wet races: {wet_n} observations, pace slope {wet_slope:.2f}")

    # pace for calibration (the same terms the simulator uses, minus noise)
    s = o.starts
    s_age = pd.cut(s["age"], AGE_EDGES, labels=False, right=False)
    s_exp = pd.cut(s["career_start"], EXP_EDGES, labels=False, right=False)
    pace = (s["driver_ref"].map(drv).fillna(0)
            + s["car_key"].map(car).fillna(0)
            + (s["driver_ref"] + "|" + s["car_key"]).map(entry).fillna(0)
            + (s["driver_ref"] + "|" + s["era"]).map(aff).fillna(0)
            + s_age.map(dict(enumerate(age.values))).fillna(0)
            + s_exp.map(dict(enumerate(exp_.values))).fillna(0))
    cal = calibrate(t, o, pd.DataFrame({"round_id": s["round_id"], "driver_id": s["driver_id"],
                                        "pace": pace}))
    if verbose:
        print(f"  calibration: {cal['pct_per_unit']:.3f}% lap time per score unit "
              f"(R^2={cal['r2']:.2f}, n={cal['n']:,})")

    # ---- reliability (mechanical DNFs per start) and crash rates (accident DNFs per start)
    s["mech"] = (s["status"] == STATUS_MECHANICAL).astype(float)
    s["crash"] = (s["status"] == STATUS_ACCIDENT).astype(float)
    season_mech = s.groupby("year")["mech"].mean()
    season_crash = s.groupby("year")["crash"].mean()
    cs = s.groupby("car_key").agg(m=("mech", "sum"), n=("mech", "size"), year=("year", "first"))
    prior = 15.0
    cs["mech_rate"] = (cs["m"] + prior * cs["year"].map(season_mech)) / (cs["n"] + prior)
    s["exp_crash"] = s["year"].map(season_crash)
    dc = s.groupby("driver_ref").agg(c=("crash", "sum"), e=("exp_crash", "sum"))
    dc["crash_ratio"] = (dc["c"] + 4.0) / (dc["e"] + 4.0)
    modern = s[(s["year"] >= 2014) & (s["year"] <= 2025)]
    modern_mech = float(modern["mech"].mean())
    modern_crash = float(modern["crash"].mean())

    # residual noise in score units
    is_q = (obs["kind"] == "quali").to_numpy()
    meta = {
        "built": time.strftime("%Y-%m-%d"),
        "data_through": str(obs["date"].max().date()),
        "observations": int(len(obs)),
        "grands_prix": int(obs["round_id"].nunique()),
        "penalties": {k: v for k, v in lam.items() if not k.startswith("_")},
        "cv_mse": lam.get("_cv_mse"),
        "resid_sd_quali": float(resid[is_q].std()),
        "resid_sd_race": float(resid[~is_q].std()),
        "calibration": cal,
        "modern_mech_rate": modern_mech,
        "modern_crash_rate": modern_crash,
        "wet_pace_slope": wet_slope,
        "fit_seconds": round(time.time() - t0, 1),
    }

    # ---- package drivers
    starts_by_driver = s.groupby("driver_ref")
    era_counts = s.groupby(["driver_ref", "era"]).size()
    drivers_tbl = t.drivers.set_index("driver_ref")
    drivers = {}
    for ref, g in starts_by_driver:
        info = drivers_tbl.loc[ref]
        teams_by_year = (g.groupby(["year", "team_ref"]).size().reset_index(name="n")
                         .sort_values(["year", "n"], ascending=[True, False]))
        tby = {}
        for y, gg in teams_by_year.groupby("year"):
            tby[str(int(y))] = gg["team_ref"].tolist()
        eras_d = {}
        for era_key in E.ERA_KEYS:
            n = int(era_counts.get((ref, era_key), 0))
            if n:
                eras_d[era_key] = {"affinity": float(aff.get(f"{ref}|{era_key}", 0.0)), "starts": n}
        ages = pd.cut(g["age"], AGE_EDGES, labels=False, right=False).dropna().astype(int)
        code = info.get("abbreviation")
        if pd.isna(code) or not code:
            code = "".join(ch for ch in str(info["surname"]).upper() if ch.isalpha())[:3]
        drivers[ref] = {
            "name": info["full_name"],
            "code": code,
            "nationality": None if pd.isna(info.get("nationality")) else info.get("nationality"),
            "dob": None if pd.isna(info["date_of_birth"]) else str(info["date_of_birth"].date()),
            "skill": float(drv.get(ref, 0.0)),
            "wet": float(wet.get(ref, 0.0)),
            "wet_races": int(g["wet"].sum()),
            "crash_ratio": float(dc.loc[ref, "crash_ratio"]),
            "starts": int(len(g)),
            "wins": int(((g["position"] == 1) & (g["status"] == STATUS_FINISHED)).sum()),
            "podiums": int(((g["position"] <= 3) & g["status"].isin([0, 1])).sum()),
            "first_year": int(g["year"].min()),
            "last_year": int(g["year"].max()),
            "age_bins": sorted(set(ages.tolist())),
            "eras": eras_d,
            "teams_by_year": tby,
            "starts_by_year": {str(int(y)): int(c) for y, c in g.groupby("year").size().items()},
        }

    team_names = t.teams.set_index("team_ref")["team_name"].to_dict()
    car_drivers = s.groupby("car_key")["driver_ref"].agg(lambda x: x.value_counts().index.tolist())
    car_results = s.groupby("car_key").agg(
        wins=("position", lambda x: int((x == 1).sum())), starts=("position", "size"))
    entry_by_car = {}
    for k, v in entry.items():
        d, ck = k.split("|", 1)
        entry_by_car.setdefault(ck, {})[d] = round(float(v), 4)
    cars = {}
    for key, rating in car.items():
        team_ref, year = key.rsplit("@", 1)
        cars[key] = {
            "team": team_names.get(team_ref, team_ref), "team_ref": team_ref, "year": int(year),
            "rating": float(rating), "mech_rate": float(cs.loc[key, "mech_rate"]),
            "starts": int(car_results.loc[key, "starts"]), "wins": int(car_results.loc[key, "wins"]),
            "drivers": car_drivers.get(key, [])[:6],
            "entries": entry_by_car.get(key, {}),
        }
    # season-level spread of car ratings (for generating anonymous field cars)
    modern_cars = [c["rating"] for c in cars.values() if 2014 <= c["year"] <= 2025]
    active = [d for d in drivers.values() if d["last_year"] >= 2014 and d["starts"] >= 20]
    meta["field"] = {
        "car_mean": float(np.mean(modern_cars)), "car_sd": float(np.std(modern_cars)),
        "driver_mean": float(np.mean([d["skill"] for d in active])),
        "driver_sd": float(np.std([d["skill"] for d in active])),
    }
    model = {
        "meta": meta,
        "age_curve": {"edges": AGE_EDGES, "labels": AGE_LABELS, "effects": age.tolist()},
        "experience_curve": {"edges": EXP_EDGES, "labels": EXP_LABELS, "effects": exp_.tolist()},
        "eras": [{"key": e.key, "name": e.name, "start": e.start, "end": e.end, "blurb": e.blurb}
                 for e in E.ERAS],
        "era_similarity": np.round(E.similarity_matrix(), 4).tolist(),
        "drivers": drivers,
        "cars": cars,
    }
    return model


def main():
    model = fit()
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    RATINGS_JSON.write_text(json.dumps(model, separators=(",", ":"), ensure_ascii=False),
                            encoding="utf-8")
    print(f"wrote {RATINGS_JSON} ({RATINGS_JSON.stat().st_size / 1e6:.1f} MB) "
          f"in {model['meta']['fit_seconds']}s")


if __name__ == "__main__":
    main()
