"""Turn "driver + car year (+ team)" into simulator inputs, with a breakdown of where the pace comes from."""
from __future__ import annotations

import difflib
import json
import unicodedata
from dataclasses import dataclass, field
from datetime import date
from functools import lru_cache
from pathlib import Path

import numpy as np

from . import eras as E
from .engine import SimEntry
from .paths import RATINGS_JSON, TRACKS_JSON

TRACK_ALIASES = {
    "cota": "americas", "austin": "americas", "usa": "americas", "united states": "americas",
    "abu dhabi": "yas_marina", "yas": "yas_marina", "brazil": "interlagos", "sao paulo": "interlagos",
    "mexico": "rodriguez", "mexico city": "rodriguez", "qatar": "losail", "lusail": "losail",
    "melbourne": "albert_park", "australia": "albert_park", "montreal": "villeneuve",
    "canada": "villeneuve", "austria": "red_bull_ring", "spielberg": "red_bull_ring",
    "hungary": "hungaroring", "budapest": "hungaroring", "netherlands": "zandvoort",
    "dutch": "zandvoort", "barcelona": "catalunya", "spain": "catalunya", "madrid": "madring",
    "singapore": "marina_bay", "las vegas": "vegas", "britain": "silverstone", "uk": "silverstone",
    "italy": "monza", "belgium": "spa", "japan": "suzuka", "china": "shanghai", "bahrain": "bahrain",
    "saudi": "jeddah", "saudi arabia": "jeddah", "azerbaijan": "baku", "germany": "hockenheimring",
    "hockenheim": "hockenheimring", "france": "ricard", "paul ricard": "ricard", "turkey": "istanbul",
    "russia": "sochi", "malaysia": "sepang", "portugal": "portimao", "korea": "yeongam",
    "india": "buddh", "nurburg": "nurburgring", "emilia romagna": "imola", "tuscany": "mugello",
}

PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"]


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode()
    return "".join(ch for ch in s.lower() if ch.isalnum() or ch == " ").strip()


@dataclass
class EntryBreakdown:
    driver_ref: str
    driver_name: str
    code: str
    car_key: str
    car_label: str
    year: int
    era_key: str
    era_name: str
    skill: float
    affinity: float
    affinity_source: str
    age_effect: float
    age_note: str
    experience_effect: float
    car: float
    privateer_offset: float
    wet: float
    crash_ratio: float
    mech_rate: float
    notes: list = field(default_factory=list)

    @property
    def driver_units(self) -> float:
        return self.skill + self.affinity + self.age_effect + self.experience_effect

    @property
    def car_units(self) -> float:
        return self.car + self.privateer_offset

    @property
    def total(self) -> float:
        return self.driver_units + self.car_units

    @property
    def label(self) -> str:
        return f"{self.driver_name} · {self.car_label}"

    def as_dict(self, pct_per_unit: float) -> dict:
        d = {k: getattr(self, k) for k in (
            "driver_name", "car_label", "era_name", "skill", "affinity", "affinity_source",
            "age_effect", "age_note", "experience_effect", "car", "privateer_offset", "wet",
            "crash_ratio", "mech_rate")}
        d["driver_units"] = self.driver_units
        d["car_units"] = self.car_units
        d["total"] = self.total
        d["pace_pct"] = -self.total * pct_per_unit
        return d


