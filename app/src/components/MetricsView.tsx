import { useCallback, useEffect, useRef, useState } from "react";
import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";
import MuseControl from "./MuseControl";
import type { MuseStatus, SensorReading } from "../types";

/**
 * Live "Signals" dashboard — a viewing/testing harness that plots every raw
 * metric the sensors emit, in a rolling window, with a one-line explanation of
 * each. Two independent sources feed it:
 *   - Presage camera (rPPG + face + micromotion): heart rate, HRV, stress,
 *     facial expression, movement.
 *   - Muse 2 EEG: the alpha/beta band-power ratio (its ONLY output).
 * Arousal/valence are NOT here — they're derived server-side at ingest and shown
 * on the per-song graph; this page is the raw upstream signals.
 */

const WINDOW = 120; // samples kept (~1–2 min at 1 Hz)

interface Sample {
  t: number; // seconds since capture started
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
}

const EMPTY_MUSE = {
  alpha_beta_ratio: null as number | null,
  delta: null as number | null,
  theta: null as number | null,
  alpha: null as number | null,
  beta: null as number | null,
  gamma: null as number | null,
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
  {
    key: "hr_bpm", label: "Heart rate", unit: "bpm", source: "camera", color: "#e66767",
    domain: [40, 160], format: (v) => `${Math.round(v)}`,
    explain: "Beats per minute from tiny colour changes in your face (rPPG). Climbs with arousal and exertion — a slow, corroborating signal.",
  },
  {
    key: "hrv_rmssd", label: "HRV (RMSSD)", unit: "ms", source: "camera", color: "#199e70",
    domain: [0, 120], format: (v) => `${Math.round(v)}`,
    explain: "Beat-to-beat variability. Higher = relaxed/parasympathetic; it drops as sympathetic (stress) arousal rises.",
  },
  {
    key: "stress_index", label: "Stress index", unit: "Baevsky", source: "camera", color: "#c98500",
    domain: [0, 150], format: (v) => `${Math.round(v)}`,
    explain: "Baevsky stress index derived from HRV. ~50 is typical; 100+ indicates high sympathetic load.",
  },
  {
    key: "movement_intensity", label: "Movement", unit: "0–1", source: "camera", color: "#3987e5",
    domain: [0, 1], format: (v) => `${Math.round(v * 100)}%`,
    explain: "Micromotion magnitude — how much you're physically moving. Head-bops and fidgets during a drop spike it (fast arousal signal).",
  },
  {
    key: "alpha_beta_ratio", label: "Alpha / Beta ratio", unit: "ratio · EEG", source: "muse", color: "#c98500",
    domain: [0, 3], format: (v) => v.toFixed(2),
    explain: "Alpha power ÷ beta power over a 3s window. Low = beta-dominant = engaged/aroused; high = alpha-dominant = relaxed. This is the ratio Museic feeds into arousal.",
  },
  {
    key: "delta", label: "Delta wave", unit: "1–4 Hz · % power", source: "muse", color: "#3987e5",
    domain: [0, 1], format: (v) => `${Math.round(v * 100)}%`,
    explain: "Slowest waves — deep dreamless sleep and unconscious processing. Dominant when very drowsy.",
  },
  {
    key: "theta", label: "Theta wave", unit: "4–8 Hz · % power", source: "muse", color: "#199e70",
    domain: [0, 1], format: (v) => `${Math.round(v * 100)}%`,
    explain: "Drowsy, meditative, daydreaming states; also tied to memory and emotional processing.",
  },
  {
    key: "alpha", label: "Alpha wave", unit: "8–12 Hz · % power", source: "muse", color: "#9085e9",
    domain: [0, 1], format: (v) => `${Math.round(v * 100)}%`,
    explain: "Relaxed but awake — calm focus, eyes-closed idling. High alpha = at ease.",
  },
  {
    key: "beta", label: "Beta wave", unit: "13–30 Hz · % power", source: "muse", color: "#d55181",
    domain: [0, 1], format: (v) => `${Math.round(v * 100)}%`,
    explain: "Alert, engaged, active concentration. Rises when you're locked in — the arousal-heavy band.",
  },
  {
    key: "gamma", label: "Gamma wave", unit: "30–44 Hz · % power", source: "muse", color: "#e66767",
    domain: [0, 1], format: (v) => `${Math.round(v * 100)}%`,
    explain: "Fastest waves — high-level perception and 'binding'. Small and noisy on consumer EEG.",
  },
];

