"""Lightweight trained model for preference prediction.

This is intentionally small: per user, fit a ridge regression from song-moment
features to observed arousal. It sits beside the stable content recommender and
only contributes when the user has enough reaction data.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from . import db
from .profiles import NUMERIC_KEYS, song_moment_vector

MIN_TRAINING_ROWS = 20
RIDGE_ALPHA = 0.25


@dataclass
class ArousalModel:
    weights: np.ndarray
    mean: np.ndarray
    std: np.ndarray
    n_rows: int


def _feature_array(moment: dict[str, float]) -> list[float]:
    return [float(moment[k]) for k in NUMERIC_KEYS]


def train_user_arousal_model(user_id: str) -> ArousalModel | None:
    """Fit arousal ~= f(song features at the exact listened second)."""
    rows = db.reactions.find(
        {"meta.user_id": user_id, "arousal": {"$ne": None}},
        {"meta.song_id": 1, "t": 1, "arousal": 1},
    )
    song_cache: dict[str, dict[str, Any] | None] = {}
    xs: list[list[float]] = []
    ys: list[float] = []

    for r in rows:
        song_id = r["meta"]["song_id"]
        if song_id not in song_cache:
            song_cache[song_id] = db.songs.find_one({"_id": song_id})
        song = song_cache[song_id]
        if not song:
            continue
        moment = song_moment_vector(song, int(r["t"]))
        if not moment:
            continue
        xs.append(_feature_array(moment))
        ys.append(float(r["arousal"]))

    if len(xs) < MIN_TRAINING_ROWS:
        return None

    x = np.asarray(xs, dtype=float)
    y = np.asarray(ys, dtype=float)
    mean = x.mean(axis=0)
    std = x.std(axis=0)
    std[std == 0] = 1.0
    z = (x - mean) / std
    design = np.column_stack([np.ones(len(z)), z])

    penalty = np.eye(design.shape[1]) * RIDGE_ALPHA
    penalty[0, 0] = 0.0  # do not penalize intercept
    weights = np.linalg.solve(design.T @ design + penalty, design.T @ y)
    return ArousalModel(weights=weights, mean=mean, std=std, n_rows=len(xs))


def predict_song_arousal(model: ArousalModel, song: dict[str, Any]) -> float | None:
    """Average predicted arousal across the song's feature curve."""
    duration = int(song.get("duration_s") or 0)
    if duration <= 0:
        duration = max(
            len((song.get("features") or {}).get("energy_curve") or []),
            len((song.get("features") or {}).get("spectral_brightness_curve") or []),
            len((song.get("features") or {}).get("onset_density_curve") or []),
        )
    if duration <= 0:
        return None

    preds: list[float] = []
    for t in range(duration):
        moment = song_moment_vector(song, t)
        if not moment:
            continue
        x = np.asarray(_feature_array(moment), dtype=float)
        z = (x - model.mean) / model.std
        row = np.concatenate([[1.0], z])
        preds.append(float(row @ model.weights))

    if not preds:
        return None
    return round(float(np.clip(np.mean(preds), 0.0, 1.0)), 4)
