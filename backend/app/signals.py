"""Arousal/valence derivation, RFC §5. Computed backend-side at ingest -- the
client ships raw sensor fields only.

Signal-lag tiers (per §5):
- FAST (near-instant, drive the moment-by-moment overlay graph):
  facial-expression transitions, movement/accelerometer magnitude, and Muse
  alpha/beta band power on a short window.
- SLOW (rolling windows, corroborating trend only, NOT averaged in equally):
  pulse rate (12 s rolling) and HRV / Baevsky stress index (60 s rolling).

The final arousal is a weighted blend heavily favouring the fast tier
(FAST_WEIGHT vs SLOW_WEIGHT below), so a surprise-expression jump or a head-bop
right as a drop hits is what spikes the line -- HR/HRV only nudges it.

Emotion-quadrant bucketing (§5) falls straight out of arousal x valence here.
"""
from __future__ import annotations

import math
from typing import Any

# Valence mapping: highest-confidence expression category (§5).
EXPRESSION_VALENCE: dict[str, float] = {
    "happy": 1.0,
    "happiness": 1.0,
    "surprise": 0.6,
    "neutral": 0.0,
    "sad": -0.8,
    "sadness": -0.8,
    "fear": -0.7,
    "anger": -0.9,
    "disgust": -0.8,
    "contempt": -0.6,
}

FAST_WEIGHT = 0.75
SLOW_WEIGHT = 0.25

# Relative weights inside the fast tier (renormalised over available signals).
FAST_COMPONENT_WEIGHTS = {"expression": 0.40, "movement": 0.35, "muse": 0.25}
SLOW_COMPONENT_WEIGHTS = {"pulse": 0.5, "hrv": 0.5}

RESTING_HR = 65.0  # session baseline fallback before enough data accumulates


def _clip01(x: float) -> float:
    return max(0.0, min(1.0, x))


def derive_valence(raw: dict[str, Any]) -> float:
    expr = (raw.get("expression") or "").lower()
    conf = float(raw.get("expression_confidence") or 0.0)
    return EXPRESSION_VALENCE.get(expr, 0.0) * _clip01(conf)


def _expression_transition_intensity(
    raw: dict[str, Any], prev_raw: dict[str, Any] | None
) -> float | None:
    """Low-lag arousal component: how sharply the expression state just moved."""
    expr = raw.get("expression")
    if expr is None:
        return None
    conf = _clip01(float(raw.get("expression_confidence") or 0.0))
    if prev_raw is None:
        # First second: non-neutral expression itself carries some arousal.
        return conf * (0.0 if (expr or "").lower() == "neutral" else 0.5)
    prev_expr = prev_raw.get("expression")
    prev_conf = _clip01(float(prev_raw.get("expression_confidence") or 0.0))
    if expr != prev_expr:
        # A category flip is exactly the kind of event the graph exists to show.
        return _clip01(0.5 + 0.5 * max(conf, prev_conf))
    # Same category: confidence swings still register, weakly.
    return _clip01(abs(conf - prev_conf) * 0.8)


def _muse_component(raw: dict[str, Any]) -> float | None:
    """Muse alpha/beta band power (2-4 s window): fast tier. `alpha_beta_ratio`
    is alpha power / beta power; low alpha relative to beta => engaged/aroused."""
    ratio = raw.get("alpha_beta_ratio")
    if ratio is None:
        return None
    try:
        r = float(ratio)
    except (TypeError, ValueError):
        return None
    if r <= 0:
        return None
    # r == 1 -> 0.5; r -> 0 (beta-dominant) -> 1; r -> inf (alpha-dominant) -> 0.
    return _clip01(1.0 / (1.0 + r))


def _slow_trend(raw: dict[str, Any], session_hr_baseline: float | None) -> float | None:
    """Corroborating slow trend from pulse rate + HRV/stress index. Continuous
    across the whole session (cardio state is not song-specific, §5)."""
    parts: list[tuple[float, float]] = []  # (value, weight)

    hr = raw.get("hr_bpm")
    if hr is not None:
        baseline = session_hr_baseline or RESTING_HR
        # ~ +25 bpm above session baseline saturates to 1.0.
        dev = (float(hr) - baseline) / 25.0
        parts.append((_clip01(0.5 + 0.5 * math.tanh(dev)), SLOW_COMPONENT_WEIGHTS["pulse"]))

    stress = raw.get("stress_index")
    hrv = raw.get("hrv_rmssd")
    if stress is not None:
        # Baevsky index: ~50 typical, 100+ high stress/arousal.
        parts.append((_clip01(float(stress) / 120.0), SLOW_COMPONENT_WEIGHTS["hrv"]))
    elif hrv is not None:
        # Lower RMSSD => higher sympathetic arousal. ~20ms high, ~80ms relaxed.
        parts.append((_clip01(1.0 - (float(hrv) - 15.0) / 65.0), SLOW_COMPONENT_WEIGHTS["hrv"]))

    if not parts:
        return None
    total_w = sum(w for _, w in parts)
    return sum(v * w for v, w in parts) / total_w


def derive_arousal(
    raw: dict[str, Any],
    prev_raw: dict[str, Any] | None,
    movement_intensity: float | None,
    session_hr_baseline: float | None,
) -> float:
    """Blend fast components (primary) with the slow trend (corroborating)."""
    fast_parts: list[tuple[float, float]] = []

    expr_component = _expression_transition_intensity(raw, prev_raw)
    if expr_component is not None:
        fast_parts.append((expr_component, FAST_COMPONENT_WEIGHTS["expression"]))
    if movement_intensity is not None:
        fast_parts.append((_clip01(float(movement_intensity)), FAST_COMPONENT_WEIGHTS["movement"]))
    muse_component = _muse_component(raw)
    if muse_component is not None:
        fast_parts.append((muse_component, FAST_COMPONENT_WEIGHTS["muse"]))

    fast = None
    if fast_parts:
        total_w = sum(w for _, w in fast_parts)
        fast = sum(v * w for v, w in fast_parts) / total_w

    slow = _slow_trend(raw, session_hr_baseline)

    if fast is not None and slow is not None:
        return _clip01(FAST_WEIGHT * fast + SLOW_WEIGHT * slow)
    if fast is not None:
        return _clip01(fast)
    if slow is not None:
        # Slow-only data (e.g. a sparse muse-less, expression-less row): the
        # trend is all we have, but it stays a trend -- damp it toward 0.5.
        return _clip01(0.5 + (slow - 0.5) * 0.6)
    return 0.0


def quadrant(arousal: float, valence: float) -> str:
    """Standard circumplex quadrants (§5): hype / chill / sad / tense."""
    if arousal >= 0.5:
        return "hype" if valence >= 0 else "tense"
    return "chill" if valence >= 0 else "sad"


def annotate_batch(
    readings: list[dict[str, Any]], session_hr_baseline: float | None
) -> list[dict[str, Any]]:
    """Compute arousal/valence/quadrant for a time-ordered batch of readings.

    Each reading: {"t": int, "raw": {...}, "movement_intensity": float|None, ...}
    Mutates and returns the list.
    """
    ordered = sorted(readings, key=lambda r: r.get("t", 0))
    prev_raw: dict[str, Any] | None = None
    for r in ordered:
        raw = r.get("raw") or {}
        valence = derive_valence(raw)
        arousal = derive_arousal(
            raw, prev_raw, r.get("movement_intensity"), session_hr_baseline
        )
        r["valence"] = round(valence, 4)
        r["arousal"] = round(arousal, 4)
        r["quadrant"] = quadrant(arousal, valence)
        prev_raw = raw
    return ordered
