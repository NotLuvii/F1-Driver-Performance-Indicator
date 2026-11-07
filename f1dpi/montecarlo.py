"""Run many simulated races and summarise who wins, by how much, and why."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .engine import RaceResult, RaceSimulator, SimSettings
from .model import EntryBreakdown, Model


@dataclass
class Summary:
    track: dict
    track_ref: str
    n_sims: int
    rows: list            # per user entry: stats dict, sorted by win share of the user battle
    h2h: dict             # (key_a, key_b) -> P(a finishes ahead of b)
    keys: list            # user entry keys in display order
    labels: dict          # key -> label
    position_counts: dict # key -> np.array of finishing-position counts (index 0 = P1)
    weather_share: dict
    sc_share: float
    vsc_share: float
    breakdowns: list
    sample: RaceResult
    field_size: int


def simulate(model: Model, breakdowns: list[EntryBreakdown], track_ref: str, n_sims: int = 1000,
             settings: SimSettings | None = None, field_size: int = 20, field_year: int | None = None,
             reliability: str = "era", seed: int = 2026, progress=None) -> Summary:
    settings = settings or SimSettings()
    track = model.tracks[track_ref]
    users = model.sim_entries(breakdowns, reliability)
    n_field = max(0, field_size - len(users))
    field = model.field_entries(n_field, seed=seed, year=field_year,
                                exclude={b.driver_ref for b in breakdowns}, reliability=reliability)
    entries = users + field
    sim = RaceSimulator(track, entries, model.pct_per_unit, settings)
    rng = np.random.default_rng(seed)
    n_cars = len(entries)
    keys = [e.key for e in users]
    labels = {e.key: e.label for e in entries}

    pos = {k: np.zeros(n_sims, int) for k in keys}
    dnf = {k: np.zeros(n_sims, bool) for k in keys}
    stops = {k: np.zeros(n_sims, int) for k in keys}
    grid = {k: np.zeros(n_sims, int) for k in keys}
    led = {k: np.zeros(n_sims, int) for k in keys}
    weather = {"dry": 0, "wet": 0, "mixed": 0}
    sc = vsc = 0
    for r in range(n_sims):
        res = sim.run(rng)
        weather[res.weather] += 1
        sc += res.safety_cars > 0
        vsc += res.vscs > 0
        for k in keys:
            c = res.cars[k]
            pos[k][r] = c.position
            dnf[k][r] = not c.finished
            stops[k][r] = c.stops
            grid[k][r] = c.grid
            led[k][r] = c.laps_led
        if progress and (r % 25 == 0 or r == n_sims - 1):
            progress((r + 1) / n_sims)

    # user-only ranking: who is the best-placed of the chosen drivers
    P = np.vstack([pos[k] for k in keys])            # entries x sims
    best_user = np.argmin(P, axis=0)
    rows = []
    for i, k in enumerate(keys):
        p = pos[k]
        rows.append({
            "key": k, "label": labels[k],
            "beats_all": float(np.mean(best_user == i)),
            "win": float(np.mean(p == 1)), "podium": float(np.mean(p <= 3)),
            "points": float(np.mean(p <= 10)),
            "avg_pos": float(p.mean()), "median_pos": float(np.median(p)),
            "avg_grid": float(grid[k].mean()), "pole": float(np.mean(grid[k] == 1)),
            "dnf": float(dnf[k].mean()), "avg_stops": float(stops[k][~dnf[k]].mean()) if (~dnf[k]).any() else 0.0,
            "laps_led": float(led[k].mean()),
        })
    h2h = {}
    for i, a in enumerate(keys):
        for j, b in enumerate(keys):
            if i != j:
                h2h[(a, b)] = float(np.mean(P[i] < P[j]))
    counts = {k: np.bincount(pos[k] - 1, minlength=n_cars) for k in keys}
    order = sorted(range(len(rows)), key=lambda i: (-rows[i]["beats_all"], rows[i]["avg_pos"]))
    rows = [rows[i] for i in order]
    sample = sim.run(np.random.default_rng(seed + 1), record=True)
    return Summary(track=track, track_ref=track_ref, n_sims=n_sims, rows=rows, h2h=h2h,
                   keys=[r["key"] for r in rows], labels=labels, position_counts=counts,
                   weather_share={k: v / n_sims for k, v in weather.items()},
                   sc_share=sc / n_sims, vsc_share=vsc / n_sims, breakdowns=breakdowns,
                   sample=sample, field_size=n_cars)
