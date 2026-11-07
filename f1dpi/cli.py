"""Command-line interface.

Examples
--------
    python -m f1dpi simulate -e "Senna:1988" -e "Max Verstappen:2023" -e "Hamilton:2020" -t silverstone
    python -m f1dpi simulate -e "Alonso:2006" -e "Leclerc:2006:Renault" -t monaco --weather wet
    python -m f1dpi simulate -e Senna -e Schumacher -e Verstappen --same-car "Red Bull 2023" -t suzuka
    python -m f1dpi driver "Jim Clark"
    python -m f1dpi cars 1988
    python -m f1dpi tracks
    python -m f1dpi build            # refit ratings + tracks from data/raw/jolpica-f1-csv.zip
"""
from __future__ import annotations

import argparse
import json
import sys

from .engine import SimSettings
from .model import load_model
from .montecarlo import Summary, simulate


def _pct(x: float) -> str:
    return f"{100 * x:5.1f}%"


def _table(rows: list[list], headers: list[str]) -> str:
    cols = list(zip(*([headers] + [[str(c) for c in r] for r in rows])))
    widths = [max(len(c) for c in col) for col in cols]
    line = lambda r: "  ".join(str(c).ljust(w) if i == 0 else str(c).rjust(w) for i, (c, w) in enumerate(zip(r, widths)))
    return "\n".join([line(headers), "  ".join("-" * w for w in widths)] + [line(r) for r in rows])


def parse_entry(text: str, default_year: int | None):
    parts = [p.strip() for p in text.split(":")]
    name = parts[0]
    year = int(parts[1]) if len(parts) > 1 and parts[1] else default_year
    team = parts[2] if len(parts) > 2 and parts[2] else None
    return name, year, team


def print_summary(s: Summary, model, show_breakdown=True, show_sample=True):
    t = s.track
    print(f"\n{t['grand_prix']} · {t['name']} · {t['laps']} laps · {s.n_sims:,} simulations "
          f"· {s.field_size} cars")
    w = s.weather_share
    print(f"Conditions: dry {_pct(w['dry'])}, wet start {_pct(w['wet'])}, rain mid-race {_pct(w['mixed'])}"
          f" · safety car in {_pct(s.sc_share)} of races, VSC in {_pct(s.vsc_share)}\n")
    rows = []
    for r in s.rows:
        rows.append([r["label"], _pct(r["beats_all"]), _pct(r["win"]), _pct(r["podium"]),
                     f"{r['avg_grid']:.1f}", f"{r['avg_pos']:.1f}", _pct(r["dnf"]),
                     f"{r['avg_stops']:.1f}"])
    print(_table(rows, ["Entry", "Best of picks", "Win", "Podium", "Avg grid", "Avg finish",
                        "DNF", "Stops"]))
    if len(s.keys) > 1:
        print("\nHead-to-head (row finishes ahead of column):")
        short = {k: s.labels[k].split(" · ")[0].split()[-1] for k in s.keys}
        hrows = [[short[a]] + [("—" if a == b else _pct(s.h2h[(a, b)])) for b in s.keys] for a in s.keys]
        print(_table(hrows, [""] + [short[k] for k in s.keys]))
    if show_breakdown:
        print("\nWhere the pace comes from (score units; +1.0 ≈ "
              f"{model.pct_per_unit:.2f}% of lap time):")
        brows = []
        for b in s.breakdowns:
            brows.append([b.label, f"{b.skill:+.2f}", f"{b.affinity:+.2f}", f"{b.age_effect + b.experience_effect:+.2f}",
                          f"{b.car_units:+.2f}", f"{b.total:+.2f}", f"{b.wet:+.2f}"])
        print(_table(brows, ["Entry", "Driver", "Era fit", "Age/exp", "Car", "Total", "Wet"]))
        for b in s.breakdowns:
            print(f"  · {b.driver_name}: era fit for {b.era_name} {b.affinity:+.2f} ({b.affinity_source}); "
                  f"{b.age_note}")
            for n in b.notes:
                print(f"    note: {n}")
    if show_sample:
        smp = s.sample
        print(f"\nOne simulated race ({smp.weather}):")
        for lap, text in smp.events[:30]:
            print(f"  {'Quali ' if lap == 0 else f'Lap {lap:>2}'}: {text}")
        if len(smp.events) > 30:
            print(f"  … {len(smp.events) - 30} more events")
        print("  Result: " + ", ".join(
            f"P{smp.cars[k].position} {s.labels[k].split(' · ')[0]}" +
            ("" if smp.cars[k].finished else f" (DNF {smp.cars[k].dnf_reason})")
            for k in sorted(s.keys, key=lambda k: smp.cars[k].position)))


def cmd_simulate(a):
    m = load_model()
    same_car = None
    if a.same_car:
        name, _, yr = a.same_car.rpartition(" ")
        if not yr.isdigit():
            sys.exit("--same-car needs a team and year, e.g. --same-car \"Red Bull 2023\"")
        refs = m.find_team(name)
        keys = [f"{r}@{yr}" for r in refs if f"{r}@{yr}" in m.cars]
        if not keys:
            sys.exit(f"No {name} car in {yr}.")
        same_car = keys[0]
    bds = []
    for e in a.entry:
        name, year, team = parse_entry(e, a.year)
        if year is None and not same_car:
            sys.exit(f"Give a year for {name}, e.g. -e \"{name}:1990\"")
        try:
            bds.append(m.entry(name, year or m.cars[same_car]["year"], team, same_car=same_car,
                               peak=a.peak))
        except LookupError as err:
            sys.exit(str(err))
    try:
        track = m.find_track(a.track)
    except LookupError as err:
        sys.exit(str(err))
    settings = SimSettings(weather=a.weather, safety_car=not a.no_safety_car, laps=a.laps)
    s = simulate(m, bds, track, n_sims=a.sims, settings=settings, field_size=a.field_size,
                 field_year=a.field_year, reliability=a.reliability, seed=a.seed)
    if a.json:
        out = {"track": s.track, "rows": s.rows,
               "h2h": {f"{x}>{y}": v for (x, y), v in s.h2h.items()},
               "weather_share": s.weather_share, "sc_share": s.sc_share, "vsc_share": s.vsc_share,
               "breakdowns": [b.as_dict(m.pct_per_unit) for b in bds],
               "sample_events": s.sample.events}
        print(json.dumps(out, indent=2, ensure_ascii=False))
    else:
        print_summary(s, m, show_sample=not a.quiet)


