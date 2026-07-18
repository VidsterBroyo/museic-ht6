"""Museic FastAPI backend -- all endpoints from RFC §6.

Identity: every request carries an Auth0 JWT; the `sub` claim is `user_id`.
Writes are always keyed to the caller's own sub (any user_id in the payload is
ignored). Reads (profile / song-graph / compare) are open to any authenticated
user -- required for the two-person compare demo on one laptop.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

import numpy as np
from fastapi import Body, Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import backboard, db, ml_model, recommend, signals, spotify
from .auth import current_user_id, raw_access_token, user_id_header_or_query
from .profiles import rebuild_profile

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("museic.api")

app = FastAPI(title="Museic API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # local desktop app; not an internet-facing deployment
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup() -> None:
    db.ensure_collections()


# ---------------------------------------------------------------------------
# Reactions ingest
# ---------------------------------------------------------------------------

class Reading(BaseModel):
    t: int = Field(ge=0, description="second offset into the song")
    raw: dict[str, Any] = Field(default_factory=dict)
    movement_intensity: float | None = None
    ts: datetime | None = None


class ReactionBatch(BaseModel):
    song_id: str
    source: str = "presage"  # "presage" | "muse" | "imu"
    readings: list[Reading]


def _session_hr_baseline(user_id: str) -> float | None:
    """Mean pulse over the user's last hour of readings -- the slow-trend
    baseline is continuous across the session, not reset per song (§5)."""
    since = datetime.now(timezone.utc) - timedelta(hours=1)
    rows = db.reactions.find(
        {"meta.user_id": user_id, "ts": {"$gte": since}, "raw.hr_bpm": {"$ne": None}},
        {"raw.hr_bpm": 1},
    ).limit(600)
    values = [r["raw"]["hr_bpm"] for r in rows if r.get("raw", {}).get("hr_bpm")]
    return (sum(values) / len(values)) if values else None


@app.post("/reactions/batch")
def reactions_batch(
    batch: ReactionBatch, user_id: str = Depends(current_user_id)
) -> dict[str, Any]:
    """Ingest buffered Presage/Muse/IMU data for (user, song). Arousal/valence
    are computed HERE (§5) -- clients only ship raw sensor fields."""
    if not batch.readings:
        return {"inserted": 0}

    baseline = _session_hr_baseline(user_id)
    readings = [r.model_dump() for r in batch.readings]
    annotated = signals.annotate_batch(readings, baseline)

    now = datetime.now(timezone.utc)
    docs = []
    for r in annotated:
        docs.append(
            {
                "ts": r.get("ts") or now,
                "meta": {"user_id": user_id, "song_id": batch.song_id, "source": batch.source},
                "t": int(r["t"]),
                "source": batch.source,
                "raw": r.get("raw") or {},
                "movement_intensity": r.get("movement_intensity"),
                "arousal": r["arousal"],
                "valence": r["valence"],
                "quadrant": r["quadrant"],
            }
        )
    db.reactions.insert_many(docs)

    # "Learns about you over time": recompute the taste vector on every batch.
    profile = rebuild_profile(user_id)
    return {"inserted": len(docs), "profile_moments": profile["n_moments"]}


# ---------------------------------------------------------------------------
# Profile
# ---------------------------------------------------------------------------

def _top_peaks(user_id: str, n: int = 8) -> list[dict[str, Any]]:
    rows = list(
        db.reactions.find(
            {"meta.user_id": user_id, "arousal": {"$ne": None}},
            {"meta.song_id": 1, "t": 1, "arousal": 1, "valence": 1, "quadrant": 1},
        )
        .sort("arousal", -1)
        .limit(n * 3)
    )
    peaks: list[dict[str, Any]] = []
    seen: set[tuple[str, int]] = set()
    for r in rows:
        key = (r["meta"]["song_id"], int(r["t"]) // 10)  # de-dupe near-identical peaks
        if key in seen:
            continue
        seen.add(key)
        song = db.songs.find_one({"_id": r["meta"]["song_id"]}, {"title": 1, "artist": 1, "sections": 1})
        section = None
        for s in (song or {}).get("sections") or []:
            if s["start_s"] <= r["t"] < s["end_s"]:
                section = s.get("label")
                break
        peaks.append(
            {
                "song_id": r["meta"]["song_id"],
                "title": (song or {}).get("title"),
                "artist": (song or {}).get("artist"),
                "t": r["t"],
                "section": section,
                "arousal": r["arousal"],
                "valence": r["valence"],
                "quadrant": r["quadrant"],
            }
        )
        if len(peaks) >= n:
            break
    return peaks


@app.get("/profile/{user_id}")
def get_profile(user_id: str, _caller: str = Depends(current_user_id)) -> dict[str, Any]:
    """Compute taste vector + trigger the Gemini narrative (aggregate across all
    songs). Narrative goes through Backboard.io for persistent memory."""
    profile = rebuild_profile(user_id)
    peaks = _top_peaks(user_id)
    summary = {
        "taste_vector": profile.get("vector"),
        "top_tags": profile.get("tags"),
        "quadrant_counts": profile.get("quadrant_counts"),
        "n_moments": profile.get("n_moments"),
        "arousal_peaks": peaks,
    }
    narrative = backboard.generate_narrative(user_id, summary)
    return {
        "user_id": user_id,
        **summary,
        "narrative": narrative,
        "updated_at": profile.get("updated_at"),
    }


# ---------------------------------------------------------------------------
# Song graph (per-song arousal/valence overlay)
# ---------------------------------------------------------------------------

def _user_song_curve(user_id: str, song_id: str) -> dict[int, dict[str, Any]]:
    """Merge reaction rows across sources into one point per second."""
    rows = db.reactions.find(
        {"meta.user_id": user_id, "meta.song_id": song_id},
        {"t": 1, "arousal": 1, "valence": 1, "quadrant": 1, "source": 1},
    )
    by_t: dict[int, dict[str, Any]] = {}
    for r in rows:
        t = int(r["t"])
        p = by_t.setdefault(t, {"arousal_sum": 0.0, "n": 0, "valence": None, "quadrant": None})
        p["arousal_sum"] += r.get("arousal") or 0.0
        p["n"] += 1
        # Valence comes from expression classification -> prefer presage rows.
        if r.get("source") == "presage" or p["valence"] is None:
            p["valence"] = r.get("valence")
            p["quadrant"] = r.get("quadrant")
    return by_t


@app.get("/song-graph/{user_id}/{song_id}")
def song_graph(
    user_id: str, song_id: str, _caller: str = Depends(current_user_id)
) -> dict[str, Any]:
    """Second-by-second arousal/valence for one (user, song), joined against the
    song's feature curves -- the 'graph of emotion overlaid on the music'."""
    song = db.songs.find_one({"_id": song_id})
    if not song:
        raise HTTPException(status_code=404, detail="unknown song")
    by_t = _user_song_curve(user_id, song_id)
    if not by_t:
        raise HTTPException(status_code=404, detail="no reactions for this user+song")

    feats = song.get("features") or {}
    energy = feats.get("energy_curve") or []
    brightness = feats.get("spectral_brightness_curve") or []
    onset = feats.get("onset_density_curve") or []

    def at(curve: list[float], t: int) -> float | None:
        return curve[t] if t < len(curve) else None

    points = []
    for t in range(0, int(song.get("duration_s") or (max(by_t) + 1))):
        p = by_t.get(t)
        points.append(
            {
                "t": t,
                "arousal": round(p["arousal_sum"] / p["n"], 4) if p else None,
                "valence": p["valence"] if p else None,
                "quadrant": p["quadrant"] if p else None,
                "energy": at(energy, t),
                "brightness": at(brightness, t),
                "onset_density": at(onset, t),
            }
        )
    return {
        "song": {
            "song_id": song["_id"],
            "title": song.get("title"),
            "artist": song.get("artist"),
            "duration_s": song.get("duration_s"),
            "tempo_bpm": feats.get("tempo_bpm"),
            "key": feats.get("key"),
            "sections": song.get("sections") or [],
            "llm_tags": song.get("llm_tags"),
        },
        "points": points,
    }


