"""Streamlit front end:  streamlit run app.py"""
from __future__ import annotations

import altair as alt
import pandas as pd
import streamlit as st

from f1dpi.engine import SimSettings
from f1dpi.eras import ERAS
from f1dpi.model import PALETTE, load_model
from f1dpi.montecarlo import simulate

st.set_page_config(page_title="F1 Driver Performance Indicator", page_icon="🏁", layout="wide")


@st.cache_resource
def model():
    return load_model()


m = model()
MAX_ENTRIES = len(PALETTE)

# ---------------------------------------------------------------- option lists
drivers_sorted = sorted(m.drivers.items(), key=lambda kv: -kv[1]["starts"])
driver_refs = [r for r, d in drivers_sorted if d["starts"] >= 5]
driver_label = {r: f"{m.drivers[r]['name']} ({m.drivers[r]['first_year']}–{m.drivers[r]['last_year']})"
                for r in driver_refs}
years = sorted({c["year"] for c in m.cars.values()}, reverse=True)
tracks_sorted = sorted(m.tracks.items(), key=lambda kv: (-kv[1]["last_year"], kv[1]["grand_prix"]))
track_label = {r: f"{t['grand_prix']} · {t['name']}" + ("" if t["last_year"] >= 2025 else f" (last held {t['last_year']})")
               for r, t in tracks_sorted}


def best_year(ref: str) -> int:
    d = m.drivers[ref]
    best = max(d["teams_by_year"].items(),
               key=lambda kv: m.cars.get(f"{kv[1][0]}@{kv[0]}", {"rating": -9})["rating"])
    return int(best[0])


DEFAULTS = [("senna", 1988), ("max_verstappen", 2023), ("hamilton", 2020), ("michael_schumacher", 2004)]

st.title("🏁 F1 Driver Performance Indicator")
st.caption("Put any drivers in any F1 cars on any circuit and simulate the race, with safety cars, "
           "rain, tyre wear, crashes and each driver's fit with that generation of car. "
           f"Ratings come from {m.meta['grands_prix']:,} Grands Prix ({m.meta['data_through'][:4]} season included).")

# ---------------------------------------------------------------- sidebar
with st.sidebar:
    st.header("Race")
    track = st.selectbox("Circuit", list(track_label), format_func=track_label.get,
                         index=list(track_label).index("silverstone"))
    t = m.tracks[track]
    st.caption(f"{t['laps']} laps · fastest lap ≈ {t['base_lap']:.1f}s · pit loss {t['pit_loss']:.1f}s · "
               f"rain in {t['rain_chance']:.0%} of races here")
    weather = st.selectbox("Weather", ["random", "dry", "wet", "mixed"],
                           format_func={"random": "Random (this circuit's odds)", "dry": "Dry",
                                        "wet": "Wet start", "mixed": "Rain arrives mid-race"}.get)
    reliability = st.selectbox("Reliability", ["modern", "era", "off"],
                               format_func={"modern": "Modern (same for everyone)",
                                            "era": "Each car's real reliability",
                                            "off": "No mechanical failures"}.get)
    safety_car = st.toggle("Safety cars", value=True)
    sims = st.select_slider("Simulations", [100, 250, 500, 1000, 2000, 5000], value=1000)
    st.header("Rest of the grid")
    field_mode = st.radio("Fill the grid with", ["Generic midfield cars", "A real season's grid", "Nobody"])
    field_year = None
    field_size = 20
    if field_mode == "A real season's grid":
        field_year = st.selectbox("Season", years, index=years.index(2025) if 2025 in years else 0)
    elif field_mode == "Nobody":
        field_size = 0
    seed = st.number_input("Random seed", value=2026, step=1)

# ---------------------------------------------------------------- entries
st.subheader("Drivers and cars")
same = st.toggle("Put everyone in the same car (pure driver comparison)")
same_car = None
if same:
    c1, c2 = st.columns(2)
    sy = c1.selectbox("Car year", years, index=years.index(2023))
    keys = m.cars_in_year(sy)
    same_car = c2.selectbox("Team", keys, format_func=lambda k: f"{m.cars[k]['team']} (rating {m.cars[k]['rating']:+.2f})")

