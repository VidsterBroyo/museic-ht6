import { useEffect, useRef, useState } from "react";
import type { MuseStatus, SensorReading } from "./types";

/**
 * Experimental "enjoyment" scoring, shared between the Signals dashboard and the
 * Muse control pill. Enjoyment is NOT arousal: a scared face is aroused but not
 * enjoying. It lives in the positive-valence + engaged corner.
 */

// Facial-expression -> valence (mirrors backend signals.EXPRESSION_VALENCE).
export const EXPRESSION_VALENCE: Record<string, number> = {
  happy: 1.0, happiness: 1.0, surprise: 0.6, neutral: 0.0,
  sad: -0.8, sadness: -0.8, fear: -0.7, anger: -0.9, disgust: -0.8, contempt: -0.6,
};

export const clip01 = (x: number) => Math.max(0, Math.min(1, x));

export interface EnjoyInputs {
  valence: number | null;   // -1..1 from facial expression
  movement: number | null;  // 0..1
  ratio: number | null;     // alpha/beta
  hr: number | null;        // bpm
}

/**
 * Experimental "enjoyment" score (0..1). EEG engagement + movement + arousal form
 * the core; a smiling face lifts it and a negative face suppresses it, so it works
 * even with no facial read.
 */
export function computeEnjoyment(i: EnjoyInputs): number | null {
  const core: [number, number][] = [];
  if (i.ratio != null) core.push([clip01(1 / (1 + i.ratio)), 0.5]);   // EEG engagement (low a/b)
  if (i.movement != null) core.push([clip01(i.movement), 0.3]);        // groove / head-bop
  if (i.hr != null) core.push([clip01(0.5 + 0.5 * Math.tanh((i.hr - 65) / 25)), 0.2]); // arousal

  if (core.length === 0) {
    return i.valence != null ? clip01(Math.max(0, i.valence)) : null;
  }

  const tw = core.reduce((s, [, w]) => s + w, 0);
  let e = core.reduce((s, [v, w]) => s + v * w, 0) / tw;
  // Only a genuine smile nudges up (≤ +0.15 of headroom). Negative expressions are
  // ignored — the detector false-defaults to sad/angry at rest, so it's just noise.
  if (i.valence != null && i.valence > 0) {
    e += i.valence * 0.15 * (1 - e);
  }
  return clip01(e);
}

function ratioFromMuse(status: Extract<MuseStatus, { state: "streaming" }>): number | null {
  if (status.lastRatio != null) return status.lastRatio;
  const a = status.bands?.alpha;
  const b = status.bands?.beta;
  return a != null && b ? a / b : null;
}

/**
 * Live enjoyment score computed from the global sensor + Muse streams. Any
 * component can call this to get the current 0..1 value (null until data flows).
 */
export function useEnjoyment(): number | null {
  const inputs = useRef<EnjoyInputs>({ valence: null, movement: null, ratio: null, hr: null });
  const camMove = useRef<number | null>(null);   // Presage lower-body micromotion
  const museMove = useRef<number | null>(null);   // Muse IMU head motion (preferred)
  const [score, setScore] = useState<number | null>(null);

  useEffect(() => {
    // Muse head-bop beats Presage's glutes/knees micromotion for "groove".
    const bestMove = () => museMove.current ?? camMove.current;
    const recompute = () => setScore(computeEnjoyment({ ...inputs.current, movement: bestMove() }));

    const offSensor = window.museic.onSensorReading((reading: SensorReading) => {
      const r = reading.raw;
      const valence = r.expression
        ? (EXPRESSION_VALENCE[r.expression.toLowerCase()] ?? 0) * (r.expression_confidence ?? 0)
        : inputs.current.valence;
      camMove.current = reading.movement_intensity ?? camMove.current;
      inputs.current = { ...inputs.current, valence, hr: r.hr_bpm ?? inputs.current.hr };
      recompute();
    });

    const offMuse = window.museic.onMuseStatus((status: MuseStatus) => {
      if (status.state !== "streaming") return;
      if (status.movement !== undefined) museMove.current = status.movement; // null clears
      const ratio = ratioFromMuse(status);
      if (ratio != null) inputs.current = { ...inputs.current, ratio };
      recompute();
    });

    return () => {
      offSensor();
      offMuse();
    };
  }, []);

  return score;
}
