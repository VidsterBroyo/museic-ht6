/**
 * Presage SmartSpectra adapter (RFC §2/§5).
 *
 * Emits one SensorReading per second while capture is running. The renderer
 * stays dumb: it just tags each reading with the current song second and
 * batches it to the backend -- NO arousal/valence math happens on-device.
 *
 * Real SmartSpectra SDK wiring. If PRESAGE_API_KEY is missing or the native
 * runtime cannot start, the adapter falls back to clearly-labelled simulation
 * so the rest of the demo stays usable.
 */

import type { SmartSpectraSDK } from "@smartspectra/node-sdk";

interface SmartSpectraModule {
  SmartSpectraSDK: typeof SmartSpectraSDK;
  breathingMetrics: number[];
  cardioMetrics: number[];
  faceMetrics: number[];
  micromotionMetrics: number[];
}

export interface SensorReading {
  raw: {
    hr_bpm: number | null;
    hrv_rmssd: number | null;
    stress_index: number | null;
    expression: string | null;
    expression_confidence: number | null;
    alpha_beta_ratio: null; // always null from this source; Muse fills it
  };
  movement_intensity: number | null;
  simulated: boolean;
}

export interface ValidationStatus {
  code: number;
  hint: string;
}

type Emit = (reading: SensorReading) => void;
type EmitValidation = (status: ValidationStatus) => void;

let timer: ReturnType<typeof setInterval> | null = null;
let sdkInstance: SmartSpectraSDK | null = null;

export function isRunning(): boolean {
  return timer !== null || sdkInstance !== null;
}

export function startCapture(
  emit: Emit,
  onValidation?: EmitValidation,
  opts?: { simulate?: boolean },
): { mode: "presage" | "simulated" } {
  stopCapture();
  if (opts?.simulate) {
    // Explicit request (e.g. the Signals test page) -- skip the real SDK.
    startSimulation(emit);
    return { mode: "simulated" };
  }
  if (process.env.PRESAGE_API_KEY) {
    return startRealCapture(emit, onValidation);
  } else {
    console.warn(
      "PRESAGE_API_KEY not set -- using SIMULATED sensor data (see SETUP.md).",
    );
  }
  startSimulation(emit);
  return { mode: "simulated" };
}

export function stopCapture(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (sdkInstance) {
    const sdk = sdkInstance;
    sdkInstance = null;
    sdk.stop();
    void sdk.destroy().catch((err) => console.error("Presage SDK destroy failed", err));
  }
}

// ---------------------------------------------------------------------------
// Real SDK integration.
// ---------------------------------------------------------------------------
function startRealCapture(
  emit: Emit,
  onValidation?: EmitValidation,
): { mode: "presage" | "simulated" } {
  try {
    const {
      SmartSpectraSDK,
      breathingMetrics,
      cardioMetrics,
      faceMetrics,
      micromotionMetrics,
    } = require("@smartspectra/node-sdk") as SmartSpectraModule;
    const { decodeMetrics } = require("@smartspectra/node-sdk/messages") as {
      decodeMetrics: (buf: Uint8Array | ArrayBuffer) => unknown;
    };

    const sdk = new SmartSpectraSDK({
      apiKey: process.env.PRESAGE_API_KEY,
      requestedMetrics: [
        ...breathingMetrics,
        ...cardioMetrics,
        ...faceMetrics,
        ...micromotionMetrics,
      ],
    });

    sdk.on("metrics", (buf) => {
      try {
        const metrics = decodeMetrics(buf);
        emit(readingFromMetrics(metrics));
      } catch (err) {
        console.error("Failed to decode Presage metrics", err);
      }
    });
    sdk.on("validationStatus", (code, _ts, hint) => {
      if (code !== 0) console.warn("Presage validation:", code, hint);
      onValidation?.({ code, hint: hint ?? "" });
    });
    sdk.on("error", (code, message, retryable) => {
      console.error("Presage SDK error", code, message, "retryable=", retryable);
      onValidation?.({ code: code || -1, hint: message ? `Presage error: ${message}` : "Presage SDK error" });
    });

    sdk.useCamera({
      deviceIndex: Number(process.env.PRESAGE_CAMERA_INDEX ?? 0),
      width: Number(process.env.PRESAGE_CAMERA_WIDTH ?? 1280),
      height: Number(process.env.PRESAGE_CAMERA_HEIGHT ?? 720),
      fps: Number(process.env.PRESAGE_CAMERA_FPS ?? 30),
    });
    sdk.start();
    sdkInstance = sdk;
    return { mode: "presage" };
  } catch (err) {
    console.error("Failed to start Presage SDK -- falling back to simulation.", err);
    onValidation?.({ code: -1, hint: "Presage SDK failed to start — using simulation." });
    startSimulation(emit);
    return { mode: "simulated" };
  }
}