peak = st.toggle("Use every driver at their peak age", value=same,
                 help="Off: a driver in a season they actually raced gets their real age and experience "
                      "that year (Hamilton in 2023 is 38). On: everyone is at their best age.")
n = st.number_input("How many drivers?", min_value=1, max_value=MAX_ENTRIES, value=4)
picks = []
for i in range(int(n)):
    dref0, y0 = DEFAULTS[i] if i < len(DEFAULTS) else (driver_refs[i], None)
    cols = st.columns([3, 1.2, 2.4] if not same else [3, 3.6])
    dref = cols[0].selectbox(f"Driver {i + 1}", driver_refs, index=driver_refs.index(dref0),
                             format_func=driver_label.get, key=f"d{i}")
    if same:
        picks.append((dref, m.cars[same_car]["year"], None))
        continue
    y_default = y0 if (y0 and dref == dref0) else best_year(dref)
    year = cols[1].selectbox("Car year", years, index=years.index(y_default), key=f"y{i}_{dref}")
    teams = m.cars_in_year(year)
    own = m.drivers[dref]["teams_by_year"].get(str(year), [])
    default_key = f"{own[0]}@{year}" if own and f"{own[0]}@{year}" in teams else teams[0]
    car_key = cols[2].selectbox("Car", teams, index=teams.index(default_key), key=f"c{i}_{dref}_{year}",
                                format_func=lambda k, own=tuple(own): f"{m.cars[k]['team']} {m.cars[k]['year']}  ·  rating {m.cars[k]['rating']:+.2f}"
                                + ("  (their car)" if k.split('@')[0] in own else ""))
    picks.append((dref, year, car_key))

run = st.button("Simulate race", type="primary", width="stretch")

if run:
    bds = []
    for dref, year, car_key in picks:
        bds.append(m.entry(dref, year, same_car=same_car or car_key, peak=peak))
    settings = SimSettings(weather=weather, safety_car=safety_car)
    bar = st.progress(0.0, text="Racing…")
    s = simulate(m, bds, track, n_sims=int(sims), settings=settings, field_size=field_size,
                 field_year=field_year, reliability=reliability, seed=int(seed),
                 progress=lambda f: bar.progress(f, text=f"Racing… {f:.0%}"))
    bar.empty()
    st.session_state["summary"] = s

s = st.session_state.get("summary")
if s is None:
    st.info("Pick drivers, cars and a circuit, then press **Simulate race**.")
    st.stop()

# entity colours follow the order the user entered them, not the ranking
color_of = {}
for i, b in enumerate(s.breakdowns):
    color_of[[k for k in s.labels if k.startswith(f"{b.driver_ref}@{b.car_key}")][0]] = PALETTE[i % len(PALETTE)]
labels = [s.labels[k] for k in color_of]
scale = alt.Scale(domain=labels, range=list(color_of.values()))

st.divider()
t = s.track
w = s.weather_share
st.subheader(f"{t['grand_prix']}: {s.n_sims:,} simulated races")
c = st.columns(4)
leader = s.rows[0]
c[0].metric("Most often ahead of the other picks",
            f"{leader['label'].split(' · ')[0].split()[-1]} · {leader['beats_all']:.0%}",
            help=f"{leader['label']} finished ahead of every other driver you picked in "
                 f"{leader['beats_all']:.1%} of the simulated races.")
c[1].metric("Races with rain", f"{w['wet'] + w['mixed']:.0%}")
c[2].metric("Races with a safety car", f"{s.sc_share:.0%}")
c[3].metric("Races with a VSC", f"{s.vsc_share:.0%}")

left, right = st.columns([1, 1])
with left:
    st.markdown("**Who finishes ahead of all the other picks**")
    df = pd.DataFrame([{"Entry": r["label"], "Share": r["beats_all"]} for r in s.rows])
    base = alt.Chart(df).encode(
        y=alt.Y("Entry:N", sort=None, title=None, axis=alt.Axis(labelLimit=260)),
        x=alt.X("Share:Q", axis=alt.Axis(format="%", grid=True), title=None,
                scale=alt.Scale(domain=[0, max(0.05, df["Share"].max() * 1.15)])),
        tooltip=[alt.Tooltip("Entry:N"), alt.Tooltip("Share:Q", format=".1%")])
    bars = base.mark_bar(cornerRadiusEnd=4, height=22).encode(color=alt.Color("Entry:N", scale=scale, legend=None))
    text = base.mark_text(align="left", dx=6).encode(text=alt.Text("Share:Q", format=".0%"))
    st.altair_chart((bars + text).properties(height=48 * len(df) + 20), width="stretch")

