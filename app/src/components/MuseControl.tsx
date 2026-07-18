import { useEffect, useState } from "react";
import type { MuseStatus } from "../types";
import { useEnjoyment } from "../enjoyment";

/**
 * Top-bar control for the in-app Muse companion service (RFC §2). Toggles the
 * Python service that the Electron main process spawns; the user's token is
 * injected automatically, so no manual copy/paste. Optional Muse signal, so
 * this is deliberately unobtrusive and never blocks the rest of the app.
 */
export default function MuseControl({ autoStart = false }: { autoStart?: boolean }) {
  const [status, setStatus] = useState<MuseStatus>({ state: "stopped" });
  const enjoyment = useEnjoyment();

  useEffect(() => {
    void window.museic.getMuseStatus().then(setStatus);
    return window.museic.onMuseStatus(setStatus);
  }, []);

  // Optional: connect on mount (e.g. the Signals view). Only if nothing's running.
  useEffect(() => {
    if (!autoStart) return;
    let cancelled = false;
    (async () => {
      const s = await window.museic.getMuseStatus();
      if (cancelled || s.state !== "stopped") return;
      setStatus({ state: "starting" });
      setStatus(await window.museic.startMuse());
    })();
    return () => { cancelled = true; };
  }, [autoStart]);

  const busy = status.state === "starting" || status.state === "connecting";
  const active = status.state === "streaming";

  const toggle = async () => {
    if (active || busy) {
      await window.museic.stopMuse();
    } else {
      setStatus({ state: "starting" });
      const next = await window.museic.startMuse();
      setStatus(next);
    }
  };

  return (
    <span className={`muse-pill muse-${status.state}`} title={label(status)}>
      <button className="muse-toggle" onClick={() => void toggle()}>
        {active || busy ? "◼ Muse" : "◎ Connect Muse"}
      </button>
      <span className="muse-state small">{shortLabel(status, enjoyment)}</span>
    </span>
  );
}

function shortLabel(s: MuseStatus, enjoyment: number | null): string {
  switch (s.state) {
    case "stopped":
      return "";
    case "starting":
      return "starting…";
    case "connecting":
      return "connecting…";
    case "streaming": {
      const dot = s.preview ? "◐" : "●";
      if (enjoyment != null) return `${dot} enjoy ${Math.round(enjoyment * 100)}`;
      if (s.simulated) return `${dot} sim`;
      return s.preview ? `${dot} preview` : `${dot} live`;
    }
    case "error":
      return "error";
  }
}

function label(s: MuseStatus): string {
  switch (s.state) {
    case "stopped":
      return "Connect your Muse 2 headband (powered on, in range)";
    case "starting":
      return "Launching the Muse service…";
    case "connecting":
      return "Connecting over Bluetooth (can take ~20s)…";
    case "streaming":
      if (s.preview)
        return "Live band power (preview — log in to save reactions to your profile)";
      return s.simulated
        ? "Streaming synthetic band power (simulation)"
        : `Streaming EEG band power${s.posted ? ` · ${s.posted} readings posted` : ""}`;
    case "error":
      return s.message;
  }
}
