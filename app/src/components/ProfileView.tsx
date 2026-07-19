import { useCallback, useEffect, useState } from "react";
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
import type { Insights, Profile, Recommendation } from "../types";
import LoadingState from "./LoadingState";
import { StyleInjector } from "./StyleInjector";

const QUADRANT_EMOJI: Record<string, string> = {
  hype: "🔥",
  chill: "🌊",
  sad: "🌧",
  tense: "⚡",
};

const QUADRANT_COLOR: Record<string, string> = {
  hype: "#FF5D8F",
  tense: "#E8A84A",
  chill: "#7A9BB8",
  sad: "#5A6A8A",
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
  // Set when export fails because Token Vault has no Spotify token for this user
  // yet. Prompts the Connected Accounts ("Connect Spotify") flow to populate it.
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadProfile = useCallback(
    async (forceRefresh = false) => {
      const path = `/profile/${encodeURIComponent(userId)}`;
      try {
        if (forceRefresh) {
          // Bypass the TTL cache and regenerate the profile server-side.
          setProfile(await api<Profile>(`${path}?refresh=true`));
          return;
        }
        const p = await api<Profile>(path);
        // Old cached blurbs have no **bold** markers — force one regen for the short form.
        if (p.narrative && !p.narrative.includes("**")) {
          setProfile(await api<Profile>(`${path}?refresh=true`));
        } else {
          setProfile(p);
        }
      } catch (e) {
        setError(String(e));
      }
    },
    [userId],
  );

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  const refreshProfile = async () => {
    setRefreshing(true);
    setError(null);
    await loadProfile(true);
    setRefreshing(false);
  };

  // Fires when the Connect Spotify flow completes (Token Vault now populated).
  useEffect(() => {
    return window.museic.onSpotifyConnected(() => {
      setNeedsReconnect(false);
      setConnecting(false);
      setExportResult("Spotify connected. Click “Export playlist to Spotify” to try again.");
    });
  }, []);

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
    setNeedsReconnect(false);
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
      const msg = String(e);
      // Auth0 Token Vault has no Spotify refresh token for this user yet.
      if (
        msg.includes("federated_connection_refresh_token_not_found") ||
        msg.includes("connected their Spotify")
      ) {
        setNeedsReconnect(true);
        setExportResult(
          "Museic isn't connected to your Spotify account yet. Connect Spotify to authorize " +
            "playlist export, then try again.",
        );
      } else {
        setExportResult(`Export failed — ${msg}`);
      }
    } finally {
      setExporting(false);
    }
  };

  const connectSpotify = async () => {
    setConnecting(true);
    setExportResult(null);
    try {
      await window.museic.connectSpotify();
      setExportResult(
        "Opening your browser to connect Spotify… approve access there, then return here and export again.",
      );
    } catch (e) {
      setExportResult(`Couldn't start Spotify connection — ${String(e)}`);
    } finally {
      setConnecting(false);
    }
  };

  if (error) return <div className="pad error">{error}</div>;
  if (!profile) return <LoadingState title="Building your profile" variant="profile" />;

  const quadrants = Object.entries(profile.quadrant_counts ?? {});

  // Show each song at most once in "Biggest moments", keeping its highest peak.
  const seenPeakSongs = new Set<string>();
  const uniquePeaks = [...profile.arousal_peaks]
    .sort((a, b) => b.arousal - a.arousal)
    .filter((p) => {
      if (seenPeakSongs.has(p.song_id)) return false;
      seenPeakSongs.add(p.song_id);
      return true;
    });

  return (
    <div className="pad profile-view">
      <StyleInjector />
      <h1>Your music enjoyment profile</h1>

      {profile.narrative ? (
        <blockquote className="narrative">
          <NarrativeText text={profile.narrative} />
        </blockquote>
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

      {profile.insights && <InsightsSection insights={profile.insights} />}

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

      {uniquePeaks.length > 0 && (
        <>
          <h3>Biggest moments</h3>
          <ul className="peaks">
            {uniquePeaks.map((p, i) => (
              <li key={i}>
                {p.album_art_b64 ? (
                  <img
                    className="peak-art"
                    src={`data:${p.album_art_mime || "image/jpeg"};base64,${p.album_art_b64}`}
                    alt=""
                  />
                ) : (
                  <span className="peak-art peak-art-fallback" aria-hidden />
                )}
                <div className="peak-body">
                  <div className="peak-title">
                    <strong>{p.title ?? p.song_id}</strong>
                    {p.artist ? <span className="muted"> — {p.artist}</span> : null}
                  </div>
                  <div className="peak-meta muted small">
                    @{p.t}s{p.section ? ` (${p.section})` : ""} ·{" "}
                    {QUADRANT_EMOJI[p.quadrant] ?? ""} arousal {(p.arousal * 100).toFixed(0)}%
                  </div>
                </div>
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
        {needsReconnect && (
          <button className="primary" disabled={connecting} onClick={() => void connectSpotify()}>
            {connecting ? "connecting…" : "Connect Spotify"}
          </button>
        )}
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

      <p className="muted small profile-userid">
        user id: <code>{profile.user_id}</code>{" "}
        <CopyIdButton text={profile.user_id} />
      </p>

      <div className="refresh-row">
        <button
          type="button"
          className="refresh-btn"
          disabled={refreshing}
          onClick={() => void refreshProfile()}
        >
          {refreshing ? "refreshing…" : "↻ Refresh"}
        </button>
      </div>
    </div>
  );
}

function CopyIdButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <span className="copy-id-wrap">
      <button type="button" className="copy-id-btn" onClick={() => void copy()} aria-label="Copy user id">
        Copy
      </button>
      {copied && (
        <span className="copy-id-tip" role="status">
          Copied!
        </span>
      )}
    </span>
  );
}

/** Renders `**bold**` markers from the narrative string as <strong>. */
function NarrativeText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("**") && part.endsWith("**") ? (
          <strong key={i}>{part.slice(2, -2)}</strong>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function InsightsSection({ insights }: { insights: Insights }) {
  const { sonic_signature: sig, top_songs: top, crowd } = insights;
  const hasCrowd = crowd && crowd.n_listeners >= 3;

  if (!sig && (!top || top.length === 0) && !hasCrowd) return null;

  return (
    <>
      <h3>Your music DNA</h3>
      <div className="dna-grid">
        {sig && (
          <div className="dna-card">
            <div className="dna-card-title">Sonic signature</div>
            <div className="dna-big">
              {sig.sweet_spot_bpm} <span className="dna-unit">BPM</span>
            </div>
            <div className="muted small">
              your sweet spot ({sig.tempo_low}–{sig.tempo_high} BPM)
            </div>
            {sig.dominant_mode && sig.minor_pct != null && sig.major_pct != null && (
              <div className="dna-mode">
                <div className="dna-mode-bar">
                  <div
                    className="dna-mode-fill minor"
                    style={{ width: `${Math.round(sig.minor_pct * 100)}%` }}
                  />
                  <div
                    className="dna-mode-fill major"
                    style={{ width: `${Math.round(sig.major_pct * 100)}%` }}
                  />
                </div>
                <div className="muted small">
                  {Math.round((sig.dominant_mode === "minor" ? sig.minor_pct : sig.major_pct) * 100)}%{" "}
                  {sig.dominant_mode} keys
                  {sig.top_key ? ` · most often ${sig.top_key}` : ""}
                </div>
              </div>
            )}
          </div>
        )}

        {hasCrowd && crowd && (
          <div className="dna-card">
            <div className="dna-card-title">You vs. the crowd</div>
            <CrowdBar label="Energy" pct={crowd.energy_pct} highWord="more energetic" lowWord="more chill" />
            <CrowdBar label="Positivity" pct={crowd.positivity_pct} highWord="more upbeat" lowWord="more moody" />
            <CrowdBar label="Tempo" pct={crowd.tempo_pct} highWord="likes it faster" lowWord="likes it slower" />
            <div className="muted small">across {crowd.n_listeners} listeners</div>
          </div>
        )}
      </div>

      {top && top.length > 0 && (
        <>
          <h3>Top 5 most enjoyed</h3>
          <ol className="top-songs">
            {top.map((s) => (
              <li key={s.song_id}>
                <span className="top-song-name">
                  <strong>{s.title ?? s.song_id}</strong>
                  {s.artist ? <span className="muted"> — {s.artist}</span> : null}
                </span>
                <span className="tag">{Math.round(s.enjoyment * 100)}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </>
  );
}

function CrowdBar({
  label,
  pct,
  highWord,
  lowWord,
}: {
  label: string;
  pct: number | null | undefined;
  highWord: string;
  lowWord: string;
}) {
  if (pct == null) return null;
  const p = Math.round(pct * 100);
  const above = p >= 50;
  const phrase = above ? `${highWord} than ${p}%` : `${lowWord} than ${100 - p}%`;
  return (
    <div className="crowd-row">
      <span className="crowd-label">{label}</span>
      <div className="crowd-bar">
        <div className="crowd-fill" style={{ width: `${p}%` }} />
        <div className="crowd-mid" />
      </div>
      <span className="muted small crowd-phrase">{phrase}</span>
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
      <circle cx={cx} cy={cy} r={13} fill="#FF5D8F" fillOpacity={0.22} />
      <circle cx={cx} cy={cy} r={7} fill="#FF5D8F" />
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
