import numpy as np
import pandas as pd
import pytest

from f1dpi import eras as E
from f1dpi import fit as F
from f1dpi.cli import main as cli_main
from f1dpi.engine import RaceSimulator, SimEntry, SimSettings
from f1dpi.model import load_model
from f1dpi.montecarlo import simulate
from f1dpi.tyres import DRY, optimise, wear_bucket


@pytest.fixture(scope="module")
def m():
    return load_model()


def make_entries(n=10, fast=None):
    out = []
    for i in range(n):
        out.append(SimEntry(key=f"c{i}", label=f"Car {i}", short=f"C{i}",
                            driver_units=0.0, car_units=0.0, mech_rate=0.05, is_user=i < 2))
    if fast is not None:
        out[fast].car_units = 1.5
    return out


TRACK = {"laps": 50, "base_lap": 90.0, "overtaking_rho": 0.78, "pit_loss": 21.0,
         "incident_rate": 1.0, "rain_chance": 0.1, "tyre_wear": 1.0, "street": False}


# ------------------------------------------------------------------ tyres
@pytest.mark.parametrize("wear", [0.6, 1.0, 1.6])
def test_plans_cover_distance_and_use_two_compounds(wear):
    for p in optimise(57, wear_bucket(wear), 21.0, ""):
        assert sum(n for _, n in p.stints) == 57
        assert len({c for c, _ in p.stints}) >= 2
        assert all(c in DRY for c, _ in p.stints)


def test_more_wear_means_more_stops():
    low = optimise(57, wear_bucket(0.6), 21.0, "")[0].stops
    high = optimise(57, wear_bucket(2.0), 21.0, "")[0].stops
    assert high > low


def test_two_compound_rule_waived_after_wet_tyres():
    plans = optimise(20, wear_bucket(1.0), 21.0, "*")
    assert any(len(p.stints) == 1 for p in plans)


# ------------------------------------------------------------------ engine
def test_race_is_a_valid_classification():
    sim = RaceSimulator(TRACK, make_entries(), 1.17, SimSettings(weather="dry"))
    res = sim.run(np.random.default_rng(1))
    pos = sorted(c.position for c in res.cars.values())
    assert pos == list(range(1, 11))
    for c in res.cars.values():
        if c.finished:
            assert c.laps == TRACK["laps"] and c.dnf_reason is None
        else:
            assert c.laps < TRACK["laps"] and c.dnf_reason


def test_same_seed_same_race():
    sim = RaceSimulator(TRACK, make_entries(), 1.17)
    a = sim.run(np.random.default_rng(7))
    b = sim.run(np.random.default_rng(7))
    assert a.order == b.order


def test_much_faster_car_usually_wins():
    sim = RaceSimulator(TRACK, make_entries(fast=5), 1.17,
                        SimSettings(weather="dry", incidents=False))
    rng = np.random.default_rng(3)
    wins = sum(sim.run(rng).order[0] == "c5" for _ in range(60))
    assert wins >= 50


def test_no_incidents_means_no_retirements():
    entries = make_entries()
    for e in entries:
        e.mech_rate = 0.0
    sim = RaceSimulator(TRACK, entries, 1.17, SimSettings(incidents=False))
    res = sim.run(np.random.default_rng(5))
    assert all(c.finished for c in res.cars.values())


def test_wet_race_uses_wet_tyres():
    sim = RaceSimulator(TRACK, make_entries(), 1.17, SimSettings(weather="wet"))
    res = sim.run(np.random.default_rng(11))
    assert res.weather == "wet"
    assert any(t in ("I", "W") for c in res.cars.values() for t in c.tyres)


def test_recorded_race_has_lap_chart():
    sim = RaceSimulator(TRACK, make_entries(), 1.17)
    res = sim.run(np.random.default_rng(2), record=True)
    assert all(len(v) == res.cars[k].laps or len(v) == TRACK["laps"] for k, v in res.positions.items())


