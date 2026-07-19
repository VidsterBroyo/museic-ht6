import { useEffect, useState } from "react";
import type { MuseStatus } from "../types";

/**
 * Fixed bottom-right toast for Muse (and later other) errors.
 * Dismiss with ×; a new distinct error shows again.
 */
export default function ErrorToast() {
  const [message, setMessage] = useState<string | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  useEffect(() => {
    const onStatus = (s: MuseStatus) => {
      if (s.state === "error" && s.message) {
        setMessage(s.message);
        return;
      }
      // Clear when Muse recovers or is stopped intentionally.
      if (s.state === "streaming" || s.state === "stopped" || s.state === "starting") {
        setMessage(null);
        setDismissedKey(null);
      }
    };
    void window.museic.getMuseStatus().then(onStatus);
    return window.museic.onMuseStatus(onStatus);
  }, []);

  if (!message || dismissedKey === message) return null;

  return (
    <div className="corner-toast" role="alert">
      <p className="corner-toast-msg">{message}</p>
      <button
        type="button"
        className="corner-toast-x"
        aria-label="Dismiss"
        onClick={() => setDismissedKey(message)}
      >
        ×
      </button>
    </div>
  );
}
