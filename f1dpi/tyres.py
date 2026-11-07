"""Tyre model and pit-strategy optimiser.

Lap-time cost of a tyre (seconds, for a 90 s reference lap; scaled to the real lap length):

    compound offset + wear_rate * age + cliff penalty once the tyre is past its life

``wear`` multiplies the wear rate and shortens the life. It combines the circuit's tyre wear,
the day's conditions and each car's own (random) appetite for tyres.
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from itertools import product

import numpy as np

REF_LAP = 90.0


@dataclass(frozen=True)
class Compound:
    code: str
    name: str
    offset: float      # s/lap slower than soft on a fresh tyre
    wear: float        # s/lap added per lap of age
    life: float        # laps before the cliff
    wet: bool = False


COMPOUNDS = {
    "S": Compound("S", "Soft", 0.00, 0.100, 15),
    "M": Compound("M", "Medium", 0.40, 0.055, 27),
    "H": Compound("H", "Hard", 0.75, 0.035, 40),
    "I": Compound("I", "Intermediate", 0.00, 0.040, 35, wet=True),
    "W": Compound("W", "Full wet", 0.00, 0.030, 45, wet=True),
}
DRY = ("S", "M", "H")
CLIFF_COEF = 0.12     # s added per lap^2 beyond the cliff


def stint_cost(code: str, n: int, wear: float, scale: float = 1.0) -> float:
    """Total extra time (s) of an n-lap stint on a compound, relative to a fresh soft."""
    c = COMPOUNDS[code]
    ages = np.arange(n)
    life = c.life / wear
    extra = c.offset + c.wear * wear * ages + CLIFF_COEF * np.clip(ages - life, 0, None) ** 2
    return float(extra.sum() * scale)


def lap_cost(code: str, age: int, wear: float, scale: float = 1.0) -> float:
    c = COMPOUNDS[code]
    life = c.life / wear
    over = max(0.0, age - life)
    return (c.offset + c.wear * wear * age + CLIFF_COEF * over * over) * scale


def weather_penalty(code: str, wetness: float) -> float:
    """Fraction of lap time lost for running this tyre at this track wetness (0 = dry, 1 = soaked)."""
    w = wetness
    if code in DRY:
        return max(0.0, w - 0.12) * 0.40
    if code == "I":
        return 0.06 * max(0.0, 0.45 - w) / 0.45 + 0.10 * max(0.0, w - 0.70) / 0.30
    return 0.02 + 0.10 * max(0.0, 0.75 - w) / 0.75     # full wet


def best_tyre_for(wetness: float) -> str:
    """The compound class that is fastest at this wetness ('S' stands for 'slicks')."""
    return min(("S", "I", "W"), key=lambda c: weather_penalty(c, wetness))


WEAR_BUCKETS = np.geomspace(0.45, 2.4, 17)


def wear_bucket(wear: float) -> int:
    return int(np.argmin(np.abs(np.log(WEAR_BUCKETS) - np.log(wear))))


@lru_cache(maxsize=200_000)
def _cum_costs(code: str, bucket: int, laps: int) -> np.ndarray:
    """cum[n] = cost of an n-lap stint (n = 0..laps), at reference scale."""
    wear = WEAR_BUCKETS[bucket]
    c = COMPOUNDS[code]
    ages = np.arange(laps)
    life = c.life / wear
    extra = c.offset + c.wear * wear * ages + CLIFF_COEF * np.clip(ages - life, 0, None) ** 2
    return np.concatenate([[0.0], np.cumsum(extra)])


@dataclass(frozen=True)
class Plan:
    stints: tuple            # ((compound, laps), ...)
    cost: float              # seconds incl. pit losses, reference scale

    @property
    def stops(self) -> int:
        return len(self.stints) - 1


@lru_cache(maxsize=200_000)
def optimise(laps: int, bucket: int, pit_loss_ref: float, used: str = "", min_stint: int = 4,
             max_stops: int = 3) -> tuple:
    """All sensible plans for the remaining ``laps``, best first.

    ``used`` is the set of dry compounds already run this race (as a string). The two-compound
    rule is satisfied when the race as a whole uses at least two different dry compounds; pass
    used="*" when the rule no longer applies (wet tyres have been used).
    """
    plans = []
    rule_waived = used == "*"
    for k in range(1, max_stops + 2):          # number of stints
        if k == 1 and laps > 45:
            continue
        for seq in product(DRY, repeat=k):
            if not rule_waived and len(set(seq) | set(used)) < 2:
                continue
            if k * min_stint > laps:
                continue
            cums = [_cum_costs(c, bucket, laps) for c in seq]
            if k == 1:
                plans.append(Plan(((seq[0], laps),), float(cums[0][laps])))
            elif k == 2:
                n1 = np.arange(min_stint, laps - min_stint + 1)
                cost = cums[0][n1] + cums[1][laps - n1]
                i = int(np.argmin(cost))
                plans.append(Plan(((seq[0], int(n1[i])), (seq[1], laps - int(n1[i]))),
                                  float(cost[i] + pit_loss_ref)))
            elif k == 3:
                n1 = np.arange(min_stint, laps - 2 * min_stint + 1)[:, None]
                n2 = np.arange(min_stint, laps - 2 * min_stint + 1)[None, :]
                n3 = laps - n1 - n2
                ok = n3 >= min_stint
                cost = np.where(ok, cums[0][n1] + cums[1][n2] + cums[2][np.clip(n3, 0, laps)], np.inf)
                i, j = np.unravel_index(int(np.argmin(cost)), cost.shape)
                a, b = int(n1[i, 0]), int(n2[0, j])
                plans.append(Plan(((seq[0], a), (seq[1], b), (seq[2], laps - a - b)),
                                  float(cost[i, j] + 2 * pit_loss_ref)))
            else:  # 4 stints: split evenly-ish around the 3-stint optimum (rarely best)
                base = laps // k
                lens = [base] * k
                lens[-1] += laps - base * k
                cost = sum(cums[i2][n] for i2, n in enumerate(lens)) + (k - 1) * pit_loss_ref
                plans.append(Plan(tuple(zip(seq, lens)), float(cost)))
    plans.sort(key=lambda p: p.cost)
    return tuple(plans[:12])


def choose_plan(laps: int, wear: float, pit_loss: float, scale: float, used: str, rng,
                spread: float = 2.5) -> Plan:
    """Pick a strategy: usually the optimum, sometimes a near-optimal alternative (teams differ)."""
    plans = optimise(laps, wear_bucket(wear), round(pit_loss / scale, 1), used)
    if not plans:
        return Plan((("H", laps),), 0.0)
    costs = np.array([p.cost for p in plans]) * scale
    weights = np.exp(-(costs - costs.min()) / spread)
    return plans[int(rng.choice(len(plans), p=weights / weights.sum()))]
