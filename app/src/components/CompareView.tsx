import { useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api";
import type { CompareResponse } from "../types";

/** Two-person live compatibility demo (RFC §6 compare). Both people react to
 * the same songs (side-by-side on one laptop, logged in as different Auth0
 * users), then this joins their curves on shared songs. */
export default function CompareView({ selfId }: { selfId: string }) {
  const [otherId, setOtherId] = useState("");
  const [data, setData] = useState<CompareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setError(null);
    setData(null);
    setLoading(true);
    try {
      setData(
        await api<CompareResponse>(
          `/compare/${encodeURIComponent(selfId)}/${encodeURIComponent(otherId.trim())}`,
        ),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="pad">
      <h2>Compare two listeners</h2>
      <p className="muted small">
        You are <code>{selfId}</code>. Paste the other person's user id (their Auth0 sub — shown in
        their app's top bar / profile view).
      </p>
      <div className="row">
        <input
          value={otherId}
          onChange={(e) => setOtherId(e.target.value)}
          placeholder="auth0|other-user-id"
          spellCheck={false}
        />
        <button className="primary" disabled={!otherId.trim() || loading} onClick={() => void run()}>
          {loading ? "comparing…" : "Compare"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {data && data.compatibility === null && (
        <p className="muted">No comparable data yet — {data.reason ?? "react to the same songs first."}</p>
      )}
      {data && data.compatibility !== null && (
        <>
          <div className="compat-score">
            <span className="big-number">{Math.round(data.compatibility * 100)}%</span>
            <span className="muted"> music compatibility over {data.shared_songs.length} shared song(s)</span>
          </div>
          {data.shared_songs.map((s) => (
            <div key={s.song_id} className="chart-box">
              <h3>
                {s.title ?? s.song_id} <span className="muted">— {s.artist ?? ""}</span>{" "}
                {s.score !== null && <span className="tag">{Math.round(s.score * 100)}%</span>}
              </h3>
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={s.points} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid stroke="#2a2a35" strokeDasharray="3 3" />
                  <XAxis dataKey="t" stroke="#888" />
                  <YAxis domain={[0, 1]} stroke="#888" />
                  <Tooltip
                    contentStyle={{ background: "#17171f", border: "1px solid #333" }}
                    labelFormatter={(t) => `t = ${t}s`}
                  />
                  <Legend />
                  <Line type="monotone" dataKey="arousal_a" stroke="#ff5d8f" dot={false} strokeWidth={2} name="you" />
                  <Line type="monotone" dataKey="arousal_b" stroke="#ffd166" dot={false} strokeWidth={2} name="them" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