with right:
    st.markdown(f"**How each race ends** (in a {s.field_size}-car field)")
    bands = []
    for r in s.rows:
        cnt = s.position_counts[r["key"]] / s.n_sims
        win, pod, pts = cnt[0], cnt[1:3].sum(), cnt[3:10].sum()
        fin_other = max(0.0, 1 - win - pod - pts - r["dnf"])
        for band, v, o in [("Win", win, 0), ("P2–P3", pod, 1), ("P4–P10", pts, 2),
                           ("P11 or lower", fin_other, 3), ("Did not finish", r["dnf"], 4)]:
            bands.append({"Entry": r["label"], "Outcome": band, "Share": v, "o": o})
    bdf = pd.DataFrame(bands)
    ramp = ["#184f95", "#3987e5", "#86b6ef", "#cde2fb", "#898781"]
    st.altair_chart(alt.Chart(bdf).mark_bar(height=22, stroke="#fcfcfb", strokeWidth=2).encode(
        y=alt.Y("Entry:N", sort=[r["label"] for r in s.rows], title=None, axis=alt.Axis(labelLimit=260)),
        x=alt.X("Share:Q", stack="normalize", axis=alt.Axis(format="%"), title=None),
        color=alt.Color("Outcome:N", sort=["Win", "P2–P3", "P4–P10", "P11 or lower", "Did not finish"],
                        scale=alt.Scale(domain=["Win", "P2–P3", "P4–P10", "P11 or lower", "Did not finish"], range=ramp),
                        legend=alt.Legend(orient="bottom", title=None, columns=2, labelLimit=200)),
        order=alt.Order("o:Q"),
        tooltip=["Entry:N", "Outcome:N", alt.Tooltip("Share:Q", format=".1%")],
    ).properties(height=48 * len(s.rows) + 50), width="stretch")

st.markdown("**Results table**")
st.dataframe(pd.DataFrame([{
    "Entry": r["label"], "Beats the other picks": f"{r['beats_all']:.1%}", "Win": f"{r['win']:.1%}",
    "Podium": f"{r['podium']:.1%}", "Pole": f"{r['pole']:.1%}", "Avg grid": round(r["avg_grid"], 1),
    "Avg finish": round(r["avg_pos"], 1), "DNF": f"{r['dnf']:.1%}", "Avg stops": round(r["avg_stops"], 1),
    "Laps led": round(r["laps_led"], 1)} for r in s.rows]), hide_index=True, width="stretch")

if len(s.keys) > 1:
    st.markdown("**Head-to-head**: chance the row driver finishes ahead of the column driver")
    short = {k: s.labels[k].split(" · ")[0] for k in s.keys}
    h = pd.DataFrame([[("—" if a == b else f"{s.h2h[(a, b)]:.0%}") for b in s.keys] for a in s.keys],
                     index=[short[k] for k in s.keys], columns=[short[k] for k in s.keys])
    st.dataframe(h, width="stretch")

st.markdown(f"**Where the pace comes from.** Score units: +1.0 ≈ {m.pct_per_unit:.2f}% of lap time "
            f"(≈ {m.pct_per_unit / 100 * t['base_lap']:.2f}s per lap here)")
st.dataframe(pd.DataFrame([{
    "Entry": b.label, "Driver skill": round(b.skill, 2), "Era fit": round(b.affinity, 2),
    "Age + experience": round(b.age_effect + b.experience_effect, 2), "Car": round(b.car_units, 2),
    "Total": round(b.total, 2), "Wet skill": round(b.wet, 2), "Crash-prone ×": round(b.crash_ratio, 2),
    "Era fit source": f"{b.era_name}: {b.affinity_source}", "Age": b.age_note,
} for b in s.breakdowns]), hide_index=True, width="stretch")
for b in s.breakdowns:
    for note in b.notes:
        st.caption(f"ℹ️ {note}")

