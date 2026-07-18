"""`profiles` collection (RFC §4): a derived taste vector per user.

Construction, exactly as specified: for each (song, second) where the user's
arousal exceeds their own recent average -- weighted by how far above, so
bigger spikes count more -- pull the song's feature vector at that moment
(energy / spectral brightness / onset density curves + tempo + llm_tags) and
fold it into a running weighted average, applying the valence sign so
consistently negative-valence spikes push tags/features AWAY rather than in.

Recomputed on every new batch of reactions. Weighted average, NO trained model.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from . import db

NUMERIC_KEYS = ("energy", "brightness", "onset_density", "tempo_norm")

# Consistently-negative moments count against, but weaker than positive
# moments count for (a wince shouldn't erase three head-bops).
NEGATIVE_VALENCE_FACTOR = -0.5


def _curve_at(curve: list[float] | None, t: int) -> float | None:
    if not curve:
        return None
    return float(curve[min(t, len(curve) - 1)])


def song_moment_vector(song: dict[str, Any], t: int) -> dict[str, float] | None:
    feats = song.get("features") or {}
    energy = _curve_at(feats.get("energy_curve"), t)
    brightness = _curve_at(feats.get("spectral_brightness_curve"), t)
    onset = _curve_at(feats.get("onset_density_curve"), t)
    tempo = feats.get("tempo_bpm")
    if energy is None and brightness is None and onset is None and tempo is None:
        return None
    return {
        "energy": energy or 0.0,
        "brightness": brightness or 0.0,
        "onset_density": onset or 0.0,
        "tempo_norm": (float(tempo) / 200.0) if tempo else 0.0,
    }


def song_tags(song: dict[str, Any]) -> list[str]:
    llm = song.get("llm_tags") or {}
    tags: list[str] = []
    tags += [t.lower() for t in llm.get("instruments") or []]
    tags += [t.lower() for t in llm.get("mood") or []]
    if llm.get("vocal_character"):
        tags.append(str(llm["vocal_character"]).lower())
    return tags


def rebuild_profile(user_id: str) -> dict[str, Any]:
    """Recompute the user's taste vector from all of their reactions."""
    rows = list(
        db.reactions.find(
            {"meta.user_id": user_id, "arousal": {"$ne": None}},
            {"meta": 1, "t": 1, "arousal": 1, "valence": 1, "quadrant": 1},
        )
    )
    if not rows:
        profile = {
            "user_id": user_id,
            "vector": None,
            "tags": {},
            "quadrant_counts": {},
            "mean_arousal": None,
            "mean_valence": None,
            "n_moments": 0,
            "updated_at": datetime.now(timezone.utc),
        }
        # $set (not replace) so cached narrative / peaks / refreshed_at survive.
        db.profiles.update_one({"user_id": user_id}, {"$set": profile}, upsert=True)
        return profile

    mean_arousal = sum(r["arousal"] for r in rows) / len(rows)
    valence_rows = [r["valence"] for r in rows if r.get("valence") is not None]
    mean_valence = (sum(valence_rows) / len(valence_rows)) if valence_rows else 0.0

    song_cache: dict[str, dict[str, Any] | None] = {}
    acc = {k: 0.0 for k in NUMERIC_KEYS}
    tag_weights: dict[str, float] = {}
    quadrant_counts: dict[str, int] = {}
    total_weight = 0.0
    n_moments = 0

    for r in rows:
        q = r.get("quadrant")
        if q:
            quadrant_counts[q] = quadrant_counts.get(q, 0) + 1

        excess = r["arousal"] - mean_arousal
        if excess <= 0:
            continue  # only above-own-average moments contribute
        song_id = r["meta"]["song_id"]
        if song_id not in song_cache:
            song_cache[song_id] = db.songs.find_one({"_id": song_id})
        song = song_cache[song_id]
        if not song:
            continue
        moment = song_moment_vector(song, int(r["t"]))
        if moment is None:
            continue

        # Bigger spikes count more; negative-valence spikes count against.
        sign = 1.0 if (r.get("valence") or 0.0) >= 0 else NEGATIVE_VALENCE_FACTOR
        w = excess * sign

        for k in NUMERIC_KEYS:
            acc[k] += moment[k] * w
        for tag in song_tags(song):
            tag_weights[tag] = tag_weights.get(tag, 0.0) + w
        total_weight += abs(w)
        n_moments += 1

    vector = (
        {k: round(acc[k] / total_weight, 4) for k in NUMERIC_KEYS}
        if total_weight > 0
        else None
    )
    # Keep the strongest tags only, normalised.
    top_tags = dict(
        sorted(tag_weights.items(), key=lambda kv: abs(kv[1]), reverse=True)[:24]
    )
    if top_tags and total_weight > 0:
        top_tags = {k: round(v / total_weight, 4) for k, v in top_tags.items()}

    profile = {
        "user_id": user_id,
        "vector": vector,
        "tags": top_tags,
        "quadrant_counts": quadrant_counts,
        "mean_arousal": round(mean_arousal, 4),
        "mean_valence": round(mean_valence, 4),
        "n_moments": n_moments,
        "updated_at": datetime.now(timezone.utc),
    }
    # $set (not replace) so cached narrative / peaks / refreshed_at survive.
    db.profiles.update_one({"user_id": user_id}, {"$set": profile}, upsert=True)
    return profile
