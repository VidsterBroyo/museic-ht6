import { useCallback, useEffect, useState } from "react";
import { initApi } from "./api";
import CompareView from "./components/CompareView";
import Feed from "./components/Feed";
import MetricsView from "./components/MetricsView";
import MuseControl from "./components/MuseControl";
import ProfileView from "./components/ProfileView";
import SongGraph from "./components/SongGraph";
import type { Session } from "./types";

type View =
  | { name: "feed" }
  | { name: "graph"; songId: string }
  | { name: "profile" }
  | { name: "compare" }
  | { name: "signals" };

export default function App() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState<View>({ name: "feed" });
  const [menuOpen, setMenuOpen] = useState(false);

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

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuOpen]);

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
        <div className="prelogin-muse">
          <MuseControl />
          <p className="muted small">
            No account needed to test your Muse headband — connect for a live signal preview.
          </p>
        </div>
      </div>
    );
  }

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
          <button
            className={view.name === "signals" ? "active" : ""}
            onClick={() => setView({ name: "signals" })}
          >
            Signals
          </button>
        </nav>
        <div className="user-box">
          <MuseControl />
          <div className="user-menu" onClick={(e) => e.stopPropagation()}>
            <button
              className="avatar-btn"
              title={session.user?.name ?? session.user?.sub}
              aria-label="Account menu"
              onClick={() => setMenuOpen((o) => !o)}
            >
              {session.user?.picture ? (
                <img className="avatar" src={session.user.picture} alt="" />
              ) : (
                <span className="avatar avatar-fallback">
                  {(session.user?.name ?? session.user?.sub ?? "?").charAt(0).toUpperCase()}
                </span>
              )}
            </button>
            {menuOpen && (
              <div className="user-dropdown">
                <button onClick={() => void window.museic.logout()}>Log out</button>
              </div>
            )}
          </div>
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
        {view.name === "signals" && <MetricsView />}
      </main>
    </div>
  );
}