# ---------------------------------------------------------------- sample race
smp = s.sample
st.subheader(f"One race, lap by lap ({ {'dry': 'dry', 'wet': 'wet start', 'mixed': 'rain mid-race'}[smp.weather] })")
rows = []
for k in color_of:
    for lap, p in enumerate(smp.positions[k], start=1):
        if p is not None:
            rows.append({"Lap": lap, "Position": p, "Entry": s.labels[k]})
pdf = pd.DataFrame(rows)
neutral = []
for lap, text in smp.events:
    if text.startswith("Safety car deployed") or text.startswith("Safety car:"):
        neutral.append({"start": lap, "end": lap + 3, "kind": "Safety car"})
wet_laps = [i for i, x in enumerate(smp.wetness or []) if x > 0.2]
layers = []
if wet_laps:
    layers.append(alt.Chart(pd.DataFrame({"start": [min(wet_laps)], "end": [max(wet_laps)]})).mark_rect(
        opacity=0.12, color="#2a78d6").encode(x=alt.X("start:Q", title="Lap"), x2="end:Q"))
if neutral:
    layers.append(alt.Chart(pd.DataFrame(neutral)).mark_rect(opacity=0.18, color="#898781").encode(
        x=alt.X("start:Q", title="Lap"), x2="end:Q", tooltip=["kind:N", alt.Tooltip("start:Q", title="From lap")]))
max_pos = int(pdf["Position"].max()) if not pdf.empty else 20
lines = alt.Chart(pdf).mark_line(strokeWidth=2, interpolate="step-after").encode(
    x=alt.X("Lap:Q", scale=alt.Scale(domain=[1, t["laps"]], nice=False), axis=alt.Axis(grid=False)),
    y=alt.Y("Position:Q", scale=alt.Scale(reverse=True, domain=[1, max_pos]), axis=alt.Axis(tickMinStep=1)),
    color=alt.Color("Entry:N", scale=scale, legend=alt.Legend(orient="bottom", title=None, columns=2, labelLimit=320)),
    tooltip=["Entry:N", "Lap:Q", "Position:Q"])
st.altair_chart(alt.layer(*layers, lines).properties(height=320), width="stretch")
st.caption("Grey bands: safety car · blue band: wet track")
res = sorted(s.keys, key=lambda k: smp.cars[k].position)
st.markdown("  ·  ".join(f"**P{smp.cars[k].position}** {s.labels[k].split(' · ')[0]}"
                         + ("" if smp.cars[k].finished else f" (DNF, {smp.cars[k].dnf_reason})") for k in res))
with st.expander("Race log"):
    for lap, text in smp.events:
        st.write(f"{'Qualifying' if lap == 0 else f'Lap {lap}'}: {text}")

with st.expander("About the model"):
    st.markdown(f"""
* **Data:** every Grand Prix since 1950 from the Jolpica F1 database (the successor to Ergast),
  {m.meta['observations']:,} race and qualifying results, through {m.meta['data_through']}.
* **Driver vs car:** a ridge regression explains every qualifying and race result as driver skill + car
  (constructor-season and constructor-era terms) + the driver's fit with that generation of car + age +
  experience. Teammates share a car, so the car's share is separated from the driver's mostly through
  teammate comparisons. Penalties were chosen by cross-validation (error {m.meta['cv_mse']:.3f} vs 1.0 for a coin flip on the score scale).
* **Era fit:** {len(ERAS)} generations (1950s front-engine through the 2026 active-aero cars). A driver who never
  raced in a generation gets an estimate from the generations they did race in, weighted by how similar
  the cars were.
* **Lap time:** 1 score unit = {m.pct_per_unit:.2f}% of lap time, calibrated on 2014+ qualifying gaps (R² {m.meta['calibration']['r2']:.2f}).
  Every car races in a modern-sized performance spread, so a 1955 car and a 2023 car are compared by how
  dominant each was in its own field.
* **Simulation:** quali, standing start, tyre compounds and wear (random for each car), fuel, dirty air and a
  circuit-specific overtaking threshold, pit strategy, rain, crashes, mechanical failures, safety cars and VSCs.
""")
