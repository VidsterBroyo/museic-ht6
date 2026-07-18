/**
 * Presage SmartSpectra adapter (RFC §2/§5).
 *
 * Emits one SensorReading per second while capture is running. The renderer
 * stays dumb: it just tags each reading with the current song second and
 * batches it to the backend -- NO arousal/valence math happens on-device.
 *
 * ============================================================================
 * PLACEHOLDER -- REAL PRESAGE SDK WIRING NEEDED (see SETUP.md §b)
 * ============================================================================
 * Presage ships a Node.js/Electron SDK (Node 18+, Electron 28+) but the
 * package is distributed through their developer portal
 * (https://physiology.presagetech.com) rather than the public npm index, so
 * it cannot be pre-wired here. To integrate:
 *
 *   1. Get an API key + the Node/Electron SDK install instructions from the
 *      Presage developer portal (support@presagetech.com if unclear).
 *      NOTE: confirm macOS support for the Node/Electron SDK directly with
 *      Presage -- their C++ SDK documents macOS explicitly, the Electron
 *      wrapper does not as clearly.
 *   2. `npm install <presage-package>` in app/, then set PRESAGE_SDK_MODULE
 *      to the package name in the repo-root .env.
 *   3. Implement `startRealCapture` below: start continuous capture with
 *      PRESAGE_API_KEY, subscribe to core metrics (pulse rate, HRV Mean
 *      NN/RMSSD/SDNN, Baevsky stress index) and face analysis (expression
 *      classification + confidences, landmarks), then map each ~1 Hz payload
 *      into a SensorReading and call `emit`.
 *
 * Until then: if the module can't be loaded, the adapter falls back to a
 * clearly-labelled SIMULATION so the full pipeline (batching -> §5 derivation
 * -> graphs -> profile -> recommendations) can be built and demoed end-to-end.
 * ============================================================================
 */

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

let timer: ReturnType<typeof setInterval> | null = null;
let realStop: (() => void) | null = null;

export function isRunning(): boolean {
  return timer !== null || realStop !== null;
}

export function startCapture(emit: Emit): { mode: "presage" | "simulated" } {
  stopCapture();
  const moduleName = process.env.PRESAGE_SDK_MODULE;
  if (moduleName) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sdk = require(moduleName);
      realStop = startRealCapture(sdk, emit);
      return { mode: "presage" };
    } catch (err) {
      console.error(
        `Failed to load Presage SDK module "${moduleName}" -- falling back to simulation.`,
        err,
      );
    }
  } else {
    console.warn(
      "PRESAGE_SDK_MODULE not set -- using SIMULATED sensor data (see SETUP.md).",
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
  if (realStop) {
    realStop();
    realStop = null;
  }
}

// ---------------------------------------------------------------------------
// Real SDK integration point (see PLACEHOLDER block above).
// ---------------------------------------------------------------------------
function startRealCapture(_sdk: unknown, _emit: Emit): () => void {
  // TODO(you): start continuous capture with process.env.PRESAGE_API_KEY,
  // subscribe to core metrics + face analysis callbacks, map payloads into
  // SensorReading ({...raw fields..., movement_intensity}) and call _emit
  // roughly once per second. movement_intensity should come from frame-to-
  // frame face-landmark displacement (normalised 0..1) until/unless the SDK
  // exposes a better motion metric.
  throw new Error(
    "Presage SDK loaded but startRealCapture() is not implemented yet -- see app/electron/presage.ts",
  );
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
