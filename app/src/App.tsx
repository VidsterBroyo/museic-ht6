import { useCallback, useEffect, useState } from "react";
import { initApi } from "./api";
import CompareView from "./components/CompareView";
import Feed from "./components/Feed";
import ProfileView from "./components/ProfileView";
import SongGraph from "./components/SongGraph";
import type { Session } from "./types";

type View =
  | { name: "feed" }
  | { name: "graph"; songId: string }
  | { name: "profile" }
  | { name: "compare" };

export default function App() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState<View>({ name: "feed" });
  const [copied, setCopied] = useState(false);

  const refreshSession = useCallback(async () => {
    setSession(await window.museic.getSession());
  }, []);

  useEffect(() => {
    void (async () => {
      await initApi();
      await refreshSession();
      setReady(true);
    })();
    return window.museic.onAuthChanged(() => void refreshSession());
  }, [refreshSession]);

  if (!ready) return <div className="center-page">loading…</div>;

  if (!session) {
    return (
      <div className="center-page">
        <h1 className="logo">Museic</h1>
        <p className="muted">Music your body actually likes.</p>
        <button className="primary" onClick={() => void window.museic.login()}>
          Log in with Auth0
        </button>
        <p className="muted small">
          Opens your system browser (Authorization Code + PKCE), then returns here via
          museic://callback.
        </p>
      </div>
    );
  }

  const copyToken = async () => {
    const s = await window.museic.getSession();
    if (s) {
      await navigator.clipboard.writeText(s.accessToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo" onClick={() => setView({ name: "feed" })}>
          Museic
        </span>
        <nav>
          <button
            className={view.name === "feed" ? "active" : ""}
            onClick={() => setView({ name: "feed" })}
          >
            Feed
          </button>
          <button
            className={view.name === "profile" ? "active" : ""}
            onClick={() => setView({ name: "profile" })}
          >
            My profile
          </button>
          <button
            className={view.name === "compare" ? "active" : ""}
            onClick={() => setView({ name: "compare" })}
          >
            Compare
          </button>
        </nav>
        <div className="user-box">
          <span className="muted small">{session.user?.name ?? session.user?.sub}</span>
          <button onClick={() => void copyToken()} title="For the Muse companion service (.env MUSE_USER_TOKEN)">
            {copied ? "Copied!" : "Copy API token"}
          </button>
          <button onClick={() => void window.museic.logout()}>Log out</button>
        </div>
      </header>
      <main>
        {view.name === "feed" && (
          <Feed onOpenGraph={(songId) => setView({ name: "graph", songId })} />
        )}
        {view.name === "graph" && (
          <SongGraph
            songId={view.songId}
            userId={session.user?.sub ?? ""}
            onBack={() => setView({ name: "feed" })}
          />
        )}
        {view.name === "profile" && <ProfileView userId={session.user?.sub ?? ""} />}
        {view.name === "compare" && <CompareView selfId={session.user?.sub ?? ""} />}
      </main>
    </div>
  );
}