# ------------------------------------------------------------------ eras
def test_era_lookup_and_similarity():
    assert E.era_for_year(1988).key == "1983"
    assert E.era_for_year(2026).key == "2026"
    S = E.similarity_matrix()
    assert np.allclose(np.diag(S), 1.0) and np.allclose(S, S.T)
    k = E.ERA_KEYS.index
    # ground-effect eras resemble each other more than the 1950s resemble 2022
    assert S[k("1977"), k("2022")] > S[k("1950"), k("2022")]


# ------------------------------------------------------------------ model fitting
def test_ridge_recovers_synthetic_driver_and_car_effects():
    """Simulate seasons with known driver skill and car pace, then check the fit finds them."""
    rng = np.random.default_rng(0)
    n_drivers, years = 40, range(2000, 2016)
    skill = rng.normal(0, 0.5, n_drivers)
    rows = []
    rid = 0
    for y in years:
        drivers = rng.permutation(n_drivers)[:20]
        car = rng.normal(0, 0.6, 10)
        for _ in range(15):
            rid += 1
            perf = np.array([skill[d] + car[i // 2] + rng.normal(0, 0.4) for i, d in enumerate(drivers)])
            rank = (-perf).argsort().argsort() + 1
            yv = F.normal_scores(pd.Series(rank), pd.Series([20] * 20))
            for i, d in enumerate(drivers):
                rows.append({"round_id": rid, "driver_ref": f"d{d}", "car_key": f"t{i // 2}@{y}",
                             "era": E.era_for_year(y).key, "age": 28.0, "career_start": 50,
                             "wet": False, "kind": "race", "y": yv[i]})
    obs = pd.DataFrame(rows)
    design = F.build_design(obs)
    b = F.ridge(design, obs["y"].to_numpy(), F.DEFAULT_PENALTIES)
    est = F._effects(design, b, "driver")
    true = pd.Series({f"d{i}": skill[i] for i in range(n_drivers)})
    corr = np.corrcoef(est[true.index], true)[0, 1]
    assert corr > 0.85


# ------------------------------------------------------------------ fitted model & lookups
def test_lookups(m):
    assert m.find_driver("Senna")[0] == "senna"
    assert m.find_driver("Michael Schumacher")[0] == "michael_schumacher"
    assert m.find_driver("Verstappen")[0] == "max_verstappen"
    assert m.find_track("Monaco") == "monaco"
    assert m.find_track("cota") == "americas"
    assert m.resolve_car("senna", 1988)[0] == "mclaren@1988"
    assert m.resolve_car("max_verstappen", 1965, "Lotus")[0].startswith("lotus")


def test_unseen_era_affinity_is_shrunk_estimate(m):
    d = m.drivers["max_verstappen"]
    seen = [a["affinity"] for a in d["eras"].values()]
    a, src = m.affinity("max_verstappen", "1977")
    assert "estimated" in src
    assert min(seen + [0]) - 1e-9 <= a <= max(seen + [0]) + 1e-9


def test_entry_breakdown_adds_up(m):
    b = m.entry("Hamilton", 2020)
    assert b.car_key == "mercedes@2020"
    assert abs(b.total - (b.skill + b.affinity + b.age_effect + b.experience_effect + b.car_units)) < 1e-9
    hyp = m.entry("Hamilton", 1988, "McLaren")
    assert "peak" in hyp.age_note
    real = m.entry("Hamilton", 2023)
    peak = m.entry("Hamilton", 2023, peak=True)
    assert "age 38" in real.age_note and peak.age_effect > real.age_effect


def test_teammate_head_to_head_is_sensible(m):
    bds = [m.entry("Max Verstappen", 2023), m.entry("Perez", 2023)]
    s = simulate(m, bds, "bahrain", n_sims=150, reliability="off", seed=1)
    a, b = s.keys if s.labels[s.keys[0]].startswith("Max") else s.keys[::-1]
    assert s.h2h[(a, b)] > 0.75


def test_real_season_field(m):
    s = simulate(m, [m.entry("Senna", 1988)], "monza", n_sims=20, field_year=2025, seed=1)
    assert s.field_size >= 15


def test_cli_smoke(capsys):
    cli_main(["simulate", "-e", "Senna:1988", "-e", "Prost:1988", "-t", "monaco", "-n", "30", "-q"])
    out = capsys.readouterr().out
    assert "Head-to-head" in out and "Monaco" in out
