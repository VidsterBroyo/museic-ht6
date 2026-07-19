#!/usr/bin/env python3
"""Offline song-library extraction pipeline (RFC §3/§4). Standalone.

For every audio file in a folder, two extraction passes:

1. NUMERIC, per-second curves via librosa: tempo, key, RMS energy, spectral
   centroid ("brightness"), onset density. These feed the arousal-overlay
   graph, so they are precise and timestamped to the second -- an LLM is the
   wrong tool for this part.
2. QUALITATIVE tags via one Gemini call per track (instruments, vocal
   character, mood/genre words), structured JSON output.

   NOTE (deviation from RFC §3, confirmed with project owner): this pass calls
   the Gemini API DIRECTLY with the audio bytes, not via Backboard.io, because
   Backboard does not accept audio uploads. Backboard remains the route for
   the runtime per-profile narrative (backend/app/backboard.py).

Both passes run once, offline, before the event -- never live during the demo.
Results are upserted into the MongoDB `songs` collection.

Usage:
    python extract_features.py --audio-dir /path/to/library
    python extract_features.py --audio-dir ./library --skip-gemini
    python extract_features.py --audio-dir ./library --only local_003

Env (repo-root .env): MONGODB_URI, MONGODB_DB, GEMINI_API_KEY, GEMINI_MODEL.
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import re
import sys
from pathlib import Path

import numpy as np
import requests
from dotenv import load_dotenv

AUDIO_EXTS = {".mp3", ".wav", ".flac", ".m4a", ".ogg"}
GEMINI_INLINE_LIMIT_BYTES = 18 * 1024 * 1024  # inline request cap is ~20 MB

KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

TAGGING_PROMPT = """You are tagging one song for a music-recommendation system.
Listen to the attached audio and return STRICT JSON (no markdown) shaped exactly:
{
  "instruments": ["..."],          // 3-8 concrete instruments/sound sources, e.g. "808 bass", "synth pad"
  "vocal_character": "...",        // short phrase, or "instrumental" if no vocals
  "mood": ["..."]                  // 3-6 mood/genre words, lowercase
}"""


# ---------------------------------------------------------------------------
# Pass 1: librosa numeric curves
# ---------------------------------------------------------------------------

def per_second_curves(path: Path) -> dict:
    import librosa  # imported here so --help works without the heavy dep

    y, sr = librosa.load(str(path), sr=22050, mono=True)
    duration_s = int(np.ceil(len(y) / sr))
    hop = 512
    frames_per_sec = sr / hop

    # RMS energy per frame -> per second (normalised 0..1 against track max).
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    # Spectral centroid per frame -> per second (normalised by Nyquist).
    centroid = librosa.feature.spectral_centroid(y=y, sr=sr, hop_length=hop)[0]
    # Onset strength -> per-second onset density.
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    onset_frames = librosa.onset.onset_detect(
        onset_envelope=onset_env, sr=sr, hop_length=hop, units="frames"
    )
    onset_seconds = (onset_frames / frames_per_sec).astype(int)

    def frame_curve_to_seconds(curve: np.ndarray) -> list[float]:
        out = []
        for s in range(duration_s):
            lo = int(s * frames_per_sec)
            hi = max(lo + 1, int((s + 1) * frames_per_sec))
            out.append(float(np.mean(curve[lo:hi])) if lo < len(curve) else 0.0)
        return out

    energy_sec = frame_curve_to_seconds(rms)
    peak = max(energy_sec) or 1.0
    energy_sec = [round(v / peak, 4) for v in energy_sec]

    bright_sec = frame_curve_to_seconds(centroid)
    nyquist = sr / 2.0
    bright_sec = [round(v / nyquist, 4) for v in bright_sec]

    onset_sec = [0.0] * duration_s
    for s in onset_seconds:
        if 0 <= s < duration_s:
            onset_sec[s] += 1.0
    max_onsets = max(onset_sec) or 1.0
    onset_sec = [round(v / max_onsets, 4) for v in onset_sec]

    # Tempo + key estimate.
    tempo, _ = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr, hop_length=hop)
    tempo_bpm = int(round(float(np.atleast_1d(tempo)[0])))

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    chroma_mean = chroma.mean(axis=1)
    tonic = int(np.argmax(chroma_mean))
    # Crude major/minor call: compare the major vs minor third above the tonic.
    major_third = chroma_mean[(tonic + 4) % 12]
    minor_third = chroma_mean[(tonic + 3) % 12]
    mode = "major" if major_third >= minor_third else "minor"
    key = f"{KEY_NAMES[tonic]} {mode}"

    sections = heuristic_sections(energy_sec)

    return {
        "duration_s": duration_s,
        "sections": sections,
        "features": {
            "tempo_bpm": tempo_bpm,
            "key": key,
            "energy_curve": energy_sec,
            "spectral_brightness_curve": bright_sec,
            "onset_density_curve": onset_sec,
        },
    }


def heuristic_sections(energy: list[float]) -> list[dict]:
    """Cheap energy-based sectioning (intro / low / high / outro). Heuristic
    only -- good enough to label arousal peaks like 'peaked during the drop'."""
    n = len(energy)
    if n < 20:
        return [{"start_s": 0, "end_s": n, "label": "full"}]
    smooth = np.convolve(energy, np.ones(5) / 5, mode="same")
    median = float(np.median(smooth))
    sections: list[dict] = []
    current = "high" if smooth[0] >= median else "low"
    start = 0
    for i in range(1, n):
        label = "high" if smooth[i] >= median else "low"
        if label != current and i - start >= 8:  # min section length 8 s
            sections.append({"start_s": start, "end_s": i, "label": current})
            start, current = i, label
    sections.append({"start_s": start, "end_s": n, "label": current})
    if sections:
        sections[0]["label"] = "intro" if sections[0]["label"] == "low" else sections[0]["label"]
        sections[-1]["label"] = "outro" if sections[-1]["label"] == "low" else sections[-1]["label"]
    return sections


def extract_album_art(path: Path) -> tuple[str, str] | None:
    """Use TinyTag to pull embedded album art and return it as a tuple of
    (base64 data, mime_type)."""
    try:
        from tinytag import TinyTag

        tag = TinyTag.get(str(path), image=True)
        image_bytes = tag.images.any
        if image_bytes:
            # The .any property returns an Image object, not raw bytes.
            # The raw data is on its .data attribute.
            image_data = image_bytes.data
            mime_type = "image/jpeg"  # Default
            if image_data.startswith(b"\x89PNG\r\n\x1a\n"):
                mime_type = "image/png"
            b64_data = base64.b64encode(image_data).decode("ascii")
            return b64_data, mime_type
    except Exception as e:
        print(f"    ! could not extract album art: {e}")
    return None


# ---------------------------------------------------------------------------
# Pass 2: Gemini qualitative tags (direct API -- see module docstring)
# ---------------------------------------------------------------------------

def gemini_tags(path: Path, api_key: str, model: str) -> dict | None:
    size = path.stat().st_size
    if size > GEMINI_INLINE_LIMIT_BYTES:
        print(f"    ! {path.name} is {size/1e6:.1f} MB (> inline limit); skipping tags. "
              "Re-encode to a smaller mp3 or tag manually.")
        return None
    mime = mimetypes.guess_type(str(path))[0] or "audio/mpeg"
    payload = {
        "contents": [
            {
                "parts": [
                    {"text": TAGGING_PROMPT},
                    {
                        "inline_data": {
                            "mime_type": mime,
                            "data": base64.b64encode(path.read_bytes()).decode(),
                        }
                    },
                ]
            }
        ],
        "generationConfig": {"response_mime_type": "application/json"},
    }
    resp = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        params={"key": api_key},
        json=payload,
        timeout=180,
    )
    if resp.status_code != 200:
        print(f"    ! Gemini tagging failed ({resp.status_code}): {resp.text[:200]}")
        return None
    try:
        text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
        tags = json.loads(text)
        return {
            "instruments": list(tags.get("instruments") or []),
            "vocal_character": tags.get("vocal_character") or "unknown",
            "mood": list(tags.get("mood") or []),
        }
    except (KeyError, IndexError, json.JSONDecodeError) as exc:
        print(f"    ! could not parse Gemini response: {exc}")
        return None


# ---------------------------------------------------------------------------
# Metadata + seeding
# ---------------------------------------------------------------------------

def title_artist_from_name(path: Path) -> tuple[str, str]:
    """'Title - Artist.mp3' -> (title, artist); otherwise stem as title."""
    stem = path.stem
    if " - " in stem:
        title, artist = stem.split(" - ", 1)
        return title.strip(), artist.strip()
    return stem.strip(), ""


def slug_id(index: int) -> str:
    return f"local_{index:03d}"


def main() -> int:
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio-dir", default=os.getenv("AUDIO_DIR", "./library"),
                        help="folder of local audio files (mp3/wav/flac/m4a/ogg)")
    parser.add_argument("--mongodb-uri", default=os.getenv("MONGODB_URI"))
    parser.add_argument("--db", default=os.getenv("MONGODB_DB", "museic"))
    parser.add_argument("--skip-gemini", action="store_true",
                        help="numeric curves only; leave llm_tags untouched")
    parser.add_argument("--only", help="re-process a single song id (e.g. local_003)")
    args = parser.parse_args()

    audio_dir = Path(args.audio_dir).resolve()
    if not audio_dir.is_dir():
        print(f"audio dir not found: {audio_dir}", file=sys.stderr)
        return 1
    if not args.mongodb_uri:
        print("MONGODB_URI is not set (repo-root .env, see .env.example)", file=sys.stderr)
        return 1

    gemini_key = os.getenv("GEMINI_API_KEY", "")
    gemini_model = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")
    if not args.skip_gemini and not gemini_key:
        print("GEMINI_API_KEY not set -- running numeric pass only (use --skip-gemini "
              "to silence this).")
        args.skip_gemini = True

    from pymongo import MongoClient

    songs = MongoClient(args.mongodb_uri)[args.db]["songs"]

    files = sorted(p for p in audio_dir.iterdir() if p.suffix.lower() in AUDIO_EXTS)
    if not files:
        print(f"no audio files in {audio_dir}", file=sys.stderr)
        return 1

    print(f"Processing {len(files)} track(s) from {audio_dir}")
    for i, path in enumerate(files, start=1):
        song_id = slug_id(i)
        if args.only and song_id != args.only:
            continue
        title, artist = title_artist_from_name(path)
        print(f"[{song_id}] {path.name}")

        print("    librosa: per-second curves ...")
        numeric = per_second_curves(path)
        art_data = extract_album_art(path)

        doc = {
            "_id": song_id,
            "title": title,
            "artist": artist,
            "audio_path": str(path.relative_to(audio_dir)),
            "duration_s": numeric["duration_s"],
            "sections": numeric["sections"],
            "features": numeric["features"],
            "album_art_b64": art_data[0] if art_data else None,
            "album_art_mime": art_data[1] if art_data else None,
            # spotify_uri is resolved at export time via search; pre-fill here
            # only if you already know it.
            "spotify_uri": None,
        }

        if not args.skip_gemini:
            print("    gemini: qualitative tags ...")
            tags = gemini_tags(path, gemini_key, gemini_model)
            if tags:
                doc["llm_tags"] = tags

        existing = songs.find_one({"_id": song_id}) or {}
        if "llm_tags" not in doc and existing.get("llm_tags"):
            doc["llm_tags"] = existing["llm_tags"]  # keep old tags on re-runs
        if existing.get("spotify_uri"):
            doc["spotify_uri"] = existing["spotify_uri"]
        if not doc.get("album_art_b64") and existing.get("album_art_b64"):
            doc["album_art_b64"] = existing.get("album_art_b64")
            doc["album_art_mime"] = existing.get("album_art_mime")

        songs.replace_one({"_id": song_id}, doc, upsert=True)
        print(f"    seeded: {numeric['duration_s']}s, "
              f"{numeric['features']['tempo_bpm']} bpm, {numeric['features']['key']}")

    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
