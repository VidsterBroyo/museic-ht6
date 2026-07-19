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
  valence: number | null;      // -1..1 from facial expression
  movement: number | null;     // 0..1
  ratio: number | null;        // alpha/beta (EEG engagement)
  hr: number | null;           // bpm
  asymmetry: number | null;    // frontal alpha asymmetry: >0 approach/like, <0 withdraw/dislike
  frontalTheta: number | null; // relative frontal theta: emotional absorption / "being moved"
  mood: number | null;         // song mood: 0 = upbeat, 1 = tragic/sad, 0.5/null = unknown
}

// ---------------------------------------------------------------------------
// Song-mood store (renderer-global, no IPC). Feed sets this when a song plays so
// the enjoyment scorer — used by both the Signals graph and the top-bar pill —
// can adapt to genre (the "tragedy paradox": sad music is enjoyed differently).
// ---------------------------------------------------------------------------
let currentMood = 0.5;
const moodListeners = new Set<(m: number) => void>();

// Mood words -> bias. 1 = tragic/absorption-expected, 0 = upbeat/pleasure-expected.
const MOOD_BIAS: Record<string, number> = {
  sad: 1, sadness: 1, melancholic: 1, melancholy: 0.9, sombre: 0.9, somber: 0.9,
  mournful: 1, heartbreaking: 1, tragic: 1, sorrowful: 1, gloomy: 0.9, dark: 0.85,
  haunting: 0.85, brooding: 0.8, wistful: 0.8, longing: 0.8, nostalgic: 0.75,
  bittersweet: 0.75, poignant: 0.8, emotional: 0.75, tender: 0.7, reflective: 0.7,
  moody: 0.7, calm: 0.6, peaceful: 0.6, ambient: 0.6, dreamy: 0.6,
  happy: 0, joyful: 0, cheerful: 0, upbeat: 0, energetic: 0.05, fun: 0.05,
  playful: 0.05, exciting: 0.1, uplifting: 0.1, danceable: 0, euphoric: 0.05,
  party: 0, triumphant: 0.15, bright: 0.1, groovy: 0, hype: 0,
};

/** Map a song's mood tags to a 0..1 bias. Unknown tags are ignored; none -> 0.5. */
export function moodFromTags(tags?: string[] | null): number {
  if (!tags?.length) return 0.5;
  const hits = tags.map((t) => MOOD_BIAS[t.toLowerCase().trim()]).filter((v): v is number => v != null);
  return hits.length ? hits.reduce((a, b) => a + b, 0) / hits.length : 0.5;
}

/** Feed calls this on play (with the song's mood tags) and on stop (null). */
export function setEnjoymentMood(tags: string[] | null): void {
  currentMood = tags === null ? 0.5 : moodFromTags(tags);
  moodListeners.forEach((l) => l(currentMood));
}

export const getEnjoymentMood = (): number => currentMood;

/**
 * Rolling baseline for one signal (EMA mean + variance). `score` returns where the
 * current value sits relative to that baseline as 0..1 — 0.5 at your typical level,
 * higher when above, lower when below. This is the standard affective-computing move:
 * raw EEG band powers vary wildly per person/session, so we track relative change.
 */
interface Baseline { mean: number; var: number; init: boolean; lastX: number; last: number; }
const newBaseline = (): Baseline => ({ mean: 0, var: 1, init: false, lastX: NaN, last: 0.5 });

// alpha ~ 0.05 => ~20 s time constant, updated once per NEW reading (~1 Hz). A
// tighter window makes short-term deviations bigger, so the score actually swings.
// CRITICAL: the caller (Presage) fires ~30x/s and re-feeds the same persisted EEG
// value between the 1 Hz Muse updates. If we adapted on every call the baseline
// would chase the value in ~2 s and every component would collapse to 0.5 (flat).
// So we only move the baseline when the value actually changes; stale repeats just
// return the last score.
function relScore(b: Baseline, x: number, alpha = 0.05): number {
  if (!b.init) { b.mean = x; b.var = 1e-3; b.init = true; b.lastX = x; return 0.5; }
  if (x === b.lastX) return b.last;        // stale repeat -> don't move the baseline
  b.lastX = x;
  const std = Math.sqrt(Math.max(b.var, 1e-6));
  const z = (x - b.mean) / std;          // deviation from baseline, in std devs
  const d = x - b.mean;                    // update baseline AFTER scoring
  b.mean += alpha * d;
  b.var = (1 - alpha) * (b.var + alpha * d * d);
  b.last = clip01(0.5 + 0.5 * Math.tanh(z / 1.2)); // z=+1.2 -> ~0.88 (steeper = swingier)
  return b.last;
}

/** Score + the normalized 0..1 components behind it (0.5 = your baseline). */
export interface EnjoyResult {
  score: number | null;
  liking: number | null;      // baseline-relative FAA: >0.5 approach, <0.5 withdrawal
  engagement: number | null;
  absorption: number | null;
  groove: number | null;
  chills: number | null;
  pleasure: number | null;
  moved: number | null;
}
export type EnjoymentScorer = (i: EnjoyInputs) => EnjoyResult;

/** Weighted average over the non-null components; null if nothing is present. */
function wavg(parts: [number | null, number][]): number | null {
  const live = parts.filter((p): p is [number, number] => p[0] != null);
  if (!live.length) return null;
  const tw = live.reduce((s, [, w]) => s + w, 0);
  return live.reduce((s, [v, w]) => s + v * w, 0) / tw;
}

