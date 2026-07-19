import type { RawSensorData, SensorReading } from "../types";

const EXPRESSION_VALENCE: Record<string, number> = {
  happy: 1.0,
  happiness: 1.0,
  surprise: 0.6,
  neutral: 0.0,
  sad: -0.8,
  sadness: -0.8,
  fear: -0.7,
  anger: -0.9,
  disgust: -0.8,
  contempt: -0.6,
};

const FAST_WEIGHT = 0.75;
const SLOW_WEIGHT = 0.25;

const FAST_COMPONENT_WEIGHTS: Record<string, number> = { expression: 0.4, movement: 0.35, muse: 0.25 };
const SLOW_COMPONENT_WEIGHTS: Record<string, number> = { pulse: 0.5, hrv: 0.5 };

const RESTING_HR = 65.0; // session baseline fallback

function clip01(x: number): number {
  return Math.max(0.0, Math.min(1.0, x));
}

function deriveValence(raw: RawSensorData): number {
  const expr = (raw.expression ?? "").toLowerCase();
  const conf = raw.expression_confidence ?? 0.0;
  return (EXPRESSION_VALENCE[expr] ?? 0.0) * clip01(conf);
}

function expressionTransitionIntensity(raw: RawSensorData, prevRaw: RawSensorData | null): number | null {
  const expr = raw.expression;
  if (expr === null || expr === undefined) return null;

  const conf = clip01(raw.expression_confidence ?? 0.0);
  if (!prevRaw) {
    return conf * (expr.toLowerCase() === "neutral" ? 0.0 : 0.5);
  }

  const prevExpr = prevRaw.expression;
  const prevConf = clip01(prevRaw.expression_confidence ?? 0.0);

  if (expr !== prevExpr) {
    return clip01(0.5 + 0.5 * Math.max(conf, prevConf));
  }
  return clip01(Math.abs(conf - prevConf) * 0.8);
}

function museComponent(raw: RawSensorData): number | null {
  const ratio = raw.alpha_beta_ratio;
  if (ratio === null || ratio === undefined || ratio <= 0) return null;
  return clip01(1.0 / (1.0 + ratio));
}

function slowTrend(raw: RawSensorData, sessionHrBaseline: number | null): number | null {
  const parts: [number, number][] = []; // [value, weight]
  const baseline = sessionHrBaseline ?? RESTING_HR;

  if (raw.hr_bpm !== null && raw.hr_bpm !== undefined) {
    const dev = (raw.hr_bpm - baseline) / 25.0;
    parts.push([clip01(0.5 + 0.5 * Math.tanh(dev)), SLOW_COMPONENT_WEIGHTS["pulse"]]);
  }

  if (raw.stress_index !== null && raw.stress_index !== undefined) {
    parts.push([clip01(raw.stress_index / 120.0), SLOW_COMPONENT_WEIGHTS["hrv"]]);
  } else if (raw.hrv_rmssd !== null && raw.hrv_rmssd !== undefined) {
    parts.push([clip01(1.0 - (raw.hrv_rmssd - 15.0) / 65.0), SLOW_COMPONENT_WEIGHTS["hrv"]]);
  }

  if (parts.length === 0) return null;
  const totalW = parts.reduce((sum, [, w]) => sum + w, 0);
  return parts.reduce((sum, [v, w]) => sum + v * w, 0) / totalW;
}

function deriveArousal(
  raw: RawSensorData,
  prevRaw: RawSensorData | null,
  movementIntensity: number | null,
  sessionHrBaseline: number | null,
): number {
  const fastParts: [number, number][] = [];

  const exprComponent = expressionTransitionIntensity(raw, prevRaw);
  if (exprComponent !== null) {
    fastParts.push([exprComponent, FAST_COMPONENT_WEIGHTS["expression"]]);
  }
  if (movementIntensity !== null) {
    fastParts.push([clip01(movementIntensity), FAST_COMPONENT_WEIGHTS["movement"]]);
  }
  const muse = museComponent(raw);
  if (muse !== null) {
    fastParts.push([muse, FAST_COMPONENT_WEIGHTS["muse"]]);
  }

  let fast: number | null = null;
  if (fastParts.length > 0) {
    const totalW = fastParts.reduce((sum, [, w]) => sum + w, 0);
    fast = fastParts.reduce((sum, [v, w]) => sum + v * w, 0) / totalW;
  }

  const slow = slowTrend(raw, sessionHrBaseline);

  if (fast !== null && slow !== null) {
    return clip01(FAST_WEIGHT * fast + SLOW_WEIGHT * slow);
  }
  if (fast !== null) {
    return clip01(fast);
  }
  if (slow !== null) {
    return clip01(0.5 + (slow - 0.5) * 0.6);
  }
  return 0.0;
}

function quadrant(arousal: number, valence: number): string {
  if (arousal >= 0.5) {
    return valence >= 0 ? "hype" : "tense";
  }
  return valence >= 0 ? "chill" : "sad";
}

/**
 * Computes arousal/valence for a single new reading, given the previous reading.
 */
export function annotatePoint(
  reading: SensorReading,
  prevReading: SensorReading | null,
): { arousal: number; valence: number; quadrant: string } {
  const prevRaw = prevReading ? prevReading.raw : null;
  const valence = deriveValence(reading.raw);
  const arousal = deriveArousal(reading.raw, prevRaw, reading.movement_intensity, RESTING_HR);

  return {
    arousal: parseFloat(arousal.toFixed(4)),
    valence: parseFloat(valence.toFixed(4)),
    quadrant: quadrant(arousal, valence),
  };
}