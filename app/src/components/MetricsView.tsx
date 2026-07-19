import { useCallback, useEffect, useRef, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";
import MuseControl from "./MuseControl";
import type { MuseStatus, SensorReading, ValidationStatus } from "../types";
import { EXPRESSION_VALENCE, clip01, createEnjoymentScorer, getEnjoymentMood, type EnjoyInputs, type EnjoymentScorer, type EnjoyResult } from "../enjoyment";

/**
 * Live "Signals" dashboard — a viewing/testing harness that plots every raw
 * metric the sensors emit. Camera (Presage): heart rate, HRV, stress, movement,
 * facial expression. Muse EEG: alpha/beta ratio + the five band powers.
 */

const WINDOW = 240; // samples kept (~4 min at 1 Hz)
const GAP_MS = 3000; // silence before we start inventing values for a source

interface Sample {
  t: number;
  hr_bpm: number | null;
  hrv_rmssd: number | null;
  stress_index: number | null;
  movement_intensity: number | null;
  alpha_beta_ratio: number | null;
  delta: number | null;
  theta: number | null;
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  muse_movement: number | null; // head motion from the Muse IMU (accel + gyro)
  asymmetry: number | null; // raw frontal alpha asymmetry (anatomy/contact-biased; not displayed)
  frontal_theta: number | null; // frontal theta: emotional absorption / being moved
  liking: number | null; // baseline-relative FAA (0.5 = neutral); what the score uses
  enjoyment: number | null; // experimental fused score
}

// ---------------------------------------------------------------------------
// Dynamic gap-fill simulators (renderer-side). Only used when a real source has
// gone quiet — see the gap-filler effect. Mirrors the backend's fake generators.
// ---------------------------------------------------------------------------
const SIM_EXPRESSIONS = ["neutral", "happy", "surprise", "sad", "fear"];

interface CamSimState {
  hr: number;
  excitement: number; // slow latent state the fakes follow
  expression: string;
}

function stepCameraSim(s: CamSimState): {
  reading: Partial<Sample>;
  expression: { label: string; conf: number };
  valence: number;
  movement: number;
  hr: number;
  next: CamSimState;
} {
  let excitement = s.excitement + (Math.random() - 0.48) * 0.08;
  if (Math.random() < 0.04) excitement += 0.5; // occasional "drop hit"
  excitement = clip01(excitement * 0.97);
  const hr = s.hr + (65 + excitement * 25 - s.hr) * 0.08 + (Math.random() - 0.5) * 1.2;
  let expression = s.expression;
  if (Math.random() < 0.06 + excitement * 0.2) {
    expression =
      excitement > 0.55
        ? Math.random() < 0.7 ? "happy" : "surprise"
        : SIM_EXPRESSIONS[Math.floor(Math.random() * SIM_EXPRESSIONS.length)];
  }
  const conf = Math.round((0.5 + Math.random() * 0.5) * 100) / 100;
  const movement = clip01(0.1 + excitement * 0.6 + (Math.random() - 0.5) * 0.15);
  return {
    reading: {
      hr_bpm: Math.round(hr),
      hrv_rmssd: Math.round((55 - excitement * 30 + (Math.random() - 0.5) * 6) * 10) / 10,
      stress_index: Math.round(40 + excitement * 60 + (Math.random() - 0.5) * 8),
      movement_intensity: movement,
    },
    expression: { label: expression, conf },
    valence: (EXPRESSION_VALENCE[expression] ?? 0) * conf,
    movement,
    hr,
    next: { hr, excitement, expression },
  };
}

function stepMuseSim(): Partial<Sample> {
  const alpha = 0.12 + Math.random() * 0.1;
  const beta = 0.35 + Math.random() * 0.15;
  return {
    delta: 0.08 + Math.random() * 0.06,
    theta: 0.05 + Math.random() * 0.05,
    alpha,
    beta,
    gamma: 0.2 + Math.random() * 0.15,
    alpha_beta_ratio: Math.round((alpha / beta) * 100) / 100,
    muse_movement: clip01(0.1 + Math.random() * 0.3),
    asymmetry: Math.round((Math.random() - 0.5) * 1.2 * 100) / 100,
    frontal_theta: Math.round((0.05 + Math.random() * 0.1) * 1000) / 1000,
  };
}

const EMPTY_MUSE = {
  alpha_beta_ratio: null as number | null,
  delta: null as number | null,
  theta: null as number | null,
  alpha: null as number | null,
  beta: null as number | null,
  gamma: null as number | null,
  muse_movement: null as number | null,
  asymmetry: null as number | null,
  frontal_theta: null as number | null,
};

type MetricKey = keyof Omit<Sample, "t">;

interface MetricDef {
  key: MetricKey;
  label: string;
  unit: string;
  source: "camera" | "muse";
  color: string;
  domain: [number | "auto", number | "auto"];
  format: (v: number) => string;
  explain: string;
}

const METRICS: MetricDef[] = [
  { key: "hr_bpm", label: "Heart rate", unit: "bpm", source: "camera", color: "#3F6634",
    domain: [40, 160], format: (v) => `${Math.round(v)}`, explain: "Pulse from facial colour (rPPG)." },
  { key: "hrv_rmssd", label: "HRV", unit: "ms RMSSD", source: "camera", color: "#4FB477",
    domain: [0, 120], format: (v) => `${Math.round(v)}`, explain: "Beat-to-beat variability; drops with stress." },
  { key: "stress_index", label: "Stress", unit: "Baevsky", source: "camera", color: "#2f8f5a",
    domain: [0, 150], format: (v) => `${Math.round(v)}`, explain: "HRV-based load. ~50 typical, 100+ high." },
  { key: "alpha_beta_ratio", label: "Alpha / Beta ratio", unit: "ratio", source: "muse", color: "#2f8f5a",
    domain: [0, 3], format: (v) => v.toFixed(2), explain: "Low = engaged, high = relaxed. Feeds arousal." },
  { key: "delta", label: "Delta", unit: "1–4 Hz", source: "muse", color: "#12cbbb",
    domain: [0, 1], format: (v) => `${Math.round(v * 100)}%`, explain: "Deep sleep / very drowsy." },
  { key: "theta", label: "Theta", unit: "4–8 Hz", source: "muse", color: "#4FB477",
    domain: [0, 1], format: (v) => `${Math.round(v * 100)}%`, explain: "Drowsy, meditative, daydreaming." },
  { key: "alpha", label: "Alpha", unit: "8–12 Hz", source: "muse", color: "#52FFEE",
    domain: [0, 1], format: (v) => `${Math.round(v * 100)}%`, explain: "Relaxed but awake, calm focus." },
  { key: "beta", label: "Beta", unit: "13–30 Hz", source: "muse", color: "#3F6634",
    domain: [0, 1], format: (v) => `${Math.round(v * 100)}%`, explain: "Alert, engaged, concentrating." },
  { key: "gamma", label: "Gamma", unit: "30–44 Hz", source: "muse", color: "#2f8f5a",
    domain: [0, 1], format: (v) => `${Math.round(v * 100)}%`, explain: "Fast; perception. Noisy on consumer EEG." },
  { key: "muse_movement", label: "Head movement", unit: "%", source: "muse", color: "#12cbbb",
    domain: [0, 1], format: (v) => `${Math.round(v * 100)}%`, explain: "Head-bop / nod from the Muse accelerometer + gyroscope." },
  { key: "liking", label: "Liking (vs your baseline)", unit: "/100", source: "muse", color: "#4FB477",
    domain: [0, 1], format: (v) => `${Math.round(v * 100)}`,
    explain: "Frontal alpha asymmetry, scored against YOUR baseline. 50 = neutral, >50 = approach/liking, <50 = withdrawal. (Raw FAA is anatomy/contact-biased, so absolute sign is meaningless.)" },
  { key: "frontal_theta", label: "Absorption (frontal theta)", unit: "%", source: "muse", color: "#52FFEE",
    domain: ["auto", "auto"], format: (v) => `${Math.round(v * 100)}%`,
    explain: "Frontal theta (AF7/AF8). Rises with deep emotional absorption / being moved — how sad music is enjoyed." },
];

export default function MetricsView() {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [parts, setParts] = useState<EnjoyResult | null>(null); // live enjoyment breakdown (debug)
  const [cameraMode, setCameraMode] = useState<"presage" | "simulated" | null>(null);
  const [expression, setExpression] = useState<{ label: string; conf: number } | null>(null);
  const [autofill, setAutofill] = useState(false);
  const [filling, setFilling] = useState<{ cam: boolean; muse: boolean }>({ cam: false, muse: false });
  const [showPreview, setShowPreview] = useState(false); // opt-in webcam self-view (experimental)
  const [feedError, setFeedError] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationStatus | null>(null);

  const startRef = useRef<number | null>(null);
  const museLatestRef = useRef({ ...EMPTY_MUSE });
  const enjoyRef = useRef<EnjoyInputs>({ valence: null, movement: null, ratio: null, hr: null, asymmetry: null, frontalTheta: null, mood: null });
  const scorerRef = useRef<EnjoymentScorer>(createEnjoymentScorer());
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Freshness tracking for the dynamic gap-filler.
  const lastCamRef = useRef(0);       // ms of last REAL camera reading
  const lastMuseRef = useRef(0);      // ms of last REAL muse data
  const cameraOnRef = useRef(false);
  const museStateRef = useRef<MuseStatus["state"]>("stopped");
  const camSimRef = useRef<CamSimState>({ hr: 70, excitement: 0.2, expression: "neutral" });
  const camMoveRef = useRef<number | null>(null);  // Presage lower-body micromotion
  const museMoveRef = useRef<number | null>(null); // Muse IMU head motion (preferred)
  cameraOnRef.current = cameraMode !== null;

  // Sensors stream at up to ~30 Hz; committing every reading to React state would
  // re-render ~13 charts 30x/s (heavy, esp. with HW accel off) and can hang/crash
  // the renderer. We buffer into refs and flush to state at ~8 Hz instead.
  const pendingRef = useRef<Sample[]>([]);           // samples awaiting a flush
  const lastPartsRef = useRef<EnjoyResult | null>(null);
  const expressionRef = useRef<{ label: string; conf: number } | null>(null);
  const validationRef = useRef<ValidationStatus | null>(null);

  // Muse head-bop is a better "groove" signal than Presage's glutes/knees.
  const bestMovement = () => museMoveRef.current ?? camMoveRef.current;

  const push = useCallback((partial: Partial<Sample>) => {
    if (startRef.current === null) startRef.current = Date.now();
    const t = Math.round(((Date.now() - startRef.current) / 1000) * 10) / 10;
    const res = scorerRef.current({ ...enjoyRef.current, mood: getEnjoymentMood() });
    lastPartsRef.current = res;
    pendingRef.current.push({
      t, hr_bpm: null, hrv_rmssd: null, stress_index: null, movement_intensity: null,
      ...museLatestRef.current, ...partial, liking: res.liking, enjoyment: res.score,
    });
  }, []);

  // Flush buffered readings to React state at ~8 Hz. setState with an unchanged
  // ref is a no-op re-render (React bails via Object.is), so idle signals are free.
  useEffect(() => {
    const id = setInterval(() => {
      if (pendingRef.current.length) {
        const batch = pendingRef.current;
        pendingRef.current = [];
        setSamples((prev) => {
          const next = prev.concat(batch);
          return next.length > WINDOW ? next.slice(next.length - WINDOW) : next;
        });
      }
      setParts(lastPartsRef.current);
      setExpression(expressionRef.current);
      setValidation(validationRef.current);
    }, 125);
    return () => clearInterval(id);
  }, []);

  // Camera stream (Presage / simulation).
  useEffect(() => {
    return window.museic.onSensorReading((reading: SensorReading) => {
      lastCamRef.current = Date.now(); // real data arrived -> no need to invent
      const r = reading.raw;
      if (r.expression) expressionRef.current = { label: r.expression, conf: r.expression_confidence ?? 0 };
      const valence = r.expression
        ? (EXPRESSION_VALENCE[r.expression.toLowerCase()] ?? 0) * (r.expression_confidence ?? 0)
        : enjoyRef.current.valence;
      camMoveRef.current = reading.movement_intensity ?? camMoveRef.current;
      enjoyRef.current = {
        ...enjoyRef.current,
        valence,
        movement: bestMovement(),
        hr: r.hr_bpm ?? enjoyRef.current.hr,
      };
      push({ hr_bpm: r.hr_bpm, hrv_rmssd: r.hrv_rmssd, stress_index: r.stress_index, movement_intensity: reading.movement_intensity });
    });
  }, [push]);

  // Presage capture-quality / error status (buffered; flushed at ~8 Hz).
  useEffect(() => {
    return window.museic.onValidation((status: ValidationStatus) => { validationRef.current = status; });
  }, []);

  // Muse stream: live ratio + per-band powers.
  useEffect(() => {
    return window.museic.onMuseStatus((status: MuseStatus) => {
      museStateRef.current = status.state;
      if (status.state !== "streaming") return;
      const upd: Partial<Sample> = {};
      if (status.lastRatio != null) upd.alpha_beta_ratio = status.lastRatio;
      // `movement` present on a reading (number or explicit null); undefined on
      // posted/initial statuses. Only touch it when the reading actually carries it.
      if (status.movement !== undefined) {
        upd.muse_movement = status.movement;
        museMoveRef.current = status.movement;
      }
      if (status.asymmetry != null) upd.asymmetry = status.asymmetry;
      if (status.frontalTheta != null) upd.frontal_theta = status.frontalTheta;
      if (status.bands) {
        for (const k of ["delta", "theta", "alpha", "beta", "gamma"] as const) {
          if (status.bands[k] != null) upd[k] = status.bands[k];
        }
      }
      if (Object.keys(upd).length === 0) return;
      lastMuseRef.current = Date.now(); // real data arrived
      museLatestRef.current = { ...museLatestRef.current, ...upd };
      // Feed EEG engagement, liking (asymmetry) + head movement into enjoyment.
      const ratio = upd.alpha_beta_ratio ?? (upd.alpha != null && upd.beta ? upd.alpha / upd.beta : null);
      enjoyRef.current = {
        ...enjoyRef.current,
        ratio: ratio ?? enjoyRef.current.ratio,
        asymmetry: upd.asymmetry ?? enjoyRef.current.asymmetry,
        frontalTheta: upd.frontal_theta ?? enjoyRef.current.frontalTheta,
        movement: bestMovement(),
      };
      push(upd);
    });
  }, [push]);

  // Dynamic gap-filler: when a live source stops producing (face lost, headband
  // dropped, failed to start) invent plausible values so the graphs keep moving.
  // Real data always wins — the moment it returns, freshness updates and we stop.
  useEffect(() => {
    const id = setInterval(() => {
      if (!autofill) {
        setFilling((f) => (f.cam || f.muse ? { cam: false, muse: false } : f));
        return;
      }
      const now = Date.now();
      let cam = false;
      let muse = false;

      if (cameraOnRef.current && now - lastCamRef.current > GAP_MS) {
        const r = stepCameraSim(camSimRef.current);
        camSimRef.current = r.next;
        expressionRef.current = r.expression;
        enjoyRef.current = { ...enjoyRef.current, valence: r.valence, movement: r.movement, hr: r.hr };
        push(r.reading);
        cam = true;
      }

      const ms = museStateRef.current;
      if ((ms === "streaming" || ms === "error") && now - lastMuseRef.current > GAP_MS) {
        const upd = stepMuseSim();
        museLatestRef.current = { ...museLatestRef.current, ...upd };
        museMoveRef.current = upd.muse_movement ?? museMoveRef.current;
        enjoyRef.current = {
          ...enjoyRef.current,
          ratio: upd.alpha_beta_ratio ?? enjoyRef.current.ratio,
          asymmetry: upd.asymmetry ?? enjoyRef.current.asymmetry,
          frontalTheta: upd.frontal_theta ?? enjoyRef.current.frontalTheta,
          movement: bestMovement(),
        };
        push(upd);
        muse = true;
      }

      setFilling((prev) => (prev.cam === cam && prev.muse === muse ? prev : { cam, muse }));
    }, 1000);
    return () => clearInterval(id);
  }, [autofill, push]);

  const startCamera = useCallback(async () => {
    lastCamRef.current = Date.now(); // grace period before gap-filling kicks in
    const { mode } = await window.museic.startCapture();
    setCameraMode(mode);
  }, []);

  const stopCamera = useCallback(async () => {
    await window.museic.stopCapture();
    setCameraMode(null);
    setValidation(null);
  }, []);

  // Optional webcam self-view. Off by default: it opens the camera a SECOND time
  // (Presage already holds it) and heavy GPU video compositing has crashed some
  // Macs — hence opt-in. Only runs while the checkbox is on and the camera is up.
  const stopFeed = useCallback(() => {
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setFeedError(null);
  }, []);

  useEffect(() => {
    if (!(showPreview && cameraMode !== null)) {
      stopFeed();
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
        if (cancelled) { stream.getTracks().forEach((tr) => tr.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setFeedError(null);
      } catch (e) {
        setFeedError((e as Error).message || String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [showPreview, cameraMode, stopFeed]);

  // Auto-start the camera when the Signals view opens (Muse auto-connects via
  // <MuseControl autoStart/>). Runs on mount; the cleanup below stops it.
  useEffect(() => {
    void startCamera();
  }, [startCamera]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      void window.museic.stopCapture();
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
    };
  }, []);

  const clear = () => {
    pendingRef.current = [];
    setSamples([]);
    startRef.current = null;
    museLatestRef.current = { ...EMPTY_MUSE };
    expressionRef.current = null;
    setExpression(null);
  };

  const cameraOn = cameraMode !== null;
  const latest = samples.length ? samples[samples.length - 1] : null;
  const showValidation = validation && validation.code !== 0 && cameraMode === "presage";

  const cameraMetrics = METRICS.filter((m) => m.source === "camera");
  const museMetrics = METRICS.filter((m) => m.source === "muse");

  return (
    <div className="pad metrics-view">
      <header className="metrics-head">
        <h2>Signals</h2>
        <p className="muted small">
          Live raw sensor streams — camera vitals + the Muse EEG bands. Start a source to watch.
        </p>
      </header>

      <div className="metrics-controls">
        <button className={cameraOn ? "" : "primary"} onClick={() => void (cameraOn ? stopCamera() : startCamera())}>
          {cameraOn ? "■ Stop camera" : "▶ Start camera"}
        </button>
        <MuseControl autoStart />
        <span className="spacer" />
        <label className="muse-sim small" title="When the camera or Muse goes quiet, invent plausible values so the graphs keep moving. Real data always takes over when it returns.">
          <input type="checkbox" checked={autofill} onChange={(e) => setAutofill(e.target.checked)} />
          fill gaps with simulated data
        </label>
        <label className="muse-sim small" title="Experimental: opens the webcam a second time for a self-view. Can be heavy on some Macs.">
          <input type="checkbox" checked={showPreview} onChange={(e) => setShowPreview(e.target.checked)} />
          camera preview
        </label>
        <button onClick={clear}>Clear</button>
      </div>

      {cameraMode === "simulated" && (
        <div className="banner warn">Camera data is SIMULATED — plausible fakes for testing.</div>
      )}
      {(filling.cam || filling.muse) && (
        <div className="banner warn">
          Sensor quiet — filling {filling.cam && filling.muse ? "camera + Muse" : filling.cam ? "camera" : "Muse"} gaps with simulated data.
        </div>
      )}
      {showValidation && (
        <div className="banner err">Presage: {validation!.hint || `status ${validation!.code}`}</div>
      )}
      {feedError && (
        <div className="banner warn">Camera preview unavailable: {feedError}</div>
      )}

      {showPreview && cameraOn && (
        <div className="camera-feed">
          <video ref={videoRef} muted playsInline className="camera-video" />
          <span className="camera-feed-tag small">webcam preview (experimental)</span>
        </div>
      )}

      <EnjoymentCard samples={samples} value={latest ? latest.enjoyment : null} parts={parts} />

      <div className="metrics-group-title">Camera</div>
      <div className="metrics-grid">
        {cameraMetrics.map((m) => (
          <MetricCard key={m.key} def={m} samples={samples} value={latest ? latest[m.key] : null} />
        ))}
        <ExpressionCard expression={expression} />
      </div>

      <div className="metrics-group-title">Brain waves · Muse EEG</div>
      <div className="metrics-grid">
        {museMetrics.map((m) => (
          <MetricCard key={m.key} def={m} samples={samples} value={latest ? latest[m.key] : null} />
        ))}
      </div>

      <section className="metrics-explainer">
        <h3>Derived &amp; song metrics</h3>
        <p className="muted small">Computed, not sensed — shown on a song's graph, not here.</p>
        <ul className="metrics-defs small">
          <li><b>Arousal</b> — fused intensity: expression, movement, Muse α/β; HR/HRV corroborate.</li>
          <li><b>Valence</b> — pleasant ↔ unpleasant, from facial expression.</li>
          <li><b>Quadrant</b> — arousal × valence: hype / tense / chill / sad.</li>
          <li><b>Energy · brightness · onset</b> — the track's own per-second audio curves.</li>
        </ul>
      </section>
    </div>
  );
}

/**
 * Fit the Y-axis to the data that's actually there (with a little headroom), so
 * a small signal (Theta 3%) fills its card instead of hugging the bottom of a
 * fixed 0..1 axis. A flat line gets centred rather than stretched to noise.
 */
function adaptiveDomain(values: number[]): [number, number] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = max === min ? (Math.abs(max) || 1) * 0.25 + 1e-6 : (max - min) * 0.15;
  return [min - pad, max + pad];
}

// Light centred moving-average for the plotted line only (display, not stored).
// Rounds off per-frame jitter without lagging like a time-based EMA would at 30 fps.
type Pt = { t: number; v: number | null };
function smoothSeries(data: Pt[], w = 3): Pt[] {
  return data.map((d, i) => {
    if (d.v == null) return d;
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(data.length - 1, i + w); j++) {
      const vv = data[j].v;
      if (vv != null) { sum += vv; n++; }
    }
    return { t: d.t, v: n ? sum / n : d.v };
  });
}

/**
 * Prominent, experimental "enjoyment" readout. Fuses positive valence, groove,
 * EEG engagement and arousal into one 0..1 curve (see createEnjoymentScorer).
 */
function EnjoymentCard({ samples, value, parts }: { samples: Sample[]; value: number | null; parts: EnjoyResult | null }) {
  const data = smoothSeries(samples.map((s) => ({ t: s.t, v: s.enjoyment })));
  const hasData = data.some((d) => d.v != null);
  const pct = value != null ? Math.round(value * 100) : null;
  return (
    <div className="metric-card enjoyment-card">
      <div className="metric-card-head">
        <span className="metric-label">
          Enjoyment <span className="tag-exp">experimental</span>
        </span>
        <span className="metric-value">
          {pct != null ? `${pct}` : "—"}
          <span className="metric-unit">/ 100</span>
        </span>
      </div>
      <div className="metric-spark enjoyment-spark">
        {hasData ? (
          <ResponsiveContainer width="100%" height={170}>
            <AreaChart data={data} margin={{ top: 6, right: 0, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="grad-enjoyment" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#52FFEE" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="#4FB477" stopOpacity={0} />
                </linearGradient>
              </defs>
              <YAxis domain={[0, 1]} hide />
              <Area type="monotone" dataKey="v" stroke="#4FB477" strokeWidth={3}
                fill="url(#grad-enjoyment)" dot={false} connectNulls isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="metric-empty small muted">start the camera or Muse</div>
        )}
      </div>
      {parts && (
        <div className="enjoy-parts small muted">
          {([
            ["liking", parts.liking], ["engage", parts.engagement], ["absorb", parts.absorption],
            ["groove", parts.groove], ["chills", parts.chills],
            ["pleasure", parts.pleasure], ["moved", parts.moved],
          ] as [string, number | null][]).map(([k, v]) => (
            <span key={k} className="enjoy-part">
              {k} <b>{v == null ? "—" : Math.round(v * 100)}</b>
            </span>
          ))}
        </div>
      )}
      <p className="metric-explain small muted">
        Live 0–100 components (50 = your baseline). If a component sits at ~50 it isn't moving — that signal is flat, not the maths. Two routes, blended by mood: <b>pleasure</b> (liking + groove + engage) for upbeat, <b>moved</b> (absorb + engage + groove + chills) for sad. Groove now counts in both. EEG/HR are baseline-relative; movement is absolute.
      </p>
    </div>
  );
}

function MetricCard({ def, samples, value }: { def: MetricDef; samples: Sample[]; value: number | null }) {
  const data = smoothSeries(samples.map((s) => ({ t: s.t, v: s[def.key] })));
  const values = data.map((d) => d.v).filter((v): v is number => v != null);
  const hasData = values.length > 0;
  const domain = hasData ? adaptiveDomain(values) : def.domain;
  const gid = `grad-${def.key}`;
  return (
    <div className="metric-card">
      <div className="metric-card-head">
        <span className="metric-label">{def.label}</span>
        <span className="metric-value">
          {value != null ? def.format(value) : "—"}
          <span className="metric-unit">{def.unit}</span>
        </span>
      </div>
      <div className="metric-spark">
        {hasData ? (
          <ResponsiveContainer width="100%" height={120}>
            <AreaChart data={data} margin={{ top: 6, right: 0, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={def.color} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={def.color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <YAxis domain={domain} hide />
              <Area type="monotone" dataKey="v" stroke={def.color} strokeWidth={2.5}
                fill={`url(#${gid})`} dot={false} connectNulls isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="metric-empty small muted">
            {def.source === "muse" ? "connect the Muse" : "start the camera"}
          </div>
        )}
      </div>
      <p className="metric-explain small muted">{def.explain}</p>
    </div>
  );
}

function ExpressionCard({ expression }: { expression: { label: string; conf: number } | null }) {
  return (
    <div className="metric-card">
      <div className="metric-card-head">
        <span className="metric-label">Expression</span>
        <span className="metric-value expression-value">{expression ? expression.label : "—"}</span>
      </div>
      <div className="metric-spark expression-conf">
        {expression ? (
          <>
            <div className="bar">
              <div className="fill" style={{ width: `${Math.round(expression.conf * 100)}%` }} />
            </div>
            <span className="small muted">{Math.round(expression.conf * 100)}% confidence</span>
          </>
        ) : (
          <div className="metric-empty small muted">start the camera</div>
        )}
      </div>
      <p className="metric-explain small muted">Dominant expression; drives valence.</p>
    </div>
  );
}