# ---------------------------------------------------------------------------
# Recommendations
# ---------------------------------------------------------------------------

class RecommendationOptions(BaseModel):
    genres: list[str] | None = None  # hard filter over llm_tags (§6)
    limit: int = 10


@app.post("/recommendations/{user_id}")
def recommendations(
    user_id: str,
    options: RecommendationOptions | None = Body(default=None),
    _caller: str = Depends(current_user_id),
) -> dict[str, Any]:
    opts = options or RecommendationOptions()
    return recommend.recommend(user_id, genre_filter=opts.genres, limit=opts.limit)


@app.get("/ml/status/{user_id}")
def ml_status(user_id: str, _caller: str = Depends(current_user_id)) -> dict[str, Any]:
    model = ml_model.train_user_arousal_model(user_id)
    return {
        "active": model is not None,
        "training_rows": model.n_rows if model else 0,
        "min_training_rows": ml_model.MIN_TRAINING_ROWS,
        "kind": "per-user ridge regression: song features -> arousal",
    }


# ---------------------------------------------------------------------------
# Playlist export (Spotify via Auth0 Token Vault)
# ---------------------------------------------------------------------------

class PlaylistExportRequest(BaseModel):
    name: str = "Museic picks"
    description: str = "Songs your body liked. Generated by Museic."
    song_ids: list[str] | None = None  # default: current top recommendations


