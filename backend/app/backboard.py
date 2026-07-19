"""Gemini via Backboard.io (RFC §6).

Backboard is the routing layer for the *per-profile narrative* prompt shape:
its persistent assistant memory lets the "gets to know you over time" story
accumulate across sessions, and it's a single swap point if Gemini rate-limits.

(The other prompt shape from §6 -- offline per-song tagging from raw audio --
lives in scripts/extract_features.py and calls Gemini directly, because
Backboard does not accept audio file uploads. Decision confirmed with the
project owner; see SETUP.md.)
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

from . import config

log = logging.getLogger("museic.backboard")

_assistant_id: str | None = None

SYSTEM_PROMPT = (
    "You are Museic, a music-taste analyst. You receive biometric listening data: "
    "arousal/valence peaks timestamped against song structure, emotion-quadrant "
    "counts, and taste-vector stats. Write a short (120-180 word), warm, "
    "second-person narrative of what this listener's body says about their music "
    "taste. Reference concrete moments (song titles, what was happening in the "
    "music at the peak). You have persistent memory: if you have seen this "
    "listener before, acknowledge how their profile is evolving."
)


def _headers() -> dict[str, str]:
    return {"X-API-Key": config.BACKBOARD_API_KEY, "Content-Type": "application/json"}


def _ensure_assistant(client: httpx.Client) -> str:
    """Use the configured assistant, or create one once and log its id so the
    operator can pin it in .env (BACKBOARD_ASSISTANT_ID) for durable memory."""
    global _assistant_id
    if config.BACKBOARD_ASSISTANT_ID:
        return config.BACKBOARD_ASSISTANT_ID
    if _assistant_id:
        return _assistant_id
    resp = client.post(
        f"{config.BACKBOARD_BASE_URL}/assistants",
        headers=_headers(),
        json={"name": "Museic Narrator", "system_prompt": SYSTEM_PROMPT},
    )
    resp.raise_for_status()
    _assistant_id = resp.json()["assistant_id"]
    log.warning(
        "Created Backboard assistant %s -- add it to .env as BACKBOARD_ASSISTANT_ID "
        "to keep narrative memory across backend restarts.",
        _assistant_id,
    )
    return _assistant_id


def generate_narrative(user_id: str, profile_summary: dict[str, Any]) -> str | None:
    """Per-profile narrative from arousal-peak timestamps + song metadata."""
    if not config.BACKBOARD_API_KEY:
        log.info("BACKBOARD_API_KEY not set; skipping narrative generation")
        return None
    try:
        with httpx.Client(timeout=60) as client:
            assistant_id = _ensure_assistant(client)
            resp = client.post(
                f"{config.BACKBOARD_BASE_URL}/threads/messages",
                headers=_headers(),
                json={
                    "assistant_id": assistant_id,
                    "llm_provider": "google",
                    "model_name": config.BACKBOARD_GEMINI_MODEL,
                    "memory": "Auto",
                    "system_prompt": SYSTEM_PROMPT,
                    "content": (
                        f"Listener id: {user_id}\n"
                        f"Profile data (JSON):\n{profile_summary}"
                    ),
                },
            )
            resp.raise_for_status()
            data = resp.json()
            if data.get("status") == "FAILED":
                log.warning(
                    "Backboard narrative generation failed: %s",
                    data.get("content") or data.get("message") or "unknown failure",
                )
                return None
            content = data.get("content")
            if not content or content.lower().startswith("llm error:"):
                log.warning("Backboard returned non-narrative content: %r", content)
                return None
            return content
    except Exception:  # noqa: BLE001 - narrative is non-load-bearing
        log.exception("Backboard narrative generation failed")
        return None


def local_narrative(profile_summary: dict[str, Any]) -> str | None:
    """Deterministic fallback when Backboard credits/model routing are unavailable."""
    n_moments = int(profile_summary.get("n_moments") or 0)
    if n_moments <= 0:
        return None

    tags = profile_summary.get("top_tags") or {}
    positive_tags = [
        tag for tag, weight in sorted(tags.items(), key=lambda kv: kv[1], reverse=True)
        if weight > 0
    ][:4]
    peaks = profile_summary.get("arousal_peaks") or []
    peak = peaks[0] if peaks else {}
    quadrants = profile_summary.get("quadrant_counts") or {}
    top_quadrant = max(quadrants, key=quadrants.get) if quadrants else None

    tag_text = ", ".join(positive_tags) if positive_tags else "the songs that create clear spikes"
    moment_text = ""
    if peak:
        title = peak.get("title") or peak.get("song_id") or "one track"
        section = f" during the {peak['section']}" if peak.get("section") else ""
        moment_text = f" Your strongest recent reaction hit around {title}{section}."
    quadrant_text = f" Most of your captured moments currently land in the {top_quadrant} zone." if top_quadrant else ""

    return (
        f"Your listening profile is based on {n_moments} high-arousal moment"
        f"{'' if n_moments == 1 else 's'}. So far, your body seems to respond most to "
        f"{tag_text}.{moment_text}{quadrant_text} As you react to more songs, this profile will get "
        "more specific and the recommendations will lean harder into the patterns that keep showing up."
    )
