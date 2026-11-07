"""Build a profile for every circuit raced since 1996 (when lap-time data begins).

Everything here is measured from the data except the street-circuit flag:

* laps            - scheduled race distance at the most recent Grand Prix there
* base_lap        - median race fastest lap over the last 3 races (current layout)
* pit_loss        - median pit-lane time (2011+) minus ~3 s for the distance a car would cover anyway
* overtaking      - how strongly grid order predicts finishing order (Spearman, 2010+). 1 = nobody passes
* stops_per_car   - average dry-race pit stops per finisher in the Pirelli era (2011+): a tyre-wear proxy
* incident_rate   - accident retirements per start (2000+) relative to the average circuit
* rain_chance     - share of races there that were wet (1985+, from the curated wet list)

Every estimate is shrunk toward the all-circuit average when a track has few races.
Run ``python -m f1dpi.tracks`` to rebuild ``model/tracks.json``.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from .dataset import STATUS_ACCIDENT, STATUS_FINISHED, STATUS_LAPPED, Tables, load_tables, race_starts
from .paths import MODEL_DIR, TRACKS_JSON
from .wet_races import WET_RACES

STREET_CIRCUITS = {"monaco", "marina_bay", "baku", "jeddah", "vegas", "valencia", "albert_park",
                   "villeneuve", "miami", "detroit", "phoenix", "adelaide", "long_beach", "dallas",
                   "madring"}
SEMI_STREET = {"albert_park", "villeneuve", "miami", "madring"}


def _shrink(value, n, prior_value, prior_n):
    return (value * n + prior_value * prior_n) / (n + prior_n)


def build(t: Tables | None = None) -> dict:
    t = t or load_tables()
    s = race_starts(t)
    wet = set(WET_RACES)
    rounds = t.rounds.copy()
    rounds["wet"] = [(y, n) in wet for y, n in zip(rounds["year"], rounds["race_name"])]
    race_sess = t.sessions[t.sessions["session_type"] == "R"][["round_id", "scheduled_laps"]]
    rounds = rounds.merge(race_sess, on="round_id", how="left")

    # race fastest lap per round
    fl = t.fastest_laps
    fl = fl[fl["session_type"] == "R"].groupby("round_id")["seconds"].min()
    if fl.empty or fl.index.nunique() < 300:
        laps = t.race_laps.merge(t.entries[["session_entry_id", "round_id"]], on="session_entry_id")
        fl = laps.groupby("round_id")["seconds"].min()
    rounds["fastest_lap"] = rounds["round_id"].map(fl)

    # pit-lane time per round (2011+)
    ps = t.pit_stops
    ps = ps[(ps["seconds"] > 12) & (ps["seconds"] < 45)]
    pit_med = ps.groupby("circuit_ref")["seconds"].median()
    pit_n = ps.groupby("circuit_ref")["round_id"].nunique()
    global_pit = float(ps["seconds"].median())

    # stops per finisher, dry races 2011+
    fin = s[s["status"].isin([STATUS_FINISHED, STATUS_LAPPED])]
    stops = ps.groupby(["round_id", "driver_id"]).size().rename("stops").reset_index()
    f2 = fin[fin["year"] >= 2011].merge(stops, on=["round_id", "driver_id"], how="left").fillna({"stops": 0})
    f2 = f2.merge(rounds[["round_id", "wet"]], on="round_id")
    f2 = f2[~f2["wet"]]
    spr = f2.groupby(["circuit_ref", "round_id"])["stops"].mean().reset_index()
    stops_c = spr.groupby("circuit_ref")["stops"].mean()
    stops_n = spr.groupby("circuit_ref").size()
    global_stops = float(spr["stops"].mean())

    # overtaking: Spearman(grid, finish) among finishers, 2010+
    g = fin[(fin["year"] >= 2010) & (fin["grid"] > 0)]
    def spearman(df):
        if len(df) < 6:
            return np.nan
        return df["grid"].rank().corr(df["position"].rank())
    sp = g.groupby(["circuit_ref", "round_id"]).apply(spearman, include_groups=False).dropna().reset_index(name="rho")
    rho_c = sp.groupby("circuit_ref")["rho"].mean()
    rho_n = sp.groupby("circuit_ref").size()
    global_rho = float(sp["rho"].mean())

    # incidents, 2000+
    inc = s[s["year"] >= 2000].assign(acc=lambda d: (d["status"] == STATUS_ACCIDENT).astype(float))
    inc_c = inc.groupby("circuit_ref")["acc"].mean()
    inc_n = inc.groupby("circuit_ref").size()
    global_inc = float(inc["acc"].mean())

    # rain, 1985+
    r85 = rounds[rounds["year"] >= 1985]
    rain_c = r85.groupby("circuit_ref")["wet"].mean()
    rain_n = r85.groupby("circuit_ref").size()
    global_rain = float(r85["wet"].mean())

    circuits = t.circuits.set_index("circuit_ref")
    out = {}
    for ref, rr in rounds[rounds["year"] >= 1996].groupby("circuit_ref"):
        rr = rr.sort_values("date")
        recent = rr.dropna(subset=["fastest_lap"]).tail(3)
        if recent.empty:
            continue
        last = rr.iloc[-1]
        laps = int(last["scheduled_laps"]) if pd.notna(last["scheduled_laps"]) else None
        if laps is None:
            w = s[(s["round_id"] == last["round_id"]) & (s["position"] == 1)]
            laps = int(w["laps_completed"].iloc[0]) if len(w) else 60
        base_lap = float(recent["fastest_lap"].median())
        pit = _shrink(float(pit_med.get(ref, global_pit)), int(pit_n.get(ref, 0)), global_pit, 2) - 3.0
        rho = _shrink(float(rho_c.get(ref, global_rho)), int(rho_n.get(ref, 0)), global_rho, 3)
        stops_ = _shrink(float(stops_c.get(ref, global_stops)), int(stops_n.get(ref, 0)), global_stops, 3)
        incr = _shrink(float(inc_c.get(ref, global_inc)), int(inc_n.get(ref, 0)), global_inc, 60) / global_inc
        rain = _shrink(float(rain_c.get(ref, global_rain)), int(rain_n.get(ref, 0)), global_rain, 8)
        c = circuits.loc[ref]
        out[ref] = {
            "name": c["circuit_name"], "locality": c["locality"], "country": c["country"],
            "grand_prix": last["race_name"], "last_year": int(last["year"]),
            "races": int(len(rounds[rounds["circuit_ref"] == ref])),
            "laps": laps, "base_lap": round(base_lap, 3), "pit_loss": round(pit, 2),
            "overtaking_rho": round(rho, 3), "stops_per_car": round(stops_, 3),
            "tyre_wear": round(stops_ / global_stops, 3),
            "incident_rate": round(incr, 3), "rain_chance": round(rain, 3),
            "street": ref in STREET_CIRCUITS, "semi_street": ref in SEMI_STREET,
        }
    meta = {"global_pit": global_pit, "global_rho": global_rho, "global_stops": global_stops,
            "global_incident": global_inc, "global_rain": global_rain}
    return {"meta": meta, "tracks": out}


def main():
    data = build()
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    TRACKS_JSON.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {TRACKS_JSON}: {len(data['tracks'])} circuits")


if __name__ == "__main__":
    main()