/**
 * Build a stateful "enjoyment" scorer (0..1). There are TWO neuroscientific routes
 * to enjoying music, and we score both (the "tragedy paradox": people love sad music):
 *
 *   PLEASURE route (happy / groove) — approach + body + attention:
 *     • Frontal alpha asymmetry (FAA)  -> LIKING (approach vs. withdrawal)
 *     • Head movement (Muse IMU)       -> GROOVE
 *     • Alpha/beta ratio               -> ENGAGEMENT
 *   BEING-MOVED route (sad / awe) — valence-FREE aesthetic absorption:
 *     • Frontal theta                  -> emotional ABSORPTION / being moved
 *     • Alpha/beta ratio               -> ENGAGEMENT (locked in)
 *     • Heart rate                     -> "chills" / frisson
 *
 * The song's `mood` blends the two: upbeat -> trust PLEASURE, tragic -> trust MOVED.
 * Crucially, for sad music a *negative* FAA no longer reads as dislike (it's the
 * sadness of a loved song). All EEG/HR signals are scored RELATIVE to the listener's
 * rolling baseline (adaptive normalization) — absolute values are anatomy-dominated,
 * and this also stops the curve flat-lining. Movement stays absolute (groove is groove).
 */
export function createEnjoymentScorer(): EnjoymentScorer {
  const bFaa = newBaseline();
  const bEeg = newBaseline();
  const bTheta = newBaseline();
  const bHr = newBaseline();
  return (i: EnjoyInputs): EnjoyResult => {
    const mood = i.mood ?? 0.5; // 0 upbeat .. 1 tragic
    const eng = i.ratio != null ? relScore(bEeg, 1 / (1 + i.ratio)) : null;
    const absorption = i.frontalTheta != null ? relScore(bTheta, i.frontalTheta) : null;
    const chills = i.hr != null ? relScore(bHr, i.hr) : null;
    const groove = i.movement != null ? clip01(Math.sqrt(clip01(i.movement))) : null;

    // Liking = FAA relative to YOUR baseline (raw FAA is anatomy/contact-biased, so
    // absolute sign is meaningless; 0.5 = your neutral). This is what we display.
    const liking = i.asymmetry != null ? relScore(bFaa, i.asymmetry) : null;
    // For the score only, discount liking's NEGATIVE half for sad music, so a
    // heartbreaking song a user loves isn't scored as dislike.
    let like = liking;
    if (like != null && like < 0.5) like = 0.5 - (0.5 - like) * (1 - mood);

    const pleasure = wavg([[like, 0.45], [groove, 0.40], [eng, 0.25]]);
    // Groove also counts when "moved" — people sway gently to sad music too.
    const moved = wavg([[absorption, 0.55], [eng, 0.30], [groove, 0.20], [chills, 0.15]]);

    const parts = { liking, engagement: eng, absorption, groove, chills, pleasure, moved };
    let e: number;
    if (pleasure == null && moved == null) {
      const fb = i.valence != null ? clip01(Math.max(0, i.valence)) : null;
      return { score: fb, ...parts };
    } else if (pleasure == null) e = moved!;
    else if (moved == null) e = pleasure;
    // Blend by mood, but never let a strong real signal on either route be buried.
    else e = Math.max((1 - mood) * pleasure + mood * moved, 0.85 * Math.max(pleasure, moved));

    // Only a genuine smile nudges up (≤ +0.1). Negative expressions are ignored —
    // the detector false-defaults to sad/angry at rest, so it's just noise.
    if (i.valence != null && i.valence > 0) {
      e += i.valence * 0.1 * (1 - e);
    }
    return { score: clip01(e), ...parts };
  };
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
  const inputs = useRef<EnjoyInputs>({
    valence: null, movement: null, ratio: null, hr: null,
    asymmetry: null, frontalTheta: null, mood: getEnjoymentMood(),
  });
  const camMove = useRef<number | null>(null);   // Presage lower-body micromotion
  const museMove = useRef<number | null>(null);   // Muse IMU head motion (preferred)
  const scorer = useRef<EnjoymentScorer>(createEnjoymentScorer());
  const [score, setScore] = useState<number | null>(null);

  useEffect(() => {
    // Muse head-bop beats Presage's glutes/knees micromotion for "groove".
    const bestMove = () => museMove.current ?? camMove.current;
    let pending: number | null = null;
    let lastFlush = 0;
    // Sensors can fire ~30 Hz; only push UI ~8 Hz (and skip no-op integer changes).
    const recompute = () => {
      const next = scorer.current({
        ...inputs.current, movement: bestMove(), mood: getEnjoymentMood(),
      }).score;
      const now = Date.now();
      const publish = () => {
        lastFlush = Date.now();
        pending = null;
        setScore((prev) => {
          if (prev == null || next == null) return next;
          if (Math.round(prev * 100) === Math.round(next * 100)) return prev;
          return next;
        });
      };
      if (now - lastFlush >= 125) publish();
      else if (pending == null) pending = window.setTimeout(publish, 125 - (now - lastFlush));
    };

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
      if (status.asymmetry != null) inputs.current = { ...inputs.current, asymmetry: status.asymmetry };
      if (status.frontalTheta != null) inputs.current = { ...inputs.current, frontalTheta: status.frontalTheta };
      recompute();
    });

    // Re-score when the song (mood) changes, even without a fresh sensor tick.
    moodListeners.add(recompute);
    return () => {
      offSensor();
      offMuse();
      moodListeners.delete(recompute);
      if (pending != null) clearTimeout(pending);
    };
  }, []);

  return score;
}