const EXPRESSIONS_INFO =
  "Dominant facial expression + its confidence (Presage face model). This is what drives valence: happy/surprise → positive, sad/anger/fear/disgust → negative.";

export default function MetricsView() {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [cameraMode, setCameraMode] = useState<"presage" | "simulated" | null>(null);
  const [expression, setExpression] = useState<{ label: string; conf: number } | null>(null);
  const [simulate, setSimulate] = useState(false);

  const startRef = useRef<number | null>(null);
  const museLatestRef = useRef({ ...EMPTY_MUSE }); // carry EEG values across camera-only samples

  const push = useCallback((partial: Partial<Sample>) => {
    if (startRef.current === null) startRef.current = Date.now();
    const t = Math.round(((Date.now() - startRef.current) / 1000) * 10) / 10;
    setSamples((prev) => {
      const next = [
        ...prev,
        {
          t,
          hr_bpm: null,
          hrv_rmssd: null,
          stress_index: null,
          movement_intensity: null,
          ...museLatestRef.current,
          ...partial,
        },
      ];
      return next.length > WINDOW ? next.slice(next.length - WINDOW) : next;
    });
  }, []);

  // Camera stream (Presage / simulation).
  useEffect(() => {
    return window.museic.onSensorReading((reading: SensorReading) => {
      const r = reading.raw;
      if (r.expression) setExpression({ label: r.expression, conf: r.expression_confidence ?? 0 });
      push({
        hr_bpm: r.hr_bpm,
        hrv_rmssd: r.hrv_rmssd,
        stress_index: r.stress_index,
        movement_intensity: reading.movement_intensity,
      });
    });
  }, [push]);

  // Muse stream: capture the live ratio + per-band powers (MuseControl renders the toggle).
  useEffect(() => {
    return window.museic.onMuseStatus((status: MuseStatus) => {
      if (status.state !== "streaming") return;
      const upd: Partial<Sample> = {};
      if (status.lastRatio != null) upd.alpha_beta_ratio = status.lastRatio;
      if (status.bands) {
        for (const k of ["delta", "theta", "alpha", "beta", "gamma"] as const) {
          if (status.bands[k] != null) upd[k] = status.bands[k];
        }
      }
      if (Object.keys(upd).length === 0) return;
      museLatestRef.current = { ...museLatestRef.current, ...upd };
      push(upd);
    });
  }, [push]);

  const startCamera = useCallback(async () => {
    const { mode } = await window.museic.startCapture({ simulate });
    setCameraMode(mode);
  }, [simulate]);
  const stopCamera = useCallback(async () => {
    await window.museic.stopCapture();
    setCameraMode(null);
  }, []);

  // Stop the camera when leaving the page (don't leave it capturing in the background).
  useEffect(() => {
    return () => void window.museic.stopCapture();
  }, []);

  const clear = () => {
    setSamples([]);
    startRef.current = null;
    museLatestRef.current = { ...EMPTY_MUSE };
    setExpression(null);
  };

  const cameraOn = cameraMode !== null;
  const latest = samples.length ? samples[samples.length - 1] : null;

  return (
    <div className="pad metrics-view">
      <header className="metrics-head">
        <h2>Signals</h2>
        <p className="muted">
          Every raw metric the sensors emit, live — camera vitals, facial expression, and the five
          EEG brain-wave bands (δ/θ/α/β/γ) from the Muse. Start the camera and/or connect the Muse
          and watch them stream. A viewing &amp; testing harness.
        </p>
      </header>

      <div className="metrics-controls">
        <button className={cameraOn ? "" : "primary"} onClick={() => void (cameraOn ? stopCamera() : startCamera())}>
          {cameraOn ? "■ Stop camera" : "▶ Start camera"}
        </button>
        {cameraOn && (
          <span className={`chip ${cameraMode === "simulated" ? "chip-warn" : "chip-ok"}`}>
            camera: {cameraMode}
          </span>
        )}
        <MuseControl />
        <span className="spacer" />
        <label className="muse-sim small" title="Applies to a fresh camera/Muse start">
          <input type="checkbox" checked={simulate} onChange={(e) => setSimulate(e.target.checked)} />
          simulate
        </label>
        <button onClick={clear}>Clear</button>
      </div>

      {cameraMode === "simulated" && (
        <div className="banner warn">
          Camera data is SIMULATED (no PRESAGE_API_KEY / SDK) — values are plausible fakes for testing.
        </div>
      )}

      <div className="metrics-grid">
        {METRICS.filter((m) => m.source === "camera").map((m) => (
          <MetricCard key={m.key} def={m} samples={samples} value={latest ? latest[m.key] : null} />
        ))}
        <ExpressionCard expression={expression} />
        {METRICS.filter((m) => m.source === "muse").map((m) => (
          <MetricCard key={m.key} def={m} samples={samples} value={latest ? latest[m.key] : null} />
        ))}
      </div>

      <section className="metrics-explainer">
        <h3>Derived &amp; song metrics (not raw sensor streams)</h3>
        <p className="muted small">
          These aren't shown above because they're computed, not sensed. They live on the per-song
          graph (open a song → “View my graph”).
        </p>
        <ul className="metrics-defs">
          <li><b>Arousal</b> — fused intensity (0–1). Fast tier: expression shifts (40%), movement (35%), Muse α/β (25%); heart rate &amp; HRV corroborate slowly underneath.</li>
          <li><b>Valence</b> — pleasant ↔ unpleasant (−1…+1), mapped from the dominant facial expression × its confidence.</li>
          <li><b>Quadrant</b> — arousal × valence bucket: hype / tense / chill / sad.</li>
          <li><b>Song energy</b> — per-second loudness/RMS from the track (librosa), the “music” reference curve.</li>
          <li><b>Spectral brightness</b> — spectral centroid; how treble-heavy the moment is.</li>
          <li><b>Onset density</b> — note/attack rate per second; busier = higher.</li>
        </ul>
      </section>
    </div>
  );
}

function MetricCard({ def, samples, value }: { def: MetricDef; samples: Sample[]; value: number | null }) {
  const data = samples.map((s) => ({ t: s.t, v: s[def.key] }));
  const hasData = data.some((d) => d.v != null);
  return (
    <div className="metric-card">
      <div className="metric-card-head">
        <span className="metric-label">{def.label}</span>
        <span className={`chip chip-${def.source}`}>{def.source}</span>
      </div>
      <div className="metric-value">
        {value != null ? def.format(value) : "—"}
        <span className="metric-unit">{def.unit}</span>
      </div>
      <div className="metric-spark">
        {hasData ? (
          <ResponsiveContainer width="100%" height={64}>
            <LineChart data={data} margin={{ top: 4, right: 2, bottom: 0, left: 2 }}>
              <YAxis domain={def.domain} hide />
              <Line
                type="monotone"
                dataKey="v"
                stroke={def.color}
                strokeWidth={2}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            </LineChart>
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
        <span className="metric-label">Facial expression</span>
        <span className="chip chip-camera">camera</span>
      </div>
      <div className="metric-value expression-value">
        {expression ? expression.label : "—"}
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
      <p className="metric-explain small muted">{EXPRESSIONS_INFO}</p>
    </div>
  );
}