class Model:
    def __init__(self, ratings_path: Path | str = RATINGS_JSON, tracks_path: Path | str = TRACKS_JSON):
        r = json.loads(Path(ratings_path).read_text(encoding="utf-8"))
        t = json.loads(Path(tracks_path).read_text(encoding="utf-8"))
        self.meta = r["meta"]
        self.drivers: dict = r["drivers"]
        self.cars: dict = r["cars"]
        self.tracks: dict = t["tracks"]
        self.track_meta = t["meta"]
        self.age_curve = r["age_curve"]
        self.exp_curve = r["experience_curve"]
        self.era_sim = np.array(r["era_similarity"])
        self.pct_per_unit = float(self.meta["calibration"]["pct_per_unit"])
        modern = [c["mech_rate"] for c in self.cars.values() if 2022 <= c["year"] <= 2025]
        self.modern_mech = float(np.median(modern)) if modern else 0.06
        self._build_indexes()

    # ------------------------------------------------------------------ lookups
    def _build_indexes(self):
        self._names, self._forenames = {}, {}
        for ref, d in self.drivers.items():
            for key in {_norm(d["name"]), _norm(ref.replace("_", " ")), _norm(d["name"].split()[-1])}:
                self._names.setdefault(key, []).append(ref)
            self._forenames.setdefault(_norm(d["name"].split()[0]), []).append(ref)
        self._teams = {}
        for key, c in self.cars.items():
            for k in {_norm(c["team"]), _norm(c["team_ref"].replace("_", " ")),
                      _norm(c["team"]).replace(" ", "")}:
                self._teams.setdefault(k, set()).add(c["team_ref"])

    def find_driver(self, query: str) -> tuple[str, list[str]]:
        """Return (driver_ref, notes). Ambiguous surnames pick the driver with the most starts."""
        q = _norm(query)
        if query in self.drivers:
            return query, []
        hits = self._names.get(q) or self._forenames.get(q)
        if not hits:
            close = difflib.get_close_matches(q, list(self._names), n=5, cutoff=0.75)
            if not close:
                raise LookupError(f"No driver matches '{query}'.")
            hits = self._names[close[0]]
        hits = sorted(set(hits), key=lambda r: -self.drivers[r]["starts"])
        notes = []
        if len(hits) > 1:
            others = ", ".join(self.drivers[h]["name"] for h in hits[1:4])
            notes.append(f"'{query}' matched {self.drivers[hits[0]]['name']} "
                         f"(also possible: {others}; use the full name to pick another).")
        return hits[0], notes

    def find_track(self, query: str) -> str:
        if query in self.tracks:
            return query
        q = _norm(query)
        if q in TRACK_ALIASES:
            return TRACK_ALIASES[q]
        best, score = None, 0.0
        for ref, t in self.tracks.items():
            for cand in (ref.replace("_", " "), t["name"], t["locality"], t["country"], t["grand_prix"],
                         t["grand_prix"].replace(" Grand Prix", "")):
                c = _norm(cand)
                s = 1.0 if c == q else (0.9 if q and q in c.split() else
                                       difflib.SequenceMatcher(None, q, c).ratio())
                if s > score:
                    best, score = ref, s
        if score < 0.6:
            raise LookupError(f"No circuit matches '{query}'. Try one of: {', '.join(sorted(self.tracks))}")
        return best

    def find_team(self, query: str) -> set:
        """All constructor refs matching a team name ("Lotus" also matches Lotus-Climax, Team Lotus...)."""
        q = _norm(query)
        qs = q.replace(" ", "")
        hits = set()
        for k, refs in self._teams.items():
            ks = k.replace(" ", "")
            if ks == qs or ks.startswith(qs) or (len(qs) >= 4 and qs in ks):
                hits |= refs
        if hits:
            return hits
        close = difflib.get_close_matches(q, list(self._teams), n=1, cutoff=0.7)
        if not close:
            raise LookupError(f"No team matches '{query}'.")
        return self._teams[close[0]]

    def cars_in_year(self, year: int) -> list[str]:
        ks = [k for k, c in self.cars.items() if c["year"] == int(year)]
        return sorted(ks, key=lambda k: -self.cars[k]["rating"])

    def car_label(self, key: str) -> str:
        c = self.cars[key]
        return f"{c['team']} {c['year']}"

    def resolve_car(self, driver_ref: str, year: int, team: str | None = None) -> tuple[str, list[str]]:
        year = int(year)
        notes = []
        if team:
            refs = self.find_team(team)
            keys = [f"{r}@{year}" for r in refs if f"{r}@{year}" in self.cars]
            if not keys:
                raise LookupError(f"{team} did not race in {year}.")
            return max(keys, key=lambda k: self.cars[k]["starts"]), notes
        d = self.drivers[driver_ref]
        teams = d["teams_by_year"].get(str(year))
        if teams:
            return f"{teams[0]}@{year}", notes
        keys = self.cars_in_year(year)
        if not keys:
            raise LookupError(f"No cars in the data for {year}.")
        notes.append(f"{d['name']} didn't race in {year}; giving them the best {year} car "
                     f"({self.car_label(keys[0])}). Pick a team to change it.")
        return keys[0], notes

    # ------------------------------------------------------------------ ratings
    def _age_effect(self, driver_ref: str, year: int, peak: bool = False) -> tuple[float, str]:
        d = self.drivers[driver_ref]
        eff = self.age_curve["effects"]
        if not peak and str(year) in d["starts_by_year"] and d.get("dob"):
            age = (date(int(year), 7, 1) - date.fromisoformat(d["dob"])).days / 365.25
            edges = self.age_curve["edges"]
            b = int(np.searchsorted(edges, age, side="right") - 1)
            b = min(max(b, 0), len(eff) - 1)
            return float(eff[b]), f"age {age:.0f} in {year}"
        bins = d.get("age_bins") or list(range(len(eff)))
        b = max(bins, key=lambda i: eff[i])
        return float(eff[b]), f"at their peak (age {self.age_curve['labels'][b]})"

    def _experience_effect(self, driver_ref: str, year: int, peak: bool = False) -> float:
        d = self.drivers[driver_ref]
        sby = d["starts_by_year"]
        eff = self.exp_curve["effects"]
        if peak or str(year) not in sby:
            return float(max(eff))
        before = sum(v for y, v in sby.items() if int(y) < int(year)) + sby[str(year)] / 2
        b = int(np.searchsorted(self.exp_curve["edges"], before, side="right") - 1)
        return float(eff[min(max(b, 0), len(eff) - 1)])

    def affinity(self, driver_ref: str, era_key: str) -> tuple[float, str]:
        d = self.drivers[driver_ref]
        if era_key in d["eras"]:
            a = d["eras"][era_key]
            return float(a["affinity"]), f"raced {a['starts']} GPs in this era"
        keys = list(E.ERA_KEYS)
        j = keys.index(era_key)
        num, den, best = 0.0, 0.5, []
        for k, a in d["eras"].items():
            i = keys.index(k)
            conf = a["starts"] / (a["starts"] + 20)
            wgt = self.era_sim[j, i] * conf
            num += wgt * a["affinity"]
            den += wgt
            best.append((self.era_sim[j, i], E.ERAS[i].name))
        best.sort(reverse=True)
        src = "estimated from similar eras"
        if best:
            src += f"; closest: {best[0][1]}, similarity {best[0][0]:.2f}"
        return float(num / den), src

    def entry(self, driver: str, year: int, team: str | None = None,
              same_car: str | None = None, peak: bool = False) -> EntryBreakdown:
        """Build one entry. ``peak=True`` uses the driver's best age/experience instead of their
        real age in that season."""
        ref, notes = self.find_driver(driver)
        d = self.drivers[ref]
        if same_car:
            car_key = same_car
        else:
            car_key, n2 = self.resolve_car(ref, year, team)
            notes += n2
        c = self.cars[car_key]
        car_year = int(c["year"])
        era = E.era_for_year(car_year)
        aff, src = self.affinity(ref, era.key)
        age_eff, age_note = self._age_effect(ref, car_year, peak)
        return EntryBreakdown(
            driver_ref=ref, driver_name=d["name"], code=d.get("code") or ref[:3].upper(),
            car_key=car_key, car_label=self.car_label(car_key), year=car_year,
            era_key=era.key, era_name=f"{era.name} ({era.start}-{min(era.end, 2026)})",
            skill=float(d["skill"]), affinity=aff, affinity_source=src,
            age_effect=age_eff, age_note=age_note,
            experience_effect=self._experience_effect(ref, car_year, peak),
            car=float(c["rating"]), privateer_offset=float(c.get("entries", {}).get(ref, 0.0)),
            wet=float(d["wet"]), crash_ratio=float(np.clip(d["crash_ratio"], 0.5, 1.8)),
            mech_rate=float(c["mech_rate"]), notes=notes)

    # ------------------------------------------------------------------ sim inputs
    def sim_entries(self, breakdowns: list[EntryBreakdown], reliability: str = "era") -> list[SimEntry]:
        out = []
        seen = {}
        for i, b in enumerate(breakdowns):
            key = f"{b.driver_ref}@{b.car_key}"
            seen[key] = seen.get(key, 0) + 1
            if seen[key] > 1:
                key += f"#{seen[key]}"
            mech = {"era": b.mech_rate, "modern": self.modern_mech, "off": 0.0}[reliability]
            out.append(SimEntry(key=key, label=b.label, short=b.code, driver_units=b.driver_units,
                                car_units=b.car_units, wet_units=b.wet, crash_mult=b.crash_ratio,
                                mech_rate=mech, is_user=True, color=PALETTE[i % len(PALETTE)],
                                car_id=b.car_key))
        return out

    def field_entries(self, n: int, seed: int = 0, year: int | None = None,
                      exclude: set | None = None, reliability: str = "era") -> list[SimEntry]:
        """Other cars on the grid: a real season's grid (``year``) or anonymous average cars."""
        exclude = exclude or set()
        out = []
        if year:
            keys = self.cars_in_year(year)
            for ck in keys:
                for dref in self.cars[ck]["drivers"][:2]:
                    if dref in exclude or len(out) >= n:
                        continue
                    b = self.entry(dref, year, same_car=ck)
                    mech = {"era": b.mech_rate, "modern": self.modern_mech, "off": 0.0}[reliability]
                    out.append(SimEntry(key=f"field:{dref}", label=b.label, short=b.code,
                                        driver_units=b.driver_units, car_units=b.car_units,
                                        wet_units=b.wet, crash_mult=b.crash_ratio, mech_rate=mech,
                                        is_user=False, car_id=ck))
            return out
        f = self.meta["field"]
        rng = np.random.default_rng(seed)
        cars = rng.normal(f["car_mean"], f["car_sd"], (n + 1) // 2)
        for i in range(n):
            out.append(SimEntry(
                key=f"field:{i + 1}", label=f"Field car {i + 1}", short=f"F{i + 1:02d}",
                driver_units=float(rng.normal(f["driver_mean"], f["driver_sd"])),
                car_units=float(cars[i // 2]), wet_units=0.0, crash_mult=1.0,
                mech_rate=0.0 if reliability == "off" else self.modern_mech, is_user=False,
                car_id=f"field-car-{i // 2}"))
        return out


@lru_cache(maxsize=2)
def load_model(ratings_path: str = str(RATINGS_JSON), tracks_path: str = str(TRACKS_JSON)) -> Model:
    return Model(ratings_path, tracks_path)
