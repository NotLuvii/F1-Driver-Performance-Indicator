from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
RAW_ZIP = DATA_DIR / "raw" / "jolpica-f1-csv.zip"
MODEL_DIR = ROOT / "model"
RATINGS_JSON = MODEL_DIR / "ratings.json"
TRACKS_JSON = MODEL_DIR / "tracks.json"
