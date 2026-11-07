"""Download the Jolpica F1 database dump (CSV) into data/raw/.

    python -m f1dpi.download
"""
from __future__ import annotations

import sys
import urllib.request

from .paths import RAW_ZIP

URL = "https://api.jolpi.ca/data/dumps/download/delayed/?dump_type=csv"


def main(url: str = URL) -> None:
    RAW_ZIP.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {url} ...")
    req = urllib.request.Request(url, headers={"User-Agent": "f1dpi/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r, open(RAW_ZIP, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    print(f"Saved {RAW_ZIP} ({RAW_ZIP.stat().st_size / 1e6:.1f} MB). "
          "Now run `python -m f1dpi build` to refit the ratings.")


if __name__ == "__main__":
    main(*sys.argv[1:])
