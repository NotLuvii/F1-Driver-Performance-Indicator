"""Load the Jolpica (Ergast successor) CSV dump and turn it into tidy tables.

The dump is a zip of Django tables (``formula_one_*.csv``).  The tables we use:

* round        – one row per Grand Prix weekend (name, date, circuit, season)
* session      – sessions within a round (``R`` = race, ``Q1``..``Q3``/``QB``/``QA`` = qualifying)
* sessionentry – one row per car per session (grid, position, status, laps, time)
* roundentry   – links a round to a team-driver pairing
* teamdriver   – driver + team + season
* lap / pitstop – lap times (1996+) and pit stops (2011+)

Everything downstream works off :func:`load_tables`, which returns plain pandas
DataFrames with friendly column names.
"""
from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path

import numpy as np
import pandas as pd

from .paths import RAW_ZIP

# sessionentry.status codes used by Jolpica
STATUS_FINISHED = 0
STATUS_LAPPED = 1
STATUS_ACCIDENT = 10      # accident / collision / spun off  (driver-involved incident)
STATUS_MECHANICAL = 11    # engine, gearbox, hydraulics ...
STATUS_DSQ = 20
STATUS_DNS = 30           # withdrew / did not start
STATUS_DNQ = 40

QUALI_TYPES = ("Q1", "Q2", "Q3", "QB", "QA", "QO")
EXCLUDED_ROUNDS = ("Indianapolis 500",)  # counted for the WDC 1950-60 but a different series


def _time_to_seconds(s: pd.Series) -> pd.Series:
    """'01:23.456' / '00:01:23.456' / '1:23:45.6' -> seconds (float)."""
    s = s.astype("string")
    parts = s.str.split(":", expand=True)
    out = pd.Series(np.nan, index=s.index, dtype="float64")
    if parts.shape[1] == 3:
        ok = parts[2].notna()
        out[ok] = (parts.loc[ok, 0].astype(float) * 3600
                   + parts.loc[ok, 1].astype(float) * 60
                   + parts.loc[ok, 2].astype(float))
        two = parts[2].isna() & parts[1].notna()
        out[two] = parts.loc[two, 0].astype(float) * 60 + parts.loc[two, 1].astype(float)
    elif parts.shape[1] == 2:
        ok = parts[1].notna()
        out[ok] = parts.loc[ok, 0].astype(float) * 60 + parts.loc[ok, 1].astype(float)
    return out


@dataclass
class Tables:
    rounds: pd.DataFrame
    sessions: pd.DataFrame
    entries: pd.DataFrame      # session entries enriched with driver/team/round info
    drivers: pd.DataFrame
    teams: pd.DataFrame
    circuits: pd.DataFrame
    _zip_path: Path

    def _read(self, name: str, **kw) -> pd.DataFrame:
        with zipfile.ZipFile(self._zip_path) as z:
            with z.open(f"formula_one_{name}.csv") as f:
                return pd.read_csv(io.BytesIO(f.read()), low_memory=False, **kw)

    @cached_property
    def race_laps(self) -> pd.DataFrame:
        """Per-lap race times (1996+): session_entry_id, lap, position, seconds."""
        lap = self._read("lap", usecols=["number", "position", "session_entry_id", "time",
                                         "is_entry_fastest_lap", "is_deleted"])
        lap = lap[lap["number"].notna()]
        race_entries = self.entries[self.entries["session_type"] == "R"]
        lap = lap[lap["session_entry_id"].isin(race_entries["session_entry_id"])]
        lap = lap.rename(columns={"number": "lap"})
        lap["seconds"] = _time_to_seconds(lap["time"])
        return lap[["session_entry_id", "lap", "position", "seconds"]].reset_index(drop=True)

    @cached_property
    def fastest_laps(self) -> pd.DataFrame:
        """Each entry's fastest lap per session (used for qualifying times + race fastest laps)."""
        lap = self._read("lap", usecols=["session_entry_id", "time", "is_entry_fastest_lap"])
        lap = lap[lap["is_entry_fastest_lap"] == "t"].copy()
        lap["seconds"] = _time_to_seconds(lap["time"])
        lap = lap.groupby("session_entry_id", as_index=False)["seconds"].min()
        return lap.merge(self.entries, on="session_entry_id", how="inner")

    @cached_property
    def pit_stops(self) -> pd.DataFrame:
        ps = self._read("pitstop", usecols=["duration", "number", "session_entry_id"])
        ps["seconds"] = _time_to_seconds(ps["duration"])
        return ps.merge(self.entries[["session_entry_id", "round_id", "year", "circuit_ref",
                                      "driver_id"]], on="session_entry_id", how="inner")


