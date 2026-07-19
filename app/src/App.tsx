import { useCallback, useEffect, useState } from "react";
import { initApi } from "./api";
import AmbientSoundField from "./components/AmbientSoundField";
import CompareView from "./components/CompareView";
import ErrorToast from "./components/ErrorToast";
import Feed from "./components/Feed";
import LoadingState from "./components/LoadingState";
import MetricsView from "./components/MetricsView";
import MuseControl from "./components/MuseControl";
import ProfileView from "./components/ProfileView";
import type { Session } from "./types";

type View =
  | { name: "feed" }
  | { name: "profile" }
  | { name: "compare" }
  | { name: "biometrics" };

export default function App() {
  const museic = window.museic;
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState<View>({ name: "feed" });
  const [menuOpen, setMenuOpen] = useState(false);
  // Mount Biometrics once, then keep it (unmounting charts freezes the UI).
  const [biometricsMounted, setBiometricsMounted] = useState(false);
  useEffect(() => {
    if (view.name === "biometrics") setBiometricsMounted(true);
  }, [view.name]);

  const refreshSession = useCallback(async () => {
    if (!museic) {
      setSession(null);
      return;
    }
    setSession(await museic.getSession());
  }, [museic]);

  useEffect(() => {
    if (!museic) {
      setReady(true);
      return;
    }
    void (async () => {
      await initApi();
      await refreshSession();
      setReady(true);
    })();
    return museic.onAuthChanged(() => void refreshSession());
  }, [museic, refreshSession]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuOpen]);

  if (!ready) {
    return (
      <>
        <AmbientSoundField mode="login" />
        <LoadingState title="Loading Museic" variant="app" />
      </>
    );
  }

  if (!museic) {
    return (
      <>
        <AmbientSoundField mode="login" />
        <div className="center-page">
          <h1 className="logo">
            <span className="logo-muse">Muse</span>
            <span className="logo-ic">ic</span>
          </h1>
          <p className="muted">Open Museic in the desktop app to sign in and use live capture.</p>
          <p className="muted small">The browser preview is rendering correctly; Electron provides the secure app bridge.</p>
          <ErrorToast />
        </div>
      </>
    );
  }

  if (!session) {
    return (
      <>
        <AmbientSoundField mode="login" />
        <div className="center-page">
          <h1 className="logo">
            <span className="logo-muse">Muse</span>
            <span className="logo-ic">ic</span>
          </h1>
          <p className="muted">Music your body actually likes.</p>
          <button className="primary" onClick={() => void museic.login()}>
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
          <ErrorToast />
        </div>
      </>
    );
  }

  return (
    <div className="app">
      <AmbientSoundField mode={view.name} />
      <ErrorToast />
      <header className="topbar">
        <span className="logo" onClick={() => setView({ name: "feed" })}>
          <span className="logo-muse">Muse</span>
          <span className="logo-ic">ic</span>
        </span>
        <nav>
          <button
            data-label="Feed"
            className={view.name === "feed" ? "active" : ""}
            onClick={() => setView({ name: "feed" })}
          >
            Feed
          </button>
          <button
            data-label="Profile"
            className={view.name === "profile" ? "active" : ""}
            onClick={() => setView({ name: "profile" })}
          >
            Profile
          </button>
          <button
            data-label="Compare"
            className={view.name === "compare" ? "active" : ""}
            onClick={() => setView({ name: "compare" })}
          >
            Compare
          </button>
          <button
            data-label="Biometrics"
            className={view.name === "biometrics" ? "active" : ""}
            onClick={() => setView({ name: "biometrics" })}
          >
            Biometrics
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
                <button onClick={() => void museic.logout()}>Log out</button>
              </div>
            )}
          </div>
        </div>
      </header>
      <main>
        {/* Keep Feed/Profile mounted so data survives tab switches. */}
        <div
          className={view.name === "feed" ? "view-keep" : "view-keep view-keep-hidden"}
          aria-hidden={view.name !== "feed"}
        >
          <Feed userId={session.user?.sub ?? ""} active={view.name === "feed"} />
        </div>
        <div
          className={view.name === "profile" ? "view-keep" : "view-keep view-keep-hidden"}
          aria-hidden={view.name !== "profile"}
        >
          <ProfileView userId={session.user?.sub ?? ""} />
        </div>
        {/* Keep Biometrics mounted after first visit: tearing down ~13 Recharts
            + Presage on tab switch freezes the renderer. Pause via `active`. */}
        {biometricsMounted && (
          <div
            className={view.name === "biometrics" ? "view-keep" : "view-keep view-keep-hidden"}
            aria-hidden={view.name !== "biometrics"}
          >
            <MetricsView active={view.name === "biometrics"} />
          </div>
        )}
        {view.name === "compare" && <CompareView selfId={session.user?.sub ?? ""} />}
      </main>
    </div>
  );
}
