"""Derived "music DNA" insights for the profile page.

All of these are pure aggregations over data we already store -- no external
API calls. They are computed on the profile refresh path (see main.get_profile)
and cached in the profile document, so repeat opens are free.

Shared "enjoyment" metric (0..1) for a single reaction second:

    enjoyment = arousal * clip01(0.5 + 0.5 * valence)

i.e. how activated you were, scaled down when your expression was unpleasant.
A head-bop with a smile scores highest; a tense (aroused + negative) moment is
discounted, because arousal alone is not enjoyment.
"""
from __future__ import annotations

import math
from typing import Any, Callable

from . import db

# A song needs at least this many reaction-seconds before it can be ranked, so a
# 2-second fluke can't top the "most enjoyed" list.
MIN_SONG_SECONDS = 8

# Minimum number of other listeners before crowd percentiles are meaningful.
MIN_CROWD = 3


def _clip01(x: float) -> float:
    return max(0.0, min(1.0, x))


def _per_song_enjoyment(user_id: str) -> dict[str, dict[str, float]]:
    """{song_id: {"sum": total enjoyment, "n": seconds, "max_a": peak arousal}}."""
    rows = db.reactions.find(
        {"meta.user_id": user_id, "arousal": {"$ne": None}},
        {"meta.song_id": 1, "arousal": 1, "valence": 1},
    )
    agg: dict[str, dict[str, float]] = {}
    for r in rows:
        sid = r["meta"]["song_id"]
        a = float(r["arousal"])
        v = float(r.get("valence") or 0.0)
        enj = a * _clip01(0.5 + 0.5 * v)
        d = agg.setdefault(sid, {"sum": 0.0, "n": 0.0, "max_a": 0.0})
        d["sum"] += enj
        d["n"] += 1
        d["max_a"] = max(d["max_a"], a)
    return agg


def top_enjoyed_songs(user_id: str, n: int = 5) -> list[dict[str, Any]]:
    agg = _per_song_enjoyment(user_id)
    if not agg:
        return []
    qualifying = {s: d for s, d in agg.items() if d["n"] >= MIN_SONG_SECONDS} or agg
    ranked = sorted(qualifying.items(), key=lambda kv: kv[1]["sum"] / kv[1]["n"], reverse=True)
    out: list[dict[str, Any]] = []
    for sid, d in ranked[:n]:
        song = db.songs.find_one({"_id": sid}, {"title": 1, "artist": 1})
        out.append(
            {
                "song_id": sid,
                "title": (song or {}).get("title"),
                "artist": (song or {}).get("artist"),
                "enjoyment": round(d["sum"] / d["n"], 4),
                "seconds": int(d["n"]),
                "peak_arousal": round(d["max_a"], 4),
            }
        )
    return out


def sonic_signature(user_id: str) -> dict[str, Any] | None:
    """Enjoyment-weighted tempo sweet-spot, major/minor split, and top key."""
    agg = _per_song_enjoyment(user_id)
    if not agg:
        return None
    songs = {
        s["_id"]: s
        for s in db.songs.find(
            {"_id": {"$in": list(agg)}}, {"features.tempo_bpm": 1, "features.key": 1}
        )
    }
    tempos: list[tuple[float, float]] = []  # (bpm, weight)
    mode_w = {"major": 0.0, "minor": 0.0}
    key_w: dict[str, float] = {}
    for sid, d in agg.items():
        song = songs.get(sid)
        if not song:
            continue
        feats = song.get("features") or {}
        w = max(0.0, d["sum"] / d["n"])  # this song's mean enjoyment
        tempo = feats.get("tempo_bpm")
        if tempo:
            tempos.append((float(tempo), w))
        key = feats.get("key") or ""
        parts = key.split(" ", 1)
        if len(parts) == 2:
            mode = parts[1].lower()
            if mode in mode_w:
                mode_w[mode] += w
            key_w[key] = key_w.get(key, 0.0) + w

    tempo_den = sum(w for _, w in tempos)
    if tempo_den <= 0:
        return None
    sweet = sum(t * w for t, w in tempos) / tempo_den
    var = sum(w * (t - sweet) ** 2 for t, w in tempos) / tempo_den
    sd = math.sqrt(var)

    total_mode = mode_w["major"] + mode_w["minor"]
    top_key = max(key_w, key=lambda k: key_w[k]) if key_w else None

    return {
        "sweet_spot_bpm": round(sweet),
        "tempo_low": max(0, round(sweet - sd)),
        "tempo_high": round(sweet + sd),
        "minor_pct": round(mode_w["minor"] / total_mode, 3) if total_mode else None,
        "major_pct": round(mode_w["major"] / total_mode, 3) if total_mode else None,
        "dominant_mode": (
            None
            if not total_mode
            else ("minor" if mode_w["minor"] >= mode_w["major"] else "major")
        ),
        "top_key": top_key,
        "n_songs": len(agg),
    }


def crowd_percentiles(user_id: str) -> dict[str, Any] | None:
    """Percentile-rank this user against all other profiles on stored metrics."""
    docs = list(
        db.profiles.find(
            {}, {"user_id": 1, "mean_arousal": 1, "mean_valence": 1, "vector": 1}
        )
    )
    me = next((d for d in docs if d.get("user_id") == user_id), None)
    if not me:
        return None
    n_listeners = sum(1 for d in docs if d.get("mean_arousal") is not None)
    if n_listeners < MIN_CROWD:
        return {"n_listeners": n_listeners}

    others = [d for d in docs if d.get("user_id") != user_id]

    def pct(metric: Callable[[dict[str, Any]], float | None]) -> float | None:
        mine = metric(me)
        if mine is None:
            return None
        vals = [metric(d) for d in others]
        vals = [x for x in vals if x is not None]
        if not vals:
            return None
        below = sum(1 for x in vals if x < mine)
        return round(below / len(vals), 3)

    return {
        "n_listeners": n_listeners,
        "energy_pct": pct(lambda d: d.get("mean_arousal")),
        "positivity_pct": pct(lambda d: d.get("mean_valence")),
        "tempo_pct": pct(lambda d: (d.get("vector") or {}).get("tempo_norm")),
    }


def compute_all(user_id: str) -> dict[str, Any]:
    return {
        "sonic_signature": sonic_signature(user_id),
        "top_songs": top_enjoyed_songs(user_id),
        "crowd": crowd_percentiles(user_id),
    }
