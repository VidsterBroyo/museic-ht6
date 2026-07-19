import { useEffect, useMemo, useState } from "react";
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
import { StyleInjector } from "./StyleInjector";

interface SavedFriend {
  id: string;
  name: string;
}

const friendStorageKey = (selfId: string) => `museic.compare.friends.${selfId}`;

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

/** Two-person live compatibility demo (RFC §6 compare). Both people react to
 * the same songs (side-by-side on one laptop, logged in as different Auth0
 * users), then this joins their curves on shared songs. */
export default function CompareView({ selfId }: { selfId: string }) {
  const [friends, setFriends] = useState<SavedFriend[]>([]);
  const [friendName, setFriendName] = useState("");
  const [friendId, setFriendId] = useState("");
  const [selectedFriendId, setSelectedFriendId] = useState("");
  const [data, setData] = useState<CompareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(friendStorageKey(selfId));
      if (!raw) return;
      const parsed = JSON.parse(raw) as SavedFriend[];
      const valid = parsed.filter((f) => f.id && f.name);
      setFriends(valid);
      setSelectedFriendId((current) => current || valid[0]?.id || "");
    } catch {
      /* saved friends are optional */
    }
  }, [selfId]);

  useEffect(() => {
    window.localStorage.setItem(friendStorageKey(selfId), JSON.stringify(friends));
  }, [friends, selfId]);

  const selectedFriend = useMemo(
    () => friends.find((friend) => friend.id === selectedFriendId) ?? null,
    [friends, selectedFriendId],
  );

  const saveFriend = () => {
    const id = friendId.trim();
    if (!id) return;
    const name = friendName.trim() || id;
    setFriends((prev) => {
      const next = prev.filter((friend) => friend.id !== id);
      return [...next, { id, name }].sort((a, b) => a.name.localeCompare(b.name));
    });
    setSelectedFriendId(id);
    setFriendName("");
    setFriendId("");
    setData(null);
    setError(null);
  };

  const removeFriend = (id: string) => {
    setFriends((prev) => prev.filter((friend) => friend.id !== id));
    setSelectedFriendId((current) => {
      if (current !== id) return current;
      const remaining = friends.filter((friend) => friend.id !== id);
      return remaining[0]?.id ?? "";
    });
    setData(null);
    setError(null);
  };

  const run = async () => {
    if (!selectedFriend) return;
    setError(null);
    setData(null);
    setLoading(true);
    try {
      setData(
        await api<CompareResponse>(
          `/compare/${encodeURIComponent(selfId)}/${encodeURIComponent(selectedFriend.id)}`,
        ),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="pad compare-page">
      <StyleInjector />
      <div className="compare-head">
        <div>
          <h1>Compare with friends</h1>
          <p className="muted small">
            You are <code>{selfId}</code> <CopyIdButton text={selfId} />.
          </p>
        </div>
        <button className="primary" disabled={!selectedFriend || loading} onClick={() => void run()}>
          {loading ? "Comparing..." : selectedFriend ? `Compare ${selectedFriend.name}` : "Select a friend"}
        </button>
      </div>

      <div className="compare-grid">
        <section className="compare-panel">
          <h2>Saved friends</h2>
          <div className="friend-list">
            {friends.length === 0 ? (
              <p className="muted small compare-empty">No friends saved yet.</p>
            ) : (
              friends.map((friend) => (
                <button
                  key={friend.id}
                  type="button"
                  className={`friend-row ${friend.id === selectedFriendId ? "selected" : ""}`}
                  onClick={() => {
                    setSelectedFriendId(friend.id);
                    setData(null);
                    setError(null);
                  }}
                >
                  <span>
                    <strong>{friend.name}</strong>
                    <small>{friend.id}</small>
                  </span>
                  <span className="friend-row-check">{friend.id === selectedFriendId ? "Selected" : "Select"}</span>
                </button>
              ))
            )}
          </div>
          {selectedFriend && (
            <button type="button" className="ghost compare-remove" onClick={() => removeFriend(selectedFriend.id)}>
              Remove selected
            </button>
          )}
        </section>

        <section className="compare-panel">
          <h2>Add friend</h2>
          <div className="compare-form">
            <input
              value={friendName}
              onChange={(e) => setFriendName(e.target.value)}
              placeholder="Friend name"
              spellCheck={false}
            />
            <input
              value={friendId}
              onChange={(e) => setFriendId(e.target.value)}
              placeholder="Friend user ID"
              spellCheck={false}
            />
            <button className="primary" disabled={!friendId.trim()} onClick={saveFriend}>
              Save friend
            </button>
          </div>
        </section>
      </div>

      {error && <p className="error">{error}</p>}
      {data && data.compatibility === null && (
        <p className="muted compare-result-note">
          No comparable data with {selectedFriend?.name ?? "this friend"} yet — {data.reason ?? "react to the same songs first."}
        </p>
      )}
      {data && data.compatibility !== null && (
        <>
          <div className="compat-score">
            <span className="big-number">{Math.round(data.compatibility * 100)}%</span>
            <span className="muted">
              {" "}
              with {selectedFriend?.name ?? "friend"} over {data.shared_songs.length} shared song(s)
            </span>
          </div>
          {data.shared_songs.map((s) => (
            <div key={s.song_id} className="chart-box">
              <h3>
                {s.title ?? s.song_id} <span className="muted">— {s.artist ?? ""}</span>{" "}
                {s.score !== null && <span className="tag">{Math.round(s.score * 100)}%</span>}
              </h3>
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={s.points} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid stroke="rgba(143, 143, 157, 0.28)" strokeDasharray="3 3" />
                  <XAxis dataKey="t" stroke="var(--muted)" />
                  <YAxis domain={[0, 1]} stroke="var(--muted)" />
                  <Tooltip
                    contentStyle={{ background: "var(--panel)", border: "1px solid var(--border)", color: "var(--text)" }}
                    labelFormatter={(t) => `t = ${t}s`}
                  />
                  <Legend />
                  <Line type="monotone" dataKey="arousal_a" stroke="#7A9BB8" dot={false} strokeWidth={2} name="you" />
                  <Line type="monotone" dataKey="arousal_b" stroke="#FF5D8F" dot={false} strokeWidth={2} name="them" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
