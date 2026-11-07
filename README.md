# 🏁 F1 Driver Performance Indicator

Put any Formula 1 driver in any F1 car on any circuit and simulate the race thousands of times.

**Try it in your browser: https://notluvii.github.io/F1-Driver-Performance-Indicator/**

```
python -m f1dpi simulate -e "Senna:1988" -e "Max Verstappen:2023" -e "Hamilton:2020" -t silverstone
```

```
British Grand Prix · Silverstone Circuit · 52 laps · 1,000 simulations · 20 cars
Conditions: dry 86.5%, wet start 5.2%, rain mid-race 8.3% · safety car in 42.2% of races, VSC in 41.1%

Entry                           Best of picks    Win  Podium  Avg grid  Avg finish    DNF  Stops
Ayrton Senna · McLaren 1988             48.0%  40.9%   75.7%       2.4         4.0  11.7%    1.2
Lewis Hamilton · Mercedes 2020          26.4%  21.7%   60.6%       3.4         4.5  10.3%    1.2
Max Verstappen · Red Bull 2023          25.6%  20.0%   61.9%       3.3         5.0  13.3%    1.2

Where the pace comes from (score units; +1.0 ≈ 1.17% of lap time):
Entry                           Driver  Era fit  Age/exp    Car  Total    Wet
Ayrton Senna · McLaren 1988      +0.69    +0.05    -0.03  +0.94  +1.66  +0.13
Max Verstappen · Red Bull 2023   +0.68    +0.27    -0.05  +0.55  +1.46  +0.07
Lewis Hamilton · Mercedes 2020   +0.49    +0.07    -0.26  +1.17  +1.47  +0.05
```

Every number is learned from **1,155 Grands Prix (1950 – Singapore 2026)**. Each simulated race includes
qualifying, tyre strategy, safety cars, rain, crashes and mechanical failures. Each driver also gets a
rating for **how well they suited each generation of F1 car**.

---

## Quick start

```bash
pip install -r requirements.txt

streamlit run app.py                     # the same app, run locally with Streamlit
python -m f1dpi simulate -e "Clark:1963" -e "Leclerc:2024" -t monaco --weather wet
python -m pytest                         # 19 tests
```

The fitted ratings ship in `model/`, so you don't need to download anything to run it.

### The website

The public site lives in `docs/` and needs no server: `docs/sim.js` is a JavaScript port of the race
simulator, which runs in a Web Worker in the visitor's browser, and `docs/data/` holds a copy of the
fitted ratings. The Python and JavaScript simulators agree to within Monte Carlo noise (about 1–2
percentage points at 2,000 races). Matchups are saved in the page address, so any race can be shared
as a link.

Each result includes an animated **race replay** (`docs/replay.js`): the cars move around the real circuit
layout, with a live timing tower (gaps, pit stops, tyres), safety-car and rain flags and race control
messages. You can play or pause it, run it at 1× to 100× speed, jump to any lap, skip to the finish, or
generate a different race with the same line-up. Cars slow down in corners and speed up on straights
using a speed profile derived from each circuit's curvature. Circuit outlines come from
[bacinger/f1-circuits](https://github.com/bacinger/f1-circuits) (MIT licence) and are rebuilt with
`python -m f1dpi.circuits`. The four old circuits that dataset doesn't cover (Valencia, Yeongam,
Buddh, Fuji) are shown on a generic loop.

To preview it locally, run `python -m http.server -d docs 8000` and open http://localhost:8000.
After refitting with `python -m f1dpi build`, copy `model/*.json` into `docs/data/`, then publish:

```bash
git subtree push --prefix docs origin gh-pages
```

### CLI cheatsheet

| Command | What it does |
|---|---|
| `simulate -e "Driver:year[:team]" ... -t track` | Simulate a race. The year picks the car; with no team, you get the team they drove for that year. |
| `--same-car "Red Bull 2023"` | Put every driver in the same car, for a pure driver comparison. Each driver's fit with that car's generation still applies. |
| `--weather random\|dry\|wet\|mixed` | `random` uses the circuit's real rain odds. `mixed` brings rain mid-race. |
| `--reliability modern\|era\|off` | `modern` gives everyone the same failure rate, `era` uses each car's real reliability, `off` disables failures. |
| `--field-year 2025` | Fill the grid with that season's real drivers and cars instead of generic midfield cars. |
| `-n 5000`, `--seed 7`, `--json`, `--no-safety-car`, `--laps 30` | Number of simulations, random seed, JSON output, no safety cars, race length. |
| `driver "Jim Clark"` | Show a driver's skill, wet rating, crash-proneness and fit with all 15 F1 generations. |
| `cars 1988` | List that season's cars by rating, with their real reliability. |
| `tracks` | List all 39 circuits with lap time, pit loss, overtaking difficulty, tyre wear and rain odds. |
| `build` | Refit everything from `data/raw/jolpica-f1-csv.zip`. Get a fresh dump with `python -m f1dpi.download`. |

