import { useEffect, useState } from "react";
import { api } from "../api";
import type { Profile, Recommendation } from "../types";

const QUADRANT_EMOJI: Record<string, string> = {
  hype: "🔥",
  chill: "🌊",
  sad: "🌧",
  tense: "⚡",
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
  const totalQ = quadrants.reduce((acc, [, n]) => acc + n, 0) || 1;

  return (
    <div className="pad">
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
          <div className="quadrants">
            {quadrants.map(([q, n]) => (
              <div key={q} className="quadrant">
                <span>{QUADRANT_EMOJI[q] ?? ""} {q}</span>
                <div className="bar">
                  <div className="fill" style={{ width: `${(n / totalQ) * 100}%` }} />
                </div>
                <span className="muted small">{Math.round((n / totalQ) * 100)}%</span>
              </div>
            ))}
          </div>
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
