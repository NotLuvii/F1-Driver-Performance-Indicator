"""Lap-by-lap race simulator.

One call to :meth:`RaceSimulator.run` simulates qualifying and a full Grand Prix:

* qualifying: one-lap pace plus noise (in the wet if the race starts wet)
* standing start with launch variation and a scrappy first lap
* lap times from car + driver pace, race-day form, fuel burn, tyre compound and wear,
  the car's own (random) tyre appetite, and lap-to-lap noise
* dirty air and overtaking: a faster car has to be quicker than a circuit-specific threshold
  to get past, otherwise it gets stuck behind
* pit strategy: an optimised 1/2/3-stop plan, opportunistic stops under safety cars,
  tyre changes when rain arrives or the track dries, emergency stops when tyres fall off the cliff
* random events: driver crashes (driver crash-proneness, circuit incident rate, wetness and
  lap 1 all raise the odds), mechanical failures (era or modern reliability), safety cars
  and virtual safety cars triggered by those, and rain showers
* wet conditions amplify driver skill and the driver's wet-weather rating, and shrink the car gap

All timings are in seconds. Pace inputs are in model "score units"; ``pct_per_unit`` turns them
into percent of lap time.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from .tyres import COMPOUNDS, DRY, best_tyre_for, choose_plan, lap_cost, weather_penalty

REF_PACE = 1.5           # a top car + top driver (score units) laps at the circuit's base lap time
GRID_SLOT_GAP = 0.25     # seconds between grid slots at the start
START_LOSS = 2.2         # extra seconds of a standing-start lap
SC_LAP_FACTOR = 1.40     # safety-car laps are ~40% slower
VSC_LAP_FACTOR = 1.30
SC_PIT_FACTOR = 0.55     # pit stops cost ~45% less time under a safety car
VSC_PIT_FACTOR = 0.65


@dataclass
class SimEntry:
    key: str
    label: str                 # e.g. "Ayrton Senna · McLaren 1988"
    short: str                 # e.g. "SEN"
    driver_units: float        # skill + era affinity + age + experience
    car_units: float
    wet_units: float = 0.0
    crash_mult: float = 1.0
    mech_rate: float = 0.05    # probability of a mechanical DNF over a race distance
    is_user: bool = True
    color: str | None = None
    car_id: str | None = None   # entries sharing a car_id share that car's track-suitability roll


@dataclass
class SimSettings:
    weather: str = "random"    # dry | wet | mixed | random
    safety_car: bool = True
    incidents: bool = True
    laps: int | None = None
    form_sd: float = 0.30      # driver's race-day form, score units
    car_form_sd: float = 0.18  # how well the car suits this circuit on the day, score units
    lap_sd_pct: float = 0.22   # lap-to-lap noise, % of lap time
    quali_sd_pct: float = 0.18
    car_wear_sd: float = 0.15  # per-car tyre appetite (log-normal sd)
    day_wear_sd: float = 0.12  # whole-field tyre wear on the day (track temperature etc.)
    crash_rate: float = 0.034  # accident DNFs per start, modern average
    quali_mishap: float = 0.06 # chance of a messed-up qualifying (traffic, red flag, mistake, issue)
    race_mistake: float = 0.05 # chance of a costly off/spin that doesn't end the race
    lap1_crash_mult: float = 6.0


@dataclass
class CarResult:
    key: str
    position: int
    grid: int
    finished: bool
    laps: int
    total_time: float
    dnf_reason: str | None
    dnf_lap: int | None
    stops: int
    tyres: list
    laps_led: int
    best_lap: float


@dataclass
class RaceResult:
    order: list                      # keys in finishing order
    cars: dict                       # key -> CarResult
    weather: str                     # dry | wet | mixed
    safety_cars: int
    vscs: int
    events: list = field(default_factory=list)          # (lap, text)
    positions: dict | None = None    # key -> [position after each lap] (only when recorded)
    wetness: list | None = None


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


class RaceSimulator:
    def __init__(self, track: dict, entries: list[SimEntry], pct_per_unit: float,
                 settings: SimSettings | None = None):
        self.track = track
        self.entries = entries
        self.k = pct_per_unit / 100.0
        self.s = settings or SimSettings()
        self.laps = int(self.s.laps or track["laps"])
        self.base = float(track["base_lap"])
        self.scale = self.base / 90.0
        rho = float(track["overtaking_rho"])
        thr = 0.3 * math.exp(6.0 * (rho - 0.6))
        if track.get("street") and not track.get("semi_street"):
            thr *= 1.25
        self.pass_threshold = thr * self.scale
        self.pit_loss = float(track["pit_loss"])
        # strategists value track position more where passing is hard: plan as if stops cost more
        self.plan_pit_loss = self.pit_loss + 6.0 * max(0.0, thr / 0.9 - 1.0) * self.scale
        self.inc_mult = float(track["incident_rate"])
        self.street = bool(track.get("street"))

    # ------------------------------------------------------------------ weather
    def _weather_script(self, rng) -> tuple[str, np.ndarray, np.ndarray]:
        """Return (label, wetness per lap [laps+1], raining per lap)."""
        L = self.laps
        mode = self.s.weather
        if mode == "random":
            if rng.random() < float(self.track["rain_chance"]):
                mode = "wet" if rng.random() < 0.35 else "mixed"
            else:
                mode = "dry"
        intensity = np.zeros(L + 1)
        if mode == "wet":
            dur = int(L * rng.uniform(0.25, 0.75))
            intensity[: dur + 1] = rng.uniform(0.55, 0.95)
            if rng.random() < 0.3:                       # a second shower later on
                a = int(rng.uniform(0.6, 0.85) * L)
                intensity[a: a + int(rng.integers(4, 12))] = rng.uniform(0.3, 0.7)
        elif mode == "mixed":
            a = int(rng.uniform(0.2, 0.75) * L)
            dur = int(rng.integers(5, 22))
            intensity[a: a + dur] = rng.uniform(0.3, 0.9)
        wet = np.zeros(L + 1)
        w = intensity[0] * rng.uniform(0.85, 1.0) if mode == "wet" else 0.0
        dry_rate = rng.uniform(0.035, 0.075)
        for lap in range(L + 1):
            if intensity[lap] > 0:
                w += (intensity[lap] - w) * 0.35
            else:
                w = max(0.0, w - dry_rate)
            wet[lap] = w
        return mode, wet, intensity > 0

    # ------------------------------------------------------------------ main
    def run(self, rng: np.random.Generator, record: bool = False) -> RaceResult:
        s, L, n = self.s, self.laps, len(self.entries)
        E = self.entries
        weather, wet, raining = self._weather_script(rng)
        events: list = []

        drv = np.array([e.driver_units for e in E])
        car = np.array([e.car_units for e in E])
        wet_skill = np.array([e.wet_units for e in E])
        form = rng.normal(0.0, s.form_sd, n)
        car_ids = [e.car_id or e.key for e in E]
        roll = {cid: rng.normal(0.0, s.car_form_sd) for cid in dict.fromkeys(car_ids)}
        car = car + np.array([roll[c] for c in car_ids])
        day_wear = math.exp(rng.normal(0, s.day_wear_sd)) * float(self.track["tyre_wear"])
        wear = day_wear * np.exp(rng.normal(0, s.car_wear_sd, n))
        # per-car wet-weather call timing (some teams gamble earlier than others)
        call_bias = rng.normal(0, 0.05, n)

        def pace_units(w: float) -> np.ndarray:
            return car * (1 - 0.25 * w) + (drv + form) * (1 + 0.35 * w) + wet_skill * w * 1.5

        # ---------------- qualifying
        w0 = wet[0]
        q_units = pace_units(w0) - form * 0.5
        q_time = self.base * (1 + self.k * (REF_PACE - q_units)) \
            + self.base * rng.normal(0, s.quali_sd_pct / 100 * (1 + 2 * w0), n)
        mishap = rng.random(n) < s.quali_mishap
        q_time = q_time + mishap * self.base * rng.uniform(0.005, 0.03, n)
        if record:
            for i in np.where(mishap)[0]:
                if E[i].is_user:
                    events.append((0, f"Qualifying goes wrong for {E[i].label}"))
        grid_order = list(np.argsort(q_time))
        grid_pos = np.empty(n, int)
        grid_pos[grid_order] = np.arange(1, n + 1)

        # ---------------- race state
        total = np.array([GRID_SLOT_GAP * (grid_pos[i] - 1) for i in range(n)], float)
        running = np.ones(n, bool)
        laps_done = np.zeros(n, int)
        dnf_reason = [None] * n
        dnf_lap = [None] * n
        stops = np.zeros(n, int)
        laps_led = np.zeros(n, int)
        best_lap = np.full(n, np.inf)
        tyre_hist = [[] for _ in range(n)]
        used = ["" for _ in range(n)]          # dry compounds used ("*" once wet tyres used)
        plans = [None] * n
        stint_end = np.zeros(n, int)            # lap at which the planned stop happens (0 = none)
        start_class = best_tyre_for(w0)
        compound = []
        for i in range(n):
            if start_class == "S":
                p = choose_plan(L, wear[i], self.plan_pit_loss, self.scale, "", rng)
                plans[i] = list(p.stints)
                compound.append(plans[i][0][0])
                stint_end[i] = plans[i][0][1] if len(plans[i]) > 1 else 0
            else:
                compound.append(start_class)
                used[i] = "*"
                plans[i] = []
                stint_end[i] = 0
            tyre_hist[i].append(compound[i])
        age = np.zeros(n, int)
        sc_left = vsc_left = 0
        n_sc = n_vsc = 0
        if w0 > 0.78:
            sc_left = int(rng.integers(2, 5))
            n_sc += 1
            events.append((1, "Race starts behind the safety car on a soaked track"))
        positions = {e.key: [] for e in E} if record else None
        mistake_lap = np.where(rng.random(n) < s.race_mistake * (1 + 2 * float(wet.max())),
                               rng.integers(1, L + 1, n), -1)
        crash_lap = s.crash_rate / (L + s.lap1_crash_mult - 1)

        def replan(i: int, lap: int):
            laps_left = L - lap
            if laps_left <= 0:
                plans[i], stint_end[i] = [], 0
                return
            p = choose_plan(laps_left, wear[i], self.plan_pit_loss, self.scale, used[i], rng, spread=1.5)
            plans[i] = list(p.stints)
            stint_end[i] = lap + plans[i][0][1] if len(plans[i]) > 1 else 0

        def retire(i: int, lap: int, reason: str):
            nonlocal sc_left, vsc_left, n_sc, n_vsc
            running[i] = False
            dnf_reason[i], dnf_lap[i] = reason, lap
            events.append((lap, f"{E[i].label} retires: {reason}" if E[i].is_user or reason == "Accident"
                           else f"{E[i].label} retires ({reason})"))
            if not s.safety_car or sc_left > 0:
                if sc_left > 0:
                    sc_left += 1
                return
            p_sc = (0.80 if self.street else 0.45) if reason == "Accident" else (0.15 if self.street else 0.08)
            p_vsc = 0.35 if reason == "Accident" else 0.22
            r = rng.random()
            if r < p_sc:
                sc_left = int(rng.integers(3, 6)) + (1 if self.street else 0)
                n_sc += 1
                events.append((lap, "Safety car deployed"))
            elif r < p_sc + (1 - p_sc) * p_vsc and vsc_left == 0:
                vsc_left = int(rng.integers(1, 4))
                n_vsc += 1
                events.append((lap, "Virtual safety car"))

        for lap in range(1, L + 1):
            w = wet[lap]
            laps_left = L - lap + 1
            neutral = "SC" if sc_left > 0 else ("VSC" if vsc_left > 0 else None)
            idx = [i for i in np.argsort(total) if running[i]]
            if not idx:
                break

            # ---------- pit decisions (made going into this lap's in-lap)
            pitting = np.zeros(n, bool)
            new_comp = [None] * n
            want_class = best_tyre_for(w)
            for i in idx:
                if laps_left <= 1:
                    break
                cur = compound[i]
                cur_class = "S" if cur in DRY else cur
                # rain / drying calls, with per-car timing bias and a little hysteresis
                target = best_tyre_for(min(1.0, max(0.0, w + call_bias[i] + (0.04 if cur_class != "S" else -0.02))))
                if target != cur_class and laps_left > 2:
                    gain = (weather_penalty(cur, w) - weather_penalty("S" if target == "S" else target, w)) * self.base
                    if gain * min(laps_left, 8) > self.pit_loss * 0.6 or gain > 3.0:
                        pitting[i] = True
                        # slicks: the compound is chosen by the replan after the stop
                        new_comp[i] = None if target == "S" else target
                        continue
                if cur_class != "S":
                    continue
                life = COMPOUNDS[cur].life / wear[i]
                planned = stint_end[i] > 0 and lap >= stint_end[i]
                cheap = neutral is not None and stint_end[i] > 0 and stint_end[i] - lap <= 12 and laps_left > 5
                cliff = age[i] > life + 3 and laps_left > 6
                if planned or cheap or cliff:
                    pitting[i] = True

            # ---------- lap times
            units = pace_units(w)
            lt = np.zeros(n)
            for i in idx:
                t = self.base * (1 + self.k * (REF_PACE - units[i]))
                t += lap_cost(compound[i], int(age[i]), wear[i] if compound[i] in DRY else 1.0, self.scale)
                t += self.base * (weather_penalty(compound[i], w) + 0.10 * w)
                t += 0.055 * self.scale * (laps_left - 1)               # fuel load
                t += self.base * rng.normal(0, s.lap_sd_pct / 100 * (1 + 1.5 * w))
                if lap == 1:
                    t += START_LOSS + abs(rng.normal(0, 0.35))
                if lap == mistake_lap[i] and s.incidents:
                    loss = rng.uniform(4, 18)
                    t += loss
                    if record and E[i].is_user:
                        events.append((lap, f"{E[i].label} runs wide/spins, loses {loss:.0f}s"))
                lt[i] = t

            pit_cost = np.zeros(n)
            for i in idx:
                if pitting[i]:
                    f = SC_PIT_FACTOR if neutral == "SC" else (VSC_PIT_FACTOR if neutral == "VSC" else 1.0)
                    c = self.pit_loss * f + abs(rng.normal(0, 0.5))
                    if rng.random() < 0.03:
                        c += rng.uniform(3, 9)
                        if E[i].is_user:
                            events.append((lap, f"Slow stop for {E[i].label} (+{c - self.pit_loss:.1f}s)"))
                    pit_cost[i] = c

            # ---------- move cars: neutralised or racing
            new_total = total.copy()
            if neutral == "SC":
                lead_t = total[idx[0]] + self.base * SC_LAP_FACTOR
                prev = None
                for i in idx:
                    if prev is None:
                        new_total[i] = lead_t
                    else:
                        gap = total[i] - total[prev]
                        new_total[i] = new_total[prev] + max(0.5, gap * 0.35)
                    prev = i
                new_total[idx] += pit_cost[idx]
            elif neutral == "VSC":
                for i in idx:
                    new_total[i] = total[i] + self.base * VSC_LAP_FACTOR + pit_cost[i] \
                        + rng.normal(0, 0.15)
            else:
                thr = self.pass_threshold * (1 - 0.35 * w) * (0.5 if lap == 1 else 1.0)
                for pos, i in enumerate(idx):
                    t_new = total[i] + lt[i] + pit_cost[i]
                    if pos > 0 and not pitting[i]:
                        a = idx[pos - 1]
                        gap0 = total[i] - total[a]
                        close = 3.0 if lap == 1 else 1.5
                        if gap0 < close and t_new < new_total[a] + 0.25 and not pitting[a]:
                            adv = lt[a] - lt[i]
                            p = _sigmoid((adv - thr) / (0.25 * self.scale))
                            if lap == 1:
                                p = max(p, 0.25)
                            if rng.random() < p:
                                t_new = min(t_new, new_total[a] - 0.1)
                            else:
                                t_new = max(t_new, new_total[a] + rng.uniform(0.25, 0.7))
                    new_total[i] = t_new
            total = new_total

            # ---------- tyres after the stop
            for i in idx:
                if pitting[i]:
                    stops[i] += 1
                    if new_comp[i] is not None:          # onto wet tyres
                        compound[i] = new_comp[i]
                        used[i] = "*"
                        plans[i], stint_end[i] = [], 0
                    else:
                        if compound[i] in DRY and used[i] != "*" and compound[i] not in used[i]:
                            used[i] += compound[i]
                        replan(i, lap)
                        compound[i] = plans[i][0][0] if plans[i] else "H"
                    age[i] = 0
                    tyre_hist[i].append(compound[i])
                else:
                    age[i] += 1
                if compound[i] in DRY and used[i] != "*" and compound[i] not in used[i]:
                    used[i] += compound[i]

            # ---------- incidents
            if s.incidents:
                for i in idx:
                    if not running[i]:
                        continue
                    if neutral is None:
                        h = crash_lap * E[i].crash_mult * self.inc_mult * (1 + 3.0 * w)
                        if lap == 1:
                            h *= s.lap1_crash_mult
                        if rng.random() < h:
                            retire(i, lap, "Accident")
                            continue
                    hm = -math.log(max(1e-9, 1 - E[i].mech_rate)) / L
                    if rng.random() < hm:
                        retire(i, lap, rng.choice(["Engine", "Gearbox", "Hydraulics", "Power unit",
                                                   "Suspension", "Brakes", "Electrical"]))
                if s.safety_car and sc_left == 0 and vsc_left == 0 and rng.random() < 0.002 * (1 + 2 * w):
                    if rng.random() < 0.5:
                        sc_left, n_sc = int(rng.integers(2, 5)), n_sc + 1
                        events.append((lap, "Safety car: debris on track"))
                    else:
                        vsc_left, n_vsc = int(rng.integers(1, 3)), n_vsc + 1
                        events.append((lap, "Virtual safety car: car recovery"))

            # weather narration
            if record:
                if raining[lap] and not raining[lap - 1]:
                    events.append((lap, "Rain starts to fall"))
                if not raining[lap] and raining[lap - 1]:
                    events.append((lap, "The rain stops; the track begins to dry"))
                field_pits = {}
                for i in idx:
                    if pitting[i] and running[i]:
                        name = COMPOUNDS[compound[i]].name
                        if E[i].is_user:
                            events.append((lap, f"{E[i].label} pits → {name}"))
                        else:
                            field_pits[name] = field_pits.get(name, 0) + 1
                for name, cnt in field_pits.items():
                    if cnt >= 3:
                        events.append((lap, f"{cnt} other cars pit for {name}s"))

            # ---------- bookkeeping
            for i in idx:
                if running[i]:
                    laps_done[i] = lap
                    if neutral is None and lt[i] < best_lap[i] and lap > 1:
                        best_lap[i] = lt[i]
            run_idx = [i for i in np.argsort(total) if running[i]]
            if run_idx:
                laps_led[run_idx[0]] += 1
            if sc_left > 0:
                sc_left -= 1
                if sc_left == 0:
                    events.append((lap, "Safety car in; racing resumes"))
            elif vsc_left > 0:
                vsc_left -= 1
            if record:
                order_now = run_idx + [i for i in range(n) if not running[i]]
                for p_, i in enumerate(order_now):
                    positions[E[i].key].append(p_ + 1 if running[i] else None)

        # ---------------- classification
        fin = sorted(range(n), key=lambda i: (-laps_done[i], total[i]))
        cars = {}
        for p_, i in enumerate(fin):
            cars[E[i].key] = CarResult(
                key=E[i].key, position=p_ + 1, grid=int(grid_pos[i]), finished=bool(running[i]),
                laps=int(laps_done[i]), total_time=float(total[i]), dnf_reason=dnf_reason[i],
                dnf_lap=dnf_lap[i], stops=int(stops[i]), tyres=tyre_hist[i],
                laps_led=int(laps_led[i]), best_lap=float(best_lap[i]))
        events.sort(key=lambda x: x[0])
        return RaceResult(order=[E[i].key for i in fin], cars=cars, weather=weather,
                          safety_cars=n_sc, vscs=n_vsc, events=events, positions=positions,
                          wetness=wet.tolist() if record else None)