def load_tables(zip_path: Path | str = RAW_ZIP) -> Tables:
    zip_path = Path(zip_path)
    if not zip_path.exists():
        raise FileNotFoundError(
            f"{zip_path} not found. Run `python -m f1dpi.download` to fetch the Jolpica dump.")
    with zipfile.ZipFile(zip_path) as z:
        def read(name, **kw):
            with z.open(f"formula_one_{name}.csv") as f:
                return pd.read_csv(io.BytesIO(f.read()), low_memory=False, **kw)

        season = read("season")[["id", "year"]].rename(columns={"id": "season_id"})
        circuit = read("circuit").rename(columns={"id": "circuit_id", "reference": "circuit_ref",
                                                  "name": "circuit_name"})
        rnd = read("round").rename(columns={"id": "round_id", "name": "race_name",
                                            "number": "round_number"})
        rnd = rnd[rnd["is_cancelled"] != "t"]
        rnd = rnd[~rnd["race_name"].isin(EXCLUDED_ROUNDS)]
        rnd = rnd.merge(season, on="season_id").merge(
            circuit[["circuit_id", "circuit_ref", "circuit_name", "locality", "country"]],
            on="circuit_id")
        rnd["date"] = pd.to_datetime(rnd["date"])

        sess = read("session").rename(columns={"id": "session_id", "type": "session_type",
                                               "number": "session_number"})
        sess = sess.merge(rnd[["round_id"]], on="round_id")

        driver = read("driver").rename(columns={"id": "driver_id", "reference": "driver_ref"})
        driver["date_of_birth"] = pd.to_datetime(driver["date_of_birth"], errors="coerce")
        driver["full_name"] = (driver["forename"].fillna("") + " " + driver["surname"].fillna("")).str.strip()

        team = read("team").rename(columns={"id": "team_id", "reference": "team_ref",
                                            "name": "team_name"})
        td = read("teamdriver").rename(columns={"id": "team_driver_id"})[
            ["team_driver_id", "driver_id", "team_id", "season_id"]]
        re_ = read("roundentry").rename(columns={"id": "round_entry_id"})[
            ["round_entry_id", "round_id", "team_driver_id", "car_number"]]
        se = read("sessionentry").rename(columns={"id": "session_entry_id"})

    se = se.merge(sess[["session_id", "round_id", "session_type", "scheduled_laps"]],
                  on="session_id", how="inner")
    se = se.merge(re_.drop(columns="round_id"), on="round_entry_id", how="inner")
    se = se.merge(td.drop(columns="season_id"), on="team_driver_id", how="inner")
    se = se.merge(rnd[["round_id", "year", "round_number", "race_name", "date", "circuit_id",
                       "circuit_ref"]], on="round_id", how="inner")
    se = se.merge(driver[["driver_id", "driver_ref", "full_name", "date_of_birth"]],
                  on="driver_id", how="left")
    se = se.merge(team[["team_id", "team_ref", "team_name"]], on="team_id", how="left")
    se["age"] = (se["date"] - se["date_of_birth"]).dt.days / 365.25
    se["race_seconds"] = _time_to_seconds(se["time"])
    keep = ["session_entry_id", "session_id", "session_type", "round_id", "year", "round_number",
            "race_name", "date", "circuit_id", "circuit_ref", "scheduled_laps", "driver_id",
            "driver_ref", "full_name", "age", "team_id", "team_ref", "team_name", "car_number",
            "grid", "position", "is_classified", "status", "detail", "laps_completed", "points",
            "race_seconds"]
    entries = se[keep].copy()
    return Tables(rounds=rnd.reset_index(drop=True), sessions=sess.reset_index(drop=True),
                  entries=entries.reset_index(drop=True), drivers=driver, teams=team,
                  circuits=circuit, _zip_path=zip_path)


def race_starts(t: Tables) -> pd.DataFrame:
    """One row per car that actually started a Grand Prix (DNS / DNQ removed)."""
    r = t.entries[t.entries["session_type"] == "R"].copy()
    r = r[~r["status"].isin([STATUS_DNS, STATUS_DNQ])]
    r = r[r["laps_completed"].fillna(0) > 0]
    # a driver can appear twice in early-era races (shared cars): keep their best result
    r = r.sort_values(["round_id", "driver_id", "position"]).drop_duplicates(["round_id", "driver_id"])
    return r.reset_index(drop=True)


def qualifying_order(t: Tables) -> pd.DataFrame:
    """Overall qualifying classification per round (rank 1 = pole).

    1994+ uses the qualifying sessions themselves (knock-out stages ranked by the stage reached,
    then position within it). Before 1994 the dump has no qualifying sessions, so the race grid
    is used instead.
    """
    e = t.entries
    q = e[e["session_type"].isin(QUALI_TYPES) & e["position"].notna()].copy()
    stage = {"Q3": 3, "Q2": 2, "Q1": 1, "QB": 1, "QA": 1, "QO": 1}
    q["stage"] = q["session_type"].map(stage)
    q = q.sort_values(["round_id", "driver_id", "stage"], ascending=[True, True, False])
    q = q.drop_duplicates(["round_id", "driver_id"])  # keep the furthest stage reached
    q = q.sort_values(["round_id", "stage", "position"], ascending=[True, False, True])
    q["quali_rank"] = q.groupby("round_id").cumcount() + 1
    q = q[["round_id", "driver_id", "quali_rank"]]

    starts = race_starts(t)
    has_q = set(q["round_id"].unique())
    g = starts[~starts["round_id"].isin(has_q) & (starts["grid"] > 0)][["round_id", "driver_id", "grid"]]
    g = g.sort_values(["round_id", "grid"])
    g["quali_rank"] = g.groupby("round_id").cumcount() + 1
    return pd.concat([q, g[["round_id", "driver_id", "quali_rank"]]], ignore_index=True)
