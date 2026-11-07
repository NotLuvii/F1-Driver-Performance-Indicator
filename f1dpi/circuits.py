"""Circuit outlines for the website's race replay.

Source: bacinger/f1-circuits (MIT licence, (c) 2019-2025 Tomislav Bacinger), GeoJSON line strings
of each circuit's racing line. Download it with:

    curl -L -o data/raw/f1-circuits.geojson https://raw.githubusercontent.com/bacinger/f1-circuits/master/f1-circuits.geojson

then run ``python -m f1dpi.circuits`` to write docs/data/circuits.json: each circuit projected to a flat
plane (north up), scaled into a 1000-unit box and resampled to evenly spaced points, starting at the
start/finish line in the racing direction.
"""
from __future__ import annotations

import json
import math

from .paths import DATA_DIR, ROOT

GEOJSON = DATA_DIR / "raw" / "f1-circuits.geojson"
OUT = ROOT / "docs" / "data" / "circuits.json"
POINTS = 400

# our circuit refs (Jolpica) -> bacinger ids
IDS = {
    "albert_park": "au-1953", "bahrain": "bh-2002", "shanghai": "cn-2004", "catalunya": "es-1991",
    "monaco": "mc-1929", "villeneuve": "ca-1978", "ricard": "fr-1969", "red_bull_ring": "at-1969",
    "silverstone": "gb-1948", "hockenheimring": "de-1932", "hungaroring": "hu-1986", "spa": "be-1925",
    "monza": "it-1922", "marina_bay": "sg-2008", "sochi": "ru-2014", "suzuka": "jp-1962",
    "americas": "us-2012", "rodriguez": "mx-1962", "interlagos": "br-1940", "yas_marina": "ae-2009",
    "imola": "it-1953", "nurburgring": "de-1927", "portimao": "pt-2008", "mugello": "it-1914",
    "sepang": "my-1999", "istanbul": "tr-2005", "zandvoort": "nl-1948", "magny_cours": "fr-1960",
    "jeddah": "sa-2021", "miami": "us-2022", "losail": "qa-2004", "madring": "es-2026",
    "baku": "az-2016", "vegas": "us-2023", "indianapolis": "us-1909",
}


def _resample(pts: list, n: int) -> list:
    """Evenly spaced points along a closed polyline."""
    if pts[0] != pts[-1]:
        pts = pts + [pts[0]]
    seg = [math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
    total = sum(seg)
    out, j, acc = [], 0, 0.0
    for k in range(n):
        target = total * k / n
        while j < len(seg) - 1 and acc + seg[j] < target:
            acc += seg[j]
            j += 1
        f = (target - acc) / seg[j] if seg[j] else 0.0
        a, b = pts[j], pts[j + 1]
        out.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
    return out


def build() -> dict:
    g = json.loads(GEOJSON.read_text(encoding="utf-8"))
    by_id = {f["properties"]["id"]: f for f in g["features"]}
    out = {}
    for ref, cid in IDS.items():
        f = by_id.get(cid)
        if not f:
            continue
        coords = f["geometry"]["coordinates"]
        lat0 = sum(c[1] for c in coords) / len(coords)
        k = math.cos(math.radians(lat0))
        pts = [(c[0] * k, -c[1]) for c in coords]
        pts = _resample(pts, POINTS)
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        span = max(max(xs) - min(xs), max(ys) - min(ys))
        s = 1000 / span
        pts = [((x - min(xs)) * s, (y - min(ys)) * s) for x, y in pts]
        w = (max(xs) - min(xs)) * s
        h = (max(ys) - min(ys)) * s
        out[ref] = {"w": round(w, 1), "h": round(h, 1), "length_m": f["properties"].get("length"),
                    "points": [[round(x, 1), round(y, 1)] for x, y in pts]}
    return {"source": "bacinger/f1-circuits (MIT licence, (c) 2019-2025 Tomislav Bacinger)",
            "circuits": out}


def main():
    data = build()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT}: {len(data['circuits'])} circuits ({OUT.stat().st_size / 1e3:.0f} kB)")


if __name__ == "__main__":
    main()
