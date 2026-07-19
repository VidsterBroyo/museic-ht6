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
    "arousal/valence peaks, emotion-quadrant counts, and taste-vector tags. "
    "Output exactly ~50 words as ONLY dot jots. Each dot jot is on its own line, "
    "starting with a bullet point (•). Refer to the end-user as 'you'. Wrap important "
    "facts in double asterisks for bold, e.g. **80**, **synthesizer**, **Slayyyter**, **chill**. "
    "Bold: moment count, top tags/instruments, song titles, section names, and dominant emotion. "
    "Ground claims in the data. No fluff, no user ids."
)


_BULLET = "•"


def _normalize_dot_jots(content: str) -> str:
    """Ensure each bullet dot jot sits on its own line.

    The prompt asks the model to emit newline-separated bullets, but if it
    returns them inline (e.g. "• a • b"), we split on the bullet char and
    re-join with a leading newline before each dot jot.
    """
    if _BULLET not in content:
        return content.strip()
    jots = [part.strip() for part in content.split(_BULLET) if part.strip()]
    return "\n".join(f"{_BULLET} {jot}" for jot in jots)


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
            return _normalize_dot_jots(content)
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

    tag_text = (
        ", ".join(f"**{tag}**" for tag in positive_tags)
        if positive_tags
        else "clear spikes"
    )
    parts = [
        f"Based on **{n_moments}** high-arousal "
        f"moment{'' if n_moments == 1 else 's'}. "
        f"You respond most to {tag_text}."
    ]
    if peak:
        title = peak.get("title") or peak.get("song_id") or "one track"
        section = f" ({peak['section']})" if peak.get("section") else ""
        parts.append(f" Peak: **{title}**{section}.")
    if top_quadrant:
        parts.append(f" Mostly **{top_quadrant}**.")
    return "".join(parts)