@app.post("/playlist/export")
def playlist_export(
    req: PlaylistExportRequest,
    user_id: str = Depends(current_user_id),
    access_token: str = Depends(raw_access_token),
) -> dict[str, Any]:
    if req.song_ids:
        songs = list(db.songs.find({"_id": {"$in": req.song_ids}}))
        tracks = [
            {
                "title": s.get("title"),
                "artist": s.get("artist"),
                "spotify_uri": s.get("spotify_uri"),
            }
            for s in songs
        ]
    else:
        recs = recommend.recommend(user_id)["recommendations"]
        tracks = [
            {"title": r["title"], "artist": r["artist"], "spotify_uri": r.get("spotify_uri")}
            for r in recs
        ]
    if not tracks:
        raise HTTPException(status_code=400, detail="nothing to export yet")
    return spotify.export_playlist(access_token, req.name, req.description, tracks)


# ---------------------------------------------------------------------------
# Compare (two-person compatibility)
# ---------------------------------------------------------------------------

@app.get("/compare/{user_a}/{user_b}")
def compare(
    user_a: str, user_b: str, _caller: str = Depends(current_user_id)
) -> dict[str, Any]:
    """Join two users' curves on shared songs -> compatibility score + graph data."""
    songs_a = set(db.reactions.distinct("meta.song_id", {"meta.user_id": user_a}))
    songs_b = set(db.reactions.distinct("meta.song_id", {"meta.user_id": user_b}))
    shared = sorted(songs_a & songs_b)
    if not shared:
        return {"compatibility": None, "shared_songs": [], "reason": "no shared songs yet"}

    per_song = []
    scores = []
    for song_id in shared:
        song = db.songs.find_one({"_id": song_id}, {"title": 1, "artist": 1, "duration_s": 1})
        curve_a = _user_song_curve(user_a, song_id)
        curve_b = _user_song_curve(user_b, song_id)
        ts = sorted(set(curve_a) & set(curve_b))
        points = []
        a_vals, b_vals, val_agree = [], [], []
        for t in ts:
            a = curve_a[t]["arousal_sum"] / curve_a[t]["n"]
            b = curve_b[t]["arousal_sum"] / curve_b[t]["n"]
            a_vals.append(a)
            b_vals.append(b)
            va, vb = curve_a[t]["valence"], curve_b[t]["valence"]
            if va is not None and vb is not None:
                val_agree.append(1.0 if (va >= 0) == (vb >= 0) else 0.0)
            points.append(
                {
                    "t": t,
                    "arousal_a": round(a, 4),
                    "arousal_b": round(b, 4),
                    "valence_a": va,
                    "valence_b": vb,
                }
            )
        song_score = None
        if len(a_vals) >= 5 and np.std(a_vals) > 0 and np.std(b_vals) > 0:
            corr = float(np.corrcoef(a_vals, b_vals)[0, 1])
            arousal_sim = (corr + 1) / 2  # -1..1 -> 0..1
            valence_sim = (sum(val_agree) / len(val_agree)) if val_agree else 0.5
            song_score = round(0.65 * arousal_sim + 0.35 * valence_sim, 4)
            scores.append(song_score)
        per_song.append(
            {
                "song_id": song_id,
                "title": (song or {}).get("title"),
                "artist": (song or {}).get("artist"),
                "score": song_score,
                "points": points,
            }
        )

    compatibility = round(float(np.mean(scores)), 4) if scores else None
    return {
        "user_a": user_a,
        "user_b": user_b,
        "compatibility": compatibility,
        "shared_songs": per_song,
    }


# ---------------------------------------------------------------------------
# Song library helpers (feed listing + local audio streaming)
# ---------------------------------------------------------------------------

@app.get("/songs")
def list_songs(_caller: str = Depends(current_user_id)) -> list[dict[str, Any]]:
    out = []
    for s in db.songs.find({}, {"features.energy_curve": 0, "features.spectral_brightness_curve": 0, "features.onset_density_curve": 0}):
        out.append(
            {
                "song_id": s["_id"],
                "title": s.get("title"),
                "artist": s.get("artist"),
                "duration_s": s.get("duration_s"),
                "tempo_bpm": (s.get("features") or {}).get("tempo_bpm"),
                "key": (s.get("features") or {}).get("key"),
                "llm_tags": s.get("llm_tags"),
                "spotify_uri": s.get("spotify_uri"),
            }
        )
    return out


@app.get("/songs/{song_id}/audio")
def song_audio(song_id: str, _caller: str = Depends(user_id_header_or_query)) -> FileResponse:
    """Stream the local audio file for feed playback. Accepts `?token=` because
    <audio> elements cannot set an Authorization header."""
    song = db.songs.find_one({"_id": song_id}, {"audio_path": 1})
    if not song or not song.get("audio_path"):
        raise HTTPException(status_code=404, detail="unknown song / no audio file")
    from pathlib import Path

    path = Path(song["audio_path"])
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"audio file missing: {path}")
    media = {"mp3": "audio/mpeg", "wav": "audio/wav", "flac": "audio/flac", "m4a": "audio/mp4", "ogg": "audio/ogg"}
    return FileResponse(path, media_type=media.get(path.suffix.lstrip(".").lower(), "application/octet-stream"))


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