Names are forgiving. `Schumacher` resolves to Michael and `Verstappen` to Max; type a full name to get
Ralf or Jos. Circuits accept `spa`, `Monaco`, `cota`, `Brazil`, `Abu Dhabi` and similar.

---

## How it works

### 1. Separating the driver from the car (`f1dpi/fit.py`)

Each race result and each qualifying result becomes a **normal score**: a rank converted to a z-value, so
P1 ≈ +1.9 and last place ≈ −1.9 whatever the field size. Every score is then explained as a sum of terms:

```
score = driver skill                (their peak level)
      + car                         (constructor × season)
      + team × era                  (a team's strength across a whole rule set)
      + privateer entry             (1950s–70s customer cars vs the works car)
      + driver × era  ← "era fit"   (how much better/worse they were in that generation)
      + age curve + experience curve
      + noise
```

All of this is fitted as one sparse ridge regression with 4,400+ parameters over 40,000 observations.
Teammates share a car, so the regression learns the driver term mostly from teammate comparisons, which
chain across careers back to 1950. Each group of terms gets its own penalty, chosen by **5-fold
cross-validation over held-out Grands Prix**. The one exception is the era-fit penalty, which is fixed at a
stronger value. If it were weaker, a driver who spent a whole era at one team would absorb that team's
strength into their personal era fit (Verstappen and Pérez at Red Bull 2022–24 are the textbook case).

**Wet skill** is a second stage fitted on 83 curated wet races (`f1dpi/wet_races.py`):
`wet score = a × predicted dry pace + wet skill`. Here `a` comes out at 0.87, which captures the extra chaos
of a wet race, so wet skill means "better than their pace predicts given that rain shuffles everyone".

**Calibration.** Score units are converted to lap time by regressing 2014+ qualifying gaps on predicted
pace: **1 unit ≈ 1.17% of lap time (R² 0.68 on 4,712 qualifying results)**. Every car therefore races in
a modern-sized performance spread. A 1955 car and a 2023 car are compared by how dominant each was *in
its own field*, not by raw lap time.

### 2. Generations of F1 cars (`f1dpi/eras.py`)

There are 15 eras, from 1950s front-engined cars to the 2026 active-aero 50/50 hybrids. Each era has a
feature vector:

- downforce
- ground effect
- power
- energy management
- driver aids
- refuelling
- tyre management
- manual gearbox
- danger
- weight

The **era fit** for a generation a driver actually raced in comes straight from the regression. For a
generation they *never* raced in, it's estimated from the eras they did race, weighted by how similar the
cars were and by how much evidence there is. The estimate is shrunk toward zero, so Verstappen in a 1980
ground-effect car borrows a little from his strong 2022–25 ground-effect form.

Age works the same way. If the car year is one the driver actually raced, they get their real age and
experience that season (Hamilton in 2020 is 35). If not, they're placed at their peak.

### 3. Circuits (`f1dpi/tracks.py`)

All of these are measured from the data and shrunk toward the average when a circuit has few races:

- laps and base lap time
- pit-lane loss (2011+)
- overtaking difficulty: how well grid order predicts finishing order, as a Spearman correlation
- tyre wear: dry-race stops per car in the Pirelli era
- incident rate: accident retirements per start
- rain odds: share of races there that were wet

### 4. The race (`f1dpi/engine.py`, `f1dpi/tyres.py`)

Each race is simulated lap by lap:

1. **Qualifying:** one-lap pace plus noise, with a 6% chance of a messed-up session.
2. **Standing start** with launch variation and a scrappy lap 1 (6× crash risk, easier passing).
3. **Lap time** is the sum of:
   - car + driver pace
   - race-day form for the driver
   - track suitability for the car (shared by teammates)
   - fuel burn
   - compound offset
   - tyre wear and the tyre cliff
   - lap noise
