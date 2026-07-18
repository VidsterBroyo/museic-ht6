"""Recommendations (RFC §6): content similarity plus optional trained ML.

The stable base score is cosine similarity between the user's `profiles` taste
vector and each song's aggregate feature vector. Once enough reactions exist,
we also train a tiny per-user ridge model to predict arousal from song features
and blend that score in.
"""
from __future__ import annotations

import math
from typing import Any

from . import db, ml_model
from .profiles import NUMERIC_KEYS, song_tags

TAG_TERM_WEIGHT = 0.25  # llm_tags overlap layered on top of the numeric cosine
ML_TERM_WEIGHT = 0.35


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
    arousal_model = ml_model.train_user_arousal_model(user_id)

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
        similarity_score = cosine(taste, vec)
        tag_score = tag_affinity(profile_tags, song)
        ml_score = (
            ml_model.predict_song_arousal(arousal_model, song) if arousal_model else None
        )
        score = similarity_score + TAG_TERM_WEIGHT * tag_score
        if ml_score is not None:
            score += ML_TERM_WEIGHT * ml_score
        entry = {
            "song_id": song["_id"],
            "title": song.get("title"),
            "artist": song.get("artist"),
            "score": round(score, 4),
            "similarity_score": round(similarity_score, 4),
            "ml_score": ml_score,
            "spotify_uri": song.get("spotify_uri"),
            "llm_tags": song.get("llm_tags"),
        }
        (heard if song["_id"] in heard_ids else fresh).append(entry)

    fresh.sort(key=lambda e: e["score"], reverse=True)
    heard.sort(key=lambda e: e["score"], reverse=True)
    return {
        "recommendations": fresh[:limit],
        "already_heard": heard[:limit],  # "you'd probably still like this" path
        "ml": {
            "active": arousal_model is not None,
            "training_rows": arousal_model.n_rows if arousal_model else 0,
            "min_training_rows": ml_model.MIN_TRAINING_ROWS,
        },
    }
