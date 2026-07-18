"""MongoDB collections per RFC §4.

- `songs`: static, seeded offline by scripts/extract_features.py.
- `reactions`: a **time-series collection** (timeField `ts`, metaField `meta`,
  seconds granularity) -- one document per (user, song, second, source).
- `profiles`: derived taste vector per user, recomputed on every reaction batch.
"""
import logging

from pymongo import MongoClient
from pymongo.errors import CollectionInvalid

from . import config

log = logging.getLogger("museic.db")

_client = MongoClient(config.MONGODB_URI)
db = _client[config.MONGODB_DB]


def ensure_collections() -> None:
    """Create the reactions time-series collection and indexes (idempotent)."""
    try:
        db.create_collection(
            "reactions",
            timeseries={
                "timeField": "ts",
                "metaField": "meta",
                "granularity": "seconds",
            },
        )
        log.info("created time-series collection 'reactions'")
    except CollectionInvalid:
        pass  # already exists

    db["reactions"].create_index([("meta.user_id", 1), ("meta.song_id", 1), ("t", 1)])
    db["profiles"].create_index("user_id", unique=True)


songs = db["songs"]
reactions = db["reactions"]
profiles = db["profiles"]