4. **Tyre degradation** varies by circuit, by day (track temperature) *and* by car, at random.
5. **Dirty air:** to pass, the car behind has to be faster than a circuit-specific threshold. The
   threshold is low at Las Vegas and Hockenheim and very high at Monaco.
6. **Strategy:** the optimiser picks 1-, 2- or 3-stop plans (two-compound rule included) and values track
   position more where passing is hard. Teams pit opportunistically under a safety car, react when the
   rain arrives or the track dries (each team calls it slightly differently), and make emergency stops
   when tyres fall off the cliff.
7. **Random events:**
   - driver crashes, scaled by the driver's historical crash-proneness, the circuit and wetness
   - mechanical failures
   - non-fatal spins and offs
   - slow pit stops
   - debris
   - safety cars and VSCs triggered by incidents, more likely on street circuits
8. **Rain** can start the race wet (behind the safety car if it's soaked) or arrive mid-race. Wetness
   builds and dries lap by lap. In the wet, driver skill and wet skill count for more and the car gap
   shrinks.

---

## Does it work?

The real test is to simulate known teammate pairings in their actual cars (no hand-tuning per pair) and
compare with the real season. These are averaged over six circuits:

| Teammates | Season | Real: A finished ahead | Simulated |
|---|---|---|---|
| Max Verstappen vs Sergio Pérez | 2023 | 91% (20/22) | 86% |
| Sebastian Vettel vs Mark Webber | 2011 | 84% (16/19) | 77% |
| Lewis Hamilton vs Valtteri Bottas | 2019 | 71% (15/21) | 72% |
| Fernando Alonso vs Lewis Hamilton | 2007 | 59% (10/17) | 61% |
| Lando Norris vs Oscar Piastri | 2025 | 57% (13/23) | 62% |
| Ayrton Senna vs Alain Prost | 1988 | 56% (9/16) | 68% |
| Charles Leclerc vs Carlos Sainz | 2022 | 55% (11/20) | 58% |
| Lewis Hamilton vs Nico Rosberg | 2016 | 50% (10/20) | 53% |

The mean absolute error is **4.7 percentage points**. The simulator leans slightly toward the faster
teammate (+1.7 points on average).

The test suite also fits the regression to **synthetic seasons with known driver skills** and checks that
it recovers them (correlation > 0.85).

## Known limitations

- **Dominance gets compressed.** Ranks can't tell "won by a lap" from "won by a second", so cars that
  crushed their rivals (1988 McLaren, 1963 Lotus) look closer to the next-best car than they really were.
  Their drivers absorb some of that credit.
- **"Second-seat" cars.** When the teammates all struggle badly in one car (Red Bull's second seat in
  2025), the model reads that as a weaker car. It then underrates what the lead driver could do with it.
- **Pre-1980 customer cars.** The data lists constructors, not entrants, so a privateer Maserati and the
  works Maserati share a name. The privateer-entry term corrects some of this, but 1950s ratings are the
  least certain.
- **Wet skill** is learned from a curated list of 83 wet races. Adding more to `wet_races.py` and running
  `python -m f1dpi build` sharpens it.
- The **era feature values** in `eras.py` are judgment calls, written down so you can argue with them.

## Project layout

```
f1dpi/
  dataset.py     load + tidy the Jolpica CSV dump
  eras.py        15 car generations, features, similarity
  wet_races.py   curated wet-race list
  fit.py         ridge model, cross-validation, wet stage, calibration, reliability, crash rates
  tracks.py      circuit profiles
  model.py       driver/car/track lookup and the pace breakdown
  tyres.py       tyre model + strategy optimiser
  engine.py      lap-by-lap race simulator
  montecarlo.py  run N races, aggregate
  cli.py         command line
  download.py    fetch a fresh data dump
  circuits.py    circuit outlines for the website's race replay
app.py           Streamlit app
docs/            the public website (static HTML/CSS/JS + a JavaScript port of the simulator)
model/           fitted ratings.json + tracks.json
tests/           pytest suite
```

## Data

Race data comes from the [Jolpica F1](https://github.com/jolpica/jolpica-f1) database, the community
successor to the Ergast API. Circuit layouts come from
[bacinger/f1-circuits](https://github.com/bacinger/f1-circuits) (MIT licence, © 2019-2025 Tomislav Bacinger). Ratings were last rebuilt from the dump covering races through the 2026
Singapore Grand Prix.
