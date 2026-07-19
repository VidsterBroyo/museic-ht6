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

type Emit = (reading: SensorReading) => void;
type StatusEmit = (status: { code: number; hint: string }) => void;

let timer: ReturnType<typeof setInterval> | null = null;
let sdkInstance: SmartSpectraSDK | null = null;

export function isRunning(): boolean {
  return timer !== null || sdkInstance !== null;
}

export function startCapture(
  emit: Emit,
  onStatus: StatusEmit,
  opts?: { simulate?: boolean },
): { mode: "presage" | "simulated" } {
  stopCapture();
  if (process.env.PRESAGE_API_KEY && !opts?.simulate) {
    return startRealCapture(emit, onStatus);
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

function startSimulation(emit: Emit): void {
  let hr = 70;
  let movement = 0.1;
  const expressions = ["neutral", "happy", "surprise", "neutral", "neutral"];
  let exprIndex = 0;

  timer = setInterval(() => {
    hr += (Math.random() - 0.5) * 2;
    hr = Math.max(60, Math.min(120, hr));
    movement += (Math.random() - 0.5) * 0.1;
    movement = Math.max(0, Math.min(1, movement));
    if (Math.random() < 0.1) {
      exprIndex = (exprIndex + 1) % expressions.length;
    }

    emit({
      raw: {
        hr_bpm: Math.round(hr),
        hrv_rmssd: 40 + (Math.random() - 0.5) * 10,
        stress_index: 50 + (Math.random() - 0.5) * 20,
        expression: expressions[exprIndex],
        expression_confidence: 0.6 + Math.random() * 0.3,
        alpha_beta_ratio: null,
      },
      movement_intensity: movement,
      simulated: true,
    });
  }, 1000);
}

function startRealCapture(
  emit: Emit,
  onStatus: StatusEmit,
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
      onStatus({ code, hint });
      if (code !== 0) console.warn("Presage validation:", code, hint); // Keep logging for debug
    });
    sdk.on("error", (code, message, retryable) => {
      console.error("Presage SDK error", code, message, "retryable=", retryable);
    });

    sdk.useCamera({
      deviceIndex: Number(process.env.PRESAGE_CAMERA_INDEX ?? 0),
      width: Number(process.env.PRESAGE_CAMERA_WIDTH ?? 640),
      height: Number(process.env.PRESAGE_CAMERA_HEIGHT ?? 480),
      fps: Number(process.env.PRESAGE_CAMERA_FPS ?? 30),
    });
    sdk.start();
    sdkInstance = sdk;
    return { mode: "presage" };
  } catch (err) {
    console.error("Failed to start Presage SDK -- falling back to simulation.", err);
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

// This mapping should be verified against the Presage SDK documentation.
const EXPRESSION_NAMES: Record<number, string> = {
  0: "neutral",
  1: "happy",
  2: "sad",
  3: "anger",
  4: "fear",
  5: "surprise",
  6: "disgust",
  7: "contempt",
};

function pickTopExpression(scores: ExpressionScore[] | null | undefined): {
  name: string;
  confidence: number;
} | null {
  if (!scores || scores.length === 0) return null;
  const top = scores.reduce(
    (best, current) => ((current.confidence ?? 0) > (best.confidence ?? 0) ? current : best),
    scores[0],
  );
  if (top.type === null || top.type === undefined || top.confidence === null || top.confidence === undefined) {
    return null;
  }
  const name = EXPRESSION_NAMES[top.type];
  return name ? { name, confidence: top.confidence } : null;
}