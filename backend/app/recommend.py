"""Recommendations (RFC §6): content-based cosine similarity between the
user's `profiles` taste vector and each song's aggregate feature vector.

Deliberately NOT a trained model -- at a ~50-track catalog, content-based
similarity is the correct engineering choice, not just the faster one.
Songs already reacted to are excluded (returned separately as `already_heard`).
"""
from __future__ import annotations

import math
from typing import Any

from . import db
from .profiles import NUMERIC_KEYS, song_tags

TAG_TERM_WEIGHT = 0.25  # llm_tags overlap layered on top of the numeric cosine


def song_aggregate_vector(song: dict[str, Any]) -> dict[str, float] | None:
    feats = song.get("features") or {}

    def mean(curve: list[float] | None) -> float:
        return (sum(curve) / len(curve)) if curve else 0.0

    tempo = feats.get("tempo_bpm")
    vec = {
        "energy": mean(feats.get("energy_curve")),
        "brightness": mean(feats.get("spectral_brightness_curve")),
        "onset_density": mean(feats.get("onset_density_curve")),
        "tempo_norm": (float(tempo) / 200.0) if tempo else 0.0,
    }
    return vec if any(v != 0.0 for v in vec.values()) else None


def cosine(a: dict[str, float], b: dict[str, float]) -> float:
    dot = sum(a[k] * b[k] for k in NUMERIC_KEYS)
    na = math.sqrt(sum(a[k] ** 2 for k in NUMERIC_KEYS))
    nb = math.sqrt(sum(b[k] ** 2 for k in NUMERIC_KEYS))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def tag_affinity(profile_tags: dict[str, float], song: dict[str, Any]) -> float:
    tags = song_tags(song)
    if not tags or not profile_tags:
        return 0.0
    score = sum(profile_tags.get(t, 0.0) for t in tags) / len(tags)
    return max(-1.0, min(1.0, score * 4.0))  # tag weights are small; rescale


def recommend(
    user_id: str,
    genre_filter: list[str] | None = None,
    limit: int = 10,
) -> dict[str, Any]:
    profile = db.profiles.find_one({"user_id": user_id})
    if not profile or not profile.get("vector"):
        return {"recommendations": [], "already_heard": [], "reason": "no profile yet"}

    heard_ids = db.reactions.distinct("meta.song_id", {"meta.user_id": user_id})
    taste = profile["vector"]
    profile_tags = profile.get("tags") or {}

    fresh: list[dict[str, Any]] = []
    heard: list[dict[str, Any]] = []
    for song in db.songs.find({}):
        vec = song_aggregate_vector(song)
        if vec is None:
            continue
        if genre_filter:
            tags = set(song_tags(song))
            if not tags.intersection({g.lower() for g in genre_filter}):
                continue
        score = cosine(taste, vec) + TAG_TERM_WEIGHT * tag_affinity(profile_tags, song)
        entry = {
            "song_id": song["_id"],
            "title": song.get("title"),
            "artist": song.get("artist"),
            "score": round(score, 4),
            "spotify_uri": song.get("spotify_uri"),
            "llm_tags": song.get("llm_tags"),
        }
        (heard if song["_id"] in heard_ids else fresh).append(entry)

    fresh.sort(key=lambda e: e["score"], reverse=True)
    heard.sort(key=lambda e: e["score"], reverse=True)
    return {
        "recommendations": fresh[:limit],
        "already_heard": heard[:limit],  # "you'd probably still like this" path
    }
