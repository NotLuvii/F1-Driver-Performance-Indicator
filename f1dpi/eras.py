"""Formula 1 car generations ("eras") and how similar they are to each other.

Each era is a block of seasons with broadly the same technical rules. Every era gets a small
feature vector describing what the cars were like to drive. Drivers who never raced in an era
get an affinity for it estimated from the eras they did race in, weighted by how similar the
cars were (for example, 1977-82 ground-effect cars are close to the 2022-25 ground-effect cars).

Feature values are on a 0-1 scale. They're hand-assigned summaries of each rule set, documented
here so you can argue with them and change them.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

FEATURES = (
    "downforce",        # aerodynamic grip
    "ground_effect",    # underbody/venturi downforce, very sensitive to ride height
    "power",            # peak power relative to the heaviest-hitting era (80s turbos)
    "energy_mgmt",      # turbo boost / fuel / hybrid energy management demands
    "driver_aids",      # traction control, launch control, active suspension
    "refuelling",       # sprint-to-stop racing on light fuel loads
    "tyre_mgmt",        # high-degradation tyres that must be nursed
    "manual_gearbox",   # H-pattern manual shifting
    "danger",           # how lethal mistakes were; rewarded raw commitment
    "weight",           # car mass (heavier = lazier change of direction)
)


@dataclass(frozen=True)
class Era:
    key: str
    name: str
    start: int
    end: int
    features: tuple
    blurb: str

    def contains(self, year: int) -> bool:
        return self.start <= year <= self.end


#                         downf  GE   power energy aids refuel tyre manual danger weight
ERAS: tuple[Era, ...] = (
    Era("1950", "Post-war front-engine", 1950, 1953,
        (0.00, 0.0, 0.40, 0.10, 0.0, 0.0, 0.40, 1.0, 1.00, 0.60),
        "Supercharged 1.5 L and 4.5 L front-engined cars on skinny treaded tyres."),
    Era("1954", "2.5 L front-engine", 1954, 1960,
        (0.00, 0.0, 0.30, 0.00, 0.0, 0.0, 0.40, 1.0, 1.00, 0.55),
        "The Fangio/Moss years; rear-engined Coopers took over by the end of it."),
    Era("1961", "1.5 L rear-engine", 1961, 1965,
        (0.05, 0.0, 0.10, 0.00, 0.0, 0.0, 0.35, 1.0, 0.95, 0.15),
        "Light, low-power, slippery cars where momentum was everything."),
    Era("1966", "3.0 L, wings arrive", 1966, 1976,
        (0.30, 0.0, 0.45, 0.00, 0.0, 0.0, 0.40, 1.0, 0.90, 0.30),
        "The 'return to power', then wings (1968) and slick tyres (1971)."),
    Era("1977", "Ground-effect wing cars", 1977, 1982,
        (0.80, 1.0, 0.55, 0.10, 0.0, 0.05, 0.35, 1.0, 0.80, 0.30),
        "Venturi tunnels and sliding skirts: huge cornering speeds and rock-hard suspension."),
    Era("1983", "Turbo flat-bottom", 1983, 1988,
        (0.55, 0.0, 1.00, 0.70, 0.0, 0.10, 0.35, 1.0, 0.55, 0.35),
        "1000+ hp qualifying turbos, boost and fuel-consumption management."),
    Era("1989", "Naturally aspirated + electronics", 1989, 1994,
        (0.60, 0.0, 0.70, 0.10, 0.55, 0.15, 0.30, 0.40, 0.45, 0.30),
        "3.5 L V8/V10/V12, semi-automatic gearboxes, active suspension peaking in 1992-93."),
    Era("1995", "3.0 L V10 slicks", 1995, 1997,
        (0.60, 0.0, 0.65, 0.00, 0.15, 1.0, 0.30, 0.0, 0.30, 0.35),
        "Smaller engines, refuelling strategy racing, last of the slick tyres."),
    Era("1998", "Grooved-tyre V10", 1998, 2005,
        (0.70, 0.0, 0.85, 0.00, 0.65, 1.0, 0.20, 0.0, 0.25, 0.35),
        "Narrow cars, grooved tyres, a tyre war and (from 2001) traction control."),
    Era("2006", "2.4 L V8 refuelling", 2006, 2008,
        (0.75, 0.0, 0.70, 0.00, 0.55, 1.0, 0.30, 0.0, 0.20, 0.35),
        "V8s, aero-heavy cars; traction control banned for 2008."),
    Era("2009", "V8, KERS and Pirelli", 2009, 2013,
        (0.75, 0.0, 0.70, 0.25, 0.0, 0.20, 0.80, 0.0, 0.15, 0.45),
        "Aero overhaul, no refuelling from 2010, exhaust-blown diffusers, high-deg Pirellis."),
    Era("2014", "Hybrid V6 turbo (narrow)", 2014, 2016,
        (0.70, 0.0, 0.80, 0.85, 0.0, 0.0, 0.80, 0.0, 0.10, 0.70),
        "1.6 L turbo hybrids with energy recovery; low downforce, lots of torque."),
    Era("2017", "Hybrid wide high-downforce", 2017, 2021,
        (1.00, 0.0, 0.90, 0.80, 0.0, 0.0, 0.60, 0.0, 0.10, 0.80),
        "Wider cars and tyres, the fastest F1 cars ever over a lap; dirty air hurt following."),
    Era("2022", "Ground-effect hybrid", 2022, 2025,
        (0.90, 1.0, 0.90, 0.80, 0.0, 0.0, 0.60, 0.0, 0.10, 1.00),
        "Venturi floors return; stiff, heavy cars that punish porpoising and bumps."),
    Era("2026", "Active aero, 50/50 hybrid", 2026, 2030,
        (0.75, 0.5, 0.90, 1.00, 0.0, 0.0, 0.60, 0.0, 0.10, 0.85),
        "Smaller, lighter cars with movable wings and roughly half the power from the battery."),
)

ERA_KEYS = tuple(e.key for e in ERAS)
_FEAT = np.array([e.features for e in ERAS], dtype=float)
# ground effect changes driving technique the most, so it gets extra weight when comparing eras
FEATURE_WEIGHTS = np.array([1.0, 1.5, 1.0, 1.0, 1.0, 0.7, 1.0, 1.0, 1.0, 0.8])


def era_for_year(year: int) -> Era:
    for e in ERAS:
        if e.contains(int(year)):
            return e
    return ERAS[-1] if year > ERAS[-1].end else ERAS[0]


def era_index(year: int) -> int:
    return ERA_KEYS.index(era_for_year(year).key)


def similarity_matrix(length_scale: float = 1.5) -> np.ndarray:
    """RBF similarity between eras on standardised features plus a gentle time term."""
    f = (_FEAT - _FEAT.mean(0)) / (_FEAT.std(0) + 1e-9)
    f = f * FEATURE_WEIGHTS
    mid = np.array([(e.start + e.end) / 2 for e in ERAS])
    t = ((mid - mid.mean()) / mid.std())[:, None] * 0.75
    x = np.hstack([f / np.sqrt(len(FEATURES)), t])
    d2 = ((x[:, None, :] - x[None, :, :]) ** 2).sum(-1)
    return np.exp(-d2 / (2 * length_scale ** 2))