function readingFromMetrics(metrics: unknown): SensorReading {
  const m = metrics as {
    cardio?: {
      pulseRate?: MetricValue[];
      hrv?: HrvValue[];
    } | null;
    face?: {
      expression?: ExpressionValue[];
    } | null;
    micromotion?: {
      glutes?: MetricValue[];
      knees?: MetricValue[];
    } | null;
  };
  const pulse = latest(m.cardio?.pulseRate);
  const hrv = latest(m.cardio?.hrv);
  const expression = latest(m.face?.expression);
  const topExpression = pickTopExpression(expression?.scores);
  const movement = deriveMovementIntensity(m.micromotion);

  return {
    raw: {
      hr_bpm: numberOrNull(pulse?.value),
      hrv_rmssd: numberOrNull(hrv?.rmssd),
      stress_index: numberOrNull(hrv?.baevsky),
      expression: topExpression?.name ?? null,
      expression_confidence: topExpression ? topExpression.confidence / 100 : null,
      alpha_beta_ratio: null,
    },
    movement_intensity: movement,
    simulated: false,
  };
}

interface MetricValue {
  value?: number | null;
}

interface HrvValue {
  rmssd?: number | null;
  baevsky?: number | null;
}

interface ExpressionValue {
  scores?: ExpressionScore[];
}

interface ExpressionScore {
  type?: number | null;
  confidence?: number | null;
}

function latest<T>(values: T[] | null | undefined): T | null {
  return values && values.length > 0 ? values[values.length - 1] : null;
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function deriveMovementIntensity(
  micromotion: { glutes?: MetricValue[]; knees?: MetricValue[] } | null | undefined,
): number | null {
  const values = [latest(micromotion?.glutes)?.value, latest(micromotion?.knees)?.value]
    .map(numberOrNull)
    .filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  const mean = values.reduce((sum, v) => sum + Math.abs(v), 0) / values.length;
  return Math.round(Math.max(0, Math.min(1, mean)) * 100) / 100;
}

function pickTopExpression(scores: ExpressionScore[] | null | undefined): {
  name: string;
  confidence: number;
} | null {
  if (!scores || scores.length === 0) return null;
  const top = scores.reduce((best, score) => {
    const confidence = numberOrNull(score.confidence) ?? -1;
    return confidence > ((numberOrNull(best.confidence) ?? -1)) ? score : best;
  }, scores[0]);
  const confidence = numberOrNull(top.confidence);
  if (confidence === null || confidence < 0) return null;
  return { name: expressionName(top.type), confidence };
}

function expressionName(type: number | null | undefined): string {
  switch (type) {
    case 1:
      return "anger";
    case 2:
      return "contempt";
    case 3:
      return "disgust";
    case 4:
      return "fear";
    case 5:
      return "happy";
    case 6:
      return "neutral";
    case 7:
      return "sad";
    case 8:
      return "surprise";
    default:
      return "neutral";
  }
}

// ---------------------------------------------------------------------------
// Simulation: plausible 1 Hz physiology so the pipeline is demoable without
// the SDK. Every reading is flagged simulated: true.
// ---------------------------------------------------------------------------
const EXPRESSIONS = ["neutral", "happy", "surprise", "sad", "anger", "disgust", "contempt", "fear"];

function startSimulation(emit: Emit): void {
  let hr = 68 + Math.random() * 10;
  let expression = "neutral";
  let excitement = 0.2; // slow-moving latent state the fake signals follow

  timer = setInterval(() => {
    // Latent excitement drifts, with occasional spikes (a "drop hit" moment).
    excitement += (Math.random() - 0.48) * 0.08;
    if (Math.random() < 0.04) excitement += 0.5;
    excitement = Math.max(0, Math.min(1, excitement * 0.97));

    hr += (65 + excitement * 25 - hr) * 0.08 + (Math.random() - 0.5) * 1.2;

    if (Math.random() < 0.06 + excitement * 0.2) {
      expression =
        excitement > 0.55
          ? Math.random() < 0.7
            ? "happy"
            : "surprise"
          : EXPRESSIONS[Math.floor(Math.random() * EXPRESSIONS.length)];
    }

    emit({
      raw: {
        hr_bpm: Math.round(hr),
        hrv_rmssd: Math.round((55 - excitement * 30 + (Math.random() - 0.5) * 6) * 10) / 10,
        stress_index: Math.round(40 + excitement * 60 + (Math.random() - 0.5) * 8),
        expression,
        expression_confidence: Math.round((0.5 + Math.random() * 0.5) * 100) / 100,
        alpha_beta_ratio: null,
      },
      movement_intensity:
        Math.round(Math.max(0, Math.min(1, excitement * 0.8 + (Math.random() - 0.4) * 0.3)) * 100) /
        100,
      simulated: true,
    });
  }, 1000);
}
