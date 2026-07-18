import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api";
import type { SongGraphResponse } from "../types";

/** The per-song "graph of emotion overlaid on the music" (RFC §6 song-graph). */
export default function SongGraph({
  songId,
  userId,
  onBack,
}: {
  songId: string;
  userId: string;
  onBack: () => void;
}) {
  const [data, setData] = useState<SongGraphResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<SongGraphResponse>(
      `/song-graph/${encodeURIComponent(userId)}/${encodeURIComponent(songId)}`,
    )
      .then(setData)
      .catch((e) => setError(String(e)));
  }, [songId, userId]);

  if (error)
    return (
      <div className="pad">
        <button onClick={onBack}>← back</button>
        <p className="error">{error}</p>
        <p className="muted">React to this song first, then the graph will exist.</p>
      </div>
    );
  if (!data) return <div className="pad muted">loading graph…</div>;

  const { song, points } = data;
  return (
    <div className="pad">
      <button onClick={onBack}>← back to feed</button>
      <h2>
        {song.title} <span className="muted">— {song.artist || "unknown"}</span>
      </h2>
      <p className="muted small">
        {song.tempo_bpm} bpm · {song.key} · your reaction vs. the music, second by second
      </p>
      <div className="chart-box">
        <ResponsiveContainer width="100%" height={360}>
          <LineChart data={points} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid stroke="#2a2a35" strokeDasharray="3 3" />
            <XAxis dataKey="t" stroke="#888" label={{ value: "seconds", position: "insideBottomRight", offset: -4 }} />
            <YAxis domain={[-1, 1]} stroke="#888" />
            {song.sections.map((s) =>
              s.label === "high" ? (
                <ReferenceArea
                  key={`${s.start_s}-${s.end_s}`}
                  x1={s.start_s}
                  x2={s.end_s}
                  fill="#ffffff"
                  fillOpacity={0.04}
                />
              ) : null,
            )}
            <Tooltip
              contentStyle={{ background: "#17171f", border: "1px solid #333" }}
              labelFormatter={(t) => `t = ${t}s`}
            />
            <Legend />
            <Line type="monotone" dataKey="arousal" stroke="#ff5d8f" dot={false} strokeWidth={2} connectNulls name="arousal (you)" />
            <Line type="monotone" dataKey="valence" stroke="#5dd0ff" dot={false} strokeWidth={2} connectNulls name="valence (you)" />
            <Line type="monotone" dataKey="energy" stroke="#8f8f9d" dot={false} strokeDasharray="4 3" connectNulls name="song energy" />
            <Line type="monotone" dataKey="onset_density" stroke="#5a5a68" dot={false} strokeDasharray="2 4" connectNulls name="onset density" />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="muted small">
        Arousal is driven by fast signals (expression transitions, movement, Muse band power);
        HR/HRV only corroborate underneath. Shaded bands are high-energy song sections.
      </p>
    </div>
  );
}
