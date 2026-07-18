import { useEffect, useState } from "react";
import {
  Cell,
  ReferenceArea,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api";
import type { Profile, Recommendation } from "../types";
import { StyleInjector } from "./StyleInjector";

const QUADRANT_EMOJI: Record<string, string> = {
  hype: "🔥",
  chill: "🌊",
  sad: "🌧",
  tense: "⚡",
};

const QUADRANT_COLOR: Record<string, string> = {
  hype: "#ff4d6d",
  tense: "#a06bff",
  chill: "#3ea8ff",
  sad: "#5fd0c0",
};

export default function ProfileView({ userId }: { userId: string }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recs, setRecs] = useState<Recommendation[] | null>(null);
  const [mlInfo, setMlInfo] = useState<{
    active: boolean;
    training_rows: number;
    min_training_rows: number;
  } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<string | null>(null);

  useEffect(() => {
    api<Profile>(`/profile/${encodeURIComponent(userId)}`)
      .then(setProfile)
      .catch((e) => setError(String(e)));
  }, [userId]);

  const loadRecs = async () => {
    try {
      const r = await api<{
        recommendations: Recommendation[];
        ml?: { active: boolean; training_rows: number; min_training_rows: number };
      }>(
        `/recommendations/${encodeURIComponent(userId)}`,
        { method: "POST", body: {} },
      );
      setRecs(r.recommendations);
      setMlInfo(r.ml ?? null);
    } catch (e) {
      setError(String(e));
    }
  };

  const exportPlaylist = async () => {
    setExporting(true);
    setExportResult(null);
    try {
      const result = await api<{ playlist_url: string | null; added: number }>(
        "/playlist/export",
        { method: "POST", body: { name: "Museic picks" } },
      );
      setExportResult(
        result.playlist_url
          ? `Exported ${result.added} track(s): ${result.playlist_url}`
          : `Exported ${result.added} track(s).`,
      );
    } catch (e) {
      setExportResult(`Export failed — ${String(e)}`);
    } finally {
      setExporting(false);
    }
  };

  if (error) return <div className="pad error">{error}</div>;
  if (!profile) return <div className="pad muted">building your profile…</div>;

  const quadrants = Object.entries(profile.quadrant_counts ?? {});

  return (
    <div className="pad">
      <StyleInjector />
      <h2>Your music enjoyment profile</h2>
      <p className="muted small">
        user id: <code>{profile.user_id}</code> · {profile.n_moments} high-arousal moments captured
      </p>

      {profile.narrative ? (
        <blockquote className="narrative">{profile.narrative}</blockquote>
      ) : (
        <p className="muted">
          No narrative yet (Backboard.io key missing, or not enough reactions). React to a few
          songs first.
        </p>
      )}

      {quadrants.length > 0 && (
        <>
          <h3>Emotion quadrants</h3>
          <p className="muted small">
            Where your reactions land on arousal (calm → activated) × valence (unpleasant →
            pleasant). The bright dot is your overall average; faint dots are your biggest
            individual moments.
          </p>
          <QuadrantPlot profile={profile} />
        </>
      )}

      {profile.top_tags && Object.keys(profile.top_tags).length > 0 && (
        <>
          <h3>What your body responds to</h3>
          <div className="tags">
            {Object.entries(profile.top_tags)
              .slice(0, 14)
              .map(([tag, w]) => (
                <span key={tag} className={`tag ${w < 0 ? "neg" : ""}`}>
                  {tag}
                </span>
              ))}
          </div>
        </>
      )}

      {profile.arousal_peaks.length > 0 && (
        <>
          <h3>Biggest moments</h3>
          <ul className="peaks">
            {profile.arousal_peaks.map((p, i) => (
              <li key={i}>
                <strong>{p.title ?? p.song_id}</strong>
                {p.artist ? ` — ${p.artist}` : ""} @ {p.t}s{p.section ? ` (${p.section})` : ""} ·{" "}
                {QUADRANT_EMOJI[p.quadrant] ?? ""} arousal {(p.arousal * 100).toFixed(0)}%
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="row">
        <button className="primary" onClick={() => void loadRecs()}>
          Get recommendations
        </button>
        <button disabled={exporting} onClick={() => void exportPlaylist()}>
          {exporting ? "exporting…" : "Export playlist to Spotify"}
        </button>
      </div>
      {exportResult && <p className="muted small">{exportResult}</p>}

      {recs && (
        <>
          <h3>Recommended from the library</h3>
          {mlInfo && (
            <p className="muted small">
              ML predictor {mlInfo.active ? "active" : "warming up"} · {mlInfo.training_rows}/
              {mlInfo.min_training_rows} training moments
            </p>
          )}
          {recs.length === 0 && <p className="muted">Nothing new to recommend yet.</p>}
          <ol>
            {recs.map((r) => (
              <li key={r.song_id}>
                {r.title} {r.artist ? <span className="muted">— {r.artist}</span> : null}{" "}
                <span className="tag">{(r.score * 100).toFixed(0)}</span>
                {r.ml_score != null && (
                  <span className="muted small"> predicted arousal {(r.ml_score * 100).toFixed(0)}%</span>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

interface PeakDotProps {
  cx?: number;
  cy?: number;
  fill?: string;
}

function PeakDot(props: unknown) {
  const { cx, cy, fill } = props as PeakDotProps;
  if (cx == null || cy == null) return <g />;
  return <circle cx={cx} cy={cy} r={5} fill={fill} fillOpacity={0.45} />;
}

function YouDot(props: unknown) {
  const { cx, cy } = props as { cx?: number; cy?: number };
  if (cx == null || cy == null) return <g />;
  return (
    <g>
      <circle cx={cx} cy={cy} r={13} fill="#fff" fillOpacity={0.12} />
      <circle cx={cx} cy={cy} r={7} fill="#fff" />
    </g>
  );
}

function QuadrantPlot({ profile }: { profile: Profile }) {
  const peakPoints = profile.arousal_peaks.map((p) => ({
    valence: p.valence,
    arousal: p.arousal,
    label: p.title ?? p.song_id,
    quadrant: p.quadrant,
  }));

  const youPoint =
    profile.mean_arousal != null && profile.mean_valence != null
      ? [{ valence: profile.mean_valence, arousal: profile.mean_arousal }]
      : [];

  return (
    <div className="chart-box quadrant-plot">
      <div className="quadrant-frame">
        <span className="q-axis-label q-top">energetic</span>
        <span className="q-axis-label q-bottom">calm</span>
        <span className="q-axis-label q-left">negative</span>
        <span className="q-axis-label q-right">positive</span>
        <div className="quadrant-grid">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
              <ReferenceArea x1={0} x2={1} y1={0.5} y2={1} fill={QUADRANT_COLOR.hype} fillOpacity={0.28} stroke="none" />
              <ReferenceArea x1={-1} x2={0} y1={0.5} y2={1} fill={QUADRANT_COLOR.tense} fillOpacity={0.28} stroke="none" />
              <ReferenceArea x1={0} x2={1} y1={0} y2={0.5} fill={QUADRANT_COLOR.chill} fillOpacity={0.28} stroke="none" />
              <ReferenceArea x1={-1} x2={0} y1={0} y2={0.5} fill={QUADRANT_COLOR.sad} fillOpacity={0.28} stroke="none" />

              <XAxis type="number" dataKey="valence" domain={[-1, 1]} hide />
              <YAxis type="number" dataKey="arousal" domain={[0, 1]} hide />

              <Scatter data={peakPoints} isAnimationActive={false} shape={PeakDot}>
                {peakPoints.map((p, i) => (
                  <Cell key={i} fill={QUADRANT_COLOR[p.quadrant] ?? "var(--muted)"} />
                ))}
              </Scatter>

              {youPoint.length > 0 && (
                <Scatter data={youPoint} isAnimationActive={false} shape={YouDot} />
              )}
            </ScatterChart>
          </ResponsiveContainer>
          <div className="q-axis q-axis-x" />
          <div className="q-axis q-axis-y" />
        </div>
      </div>
    </div>
  );
}