def cmd_driver(a):
    m = load_model()
    ref, notes = m.find_driver(a.name)
    d = m.drivers[ref]
    for n in notes:
        print("note:", n)
    print(f"\n{d['name']} ({d.get('nationality') or '?'}) · {d['first_year']}-{d['last_year']} · "
          f"{d['starts']} starts, {d['wins']} wins, {d['podiums']} podiums")
    rank = sorted((x for x in m.drivers.values() if x["starts"] >= 30), key=lambda x: -x["skill"])
    pos = next((i + 1 for i, x in enumerate(rank) if x is d), None)
    print(f"Peak skill {d['skill']:+.2f}" + (f" (#{pos} of {len(rank)} drivers with 30+ starts)" if pos else "")
          + f" · wet {d['wet']:+.2f} over {d['wet_races']} wet races · crash-proneness x{d['crash_ratio']:.2f}")
    print("\nEra fit (+ = drove these cars better than their career average):")
    from .eras import ERAS
    rows = []
    for e in ERAS:
        aff, src = m.affinity(ref, e.key)
        rows.append([f"{e.name} ({e.start}-{min(e.end, 2026)})", f"{aff:+.3f}", src])
    print(_table(rows, ["Era", "Affinity", "Source"]))
    print("\nTeams by year: " + ", ".join(f"{y}: {'/'.join(t)}" for y, t in d["teams_by_year"].items()))


def cmd_cars(a):
    m = load_model()
    keys = m.cars_in_year(a.year)
    rows = [[m.cars[k]["team"], f"{m.cars[k]['rating']:+.2f}", m.cars[k]["wins"],
             _pct(m.cars[k]["mech_rate"]), ", ".join(m.drivers[d]["name"] for d in m.cars[k]["drivers"][:4])]
            for k in keys]
    print(_table(rows, ["Team", "Car rating", "Wins", "Mech DNF/race", "Drivers"]))


def cmd_tracks(a):
    m = load_model()
    rows = [[ref, t["grand_prix"], t["laps"], f"{t['base_lap']:.1f}s", f"{t['pit_loss']:.1f}s",
             f"{t['overtaking_rho']:.2f}", f"{t['tyre_wear']:.2f}", f"{t['incident_rate']:.2f}",
             _pct(t["rain_chance"])]
            for ref, t in sorted(m.tracks.items(), key=lambda x: (-x[1]["last_year"], x[0]))]
    print(_table(rows, ["Key", "Grand Prix", "Laps", "Lap", "Pit loss", "Grid→finish ρ",
                        "Tyre wear", "Incidents", "Rain"]))


def cmd_build(a):
    from . import fit, tracks
    fit.main()
    tracks.main()


def main(argv=None):
    try:  # Windows consoles/redirects default to cp1252; our output has ·, ≈ and →
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    p = argparse.ArgumentParser(prog="f1dpi", description="F1 Driver Performance Indicator")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("simulate", help="simulate a race")
    s.add_argument("-e", "--entry", action="append", required=True,
                   help='"Driver[:year[:team]]", e.g. "Senna:1988" or "Hamilton:1988:McLaren"')
    s.add_argument("-t", "--track", required=True, help="circuit, e.g. monza, spa, 'Monaco', 'Suzuka'")
    s.add_argument("-y", "--year", type=int, help="default car year for entries without one")
    s.add_argument("-n", "--sims", type=int, default=1000)
    s.add_argument("--weather", choices=["random", "dry", "wet", "mixed"], default="random")
    s.add_argument("--reliability", choices=["modern", "era", "off"], default="modern",
                   help="mechanical failure rates: modern (same for all), era (that car's real rate), off")
    s.add_argument("--same-car", help='put everyone in one car, e.g. "Red Bull 2023"')
    s.add_argument("--peak", action="store_true",
                   help="use every driver at their peak age, not their real age in that season")
    s.add_argument("--field-size", type=int, default=20, help="fill the grid up to this many cars")
    s.add_argument("--field-year", type=int, help="fill the grid with that season's real drivers and cars")
    s.add_argument("--no-safety-car", action="store_true")
    s.add_argument("--laps", type=int)
    s.add_argument("--seed", type=int, default=2026)
    s.add_argument("--json", action="store_true", help="machine-readable output")
    s.add_argument("-q", "--quiet", action="store_true", help="skip the sample race narrative")
    s.set_defaults(func=cmd_simulate)

    d = sub.add_parser("driver", help="show a driver's ratings")
    d.add_argument("name")
    d.set_defaults(func=cmd_driver)
    c = sub.add_parser("cars", help="list a season's cars by rating")
    c.add_argument("year", type=int)
    c.set_defaults(func=cmd_cars)
    t = sub.add_parser("tracks", help="list circuits")
    t.set_defaults(func=cmd_tracks)
    b = sub.add_parser("build", help="refit the model from the raw data")
    b.set_defaults(func=cmd_build)
    a = p.parse_args(argv)
    a.func(a)


if __name__ == "__main__":
    main()
