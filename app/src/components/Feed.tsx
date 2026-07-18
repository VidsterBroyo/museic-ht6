import { useCallback, useEffect, useRef, useState } from "react";
import { api, audioUrl } from "../api";
import type { SensorReading, Song, ValidationStatus } from "../types";

/** Human-readable fallback when the Presage SDK gives a code but no hint text. */
function describeValidation(code: number): string {
  switch (code) {
    case 1:
      return "No face detected — center your face in the camera.";
    case 7:
      return "Move back a little so your upper chest is in view.";
    default:
      return "Adjusting camera signal…";
  }
}

/** Human-readable message for an <audio> element MediaError. */
function describeMediaError(err: MediaError | null): string {
  switch (err?.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return "playback aborted";
    case MediaError.MEDIA_ERR_NETWORK:
      return "network error while loading audio";
    case MediaError.MEDIA_ERR_DECODE:
      return "audio could not be decoded (corrupt or unsupported encoding)";
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "audio format not supported by the player";
    default:
      return `unknown audio error${err?.message ? `: ${err.message}` : ""}`;
  }
}

/**
 * TikTok-style vertical scroll feed (RFC §1/§2).
 *
 * Client-side logic is deliberately DUMB: while a song plays, each 1 Hz sensor
 * reading from the Presage adapter is tagged with the current song second and
 * buffered; buffers are POSTed to /reactions/batch. No arousal/valence math
 * happens here -- that's backend-only (§5).
 */

interface BufferedReading {
  t: number;
  raw: SensorReading["raw"];
  movement_intensity: number | null;
}

const FLUSH_EVERY_MS = 10_000;

export default function Feed({ onOpenGraph }: { onOpenGraph: (songId: string) => void }) {
  const [songs, setSongs] = useState<Song[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [captureMode, setCaptureMode] = useState<"presage" | "simulated" | null>(null);
  const [lastReading, setLastReading] = useState<SensorReading | null>(null);
  const [captureNote, setCaptureNote] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const bufferRef = useRef<BufferedReading[]>([]);
  const currentRef = useRef<string | null>(null);
  const reactedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    api<Song[]>("/songs")
      .then(setSongs)
      .catch((e) => setError(String(e)));
  }, []);

  const flush = useCallback(async (songId: string | null) => {
    const readings = bufferRef.current;
    bufferRef.current = [];
    if (!songId || readings.length === 0) return;
    try {
      await api("/reactions/batch", {
        method: "POST",
        body: { song_id: songId, source: "presage", readings },
      });
      reactedRef.current.add(songId);
    } catch (e) {
      console.error("batch post failed", e);
    }
  }, []);

  // Presage capture-quality hints -> a subtle, self-clearing note.
  useEffect(() => {
    return window.museic.onValidation((status: ValidationStatus) => {
      setCaptureNote(
        status.code === 0 ? null : status.hint || describeValidation(status.code),
      );
    });
  }, []);

  // Sensor readings -> tag with song second -> buffer.
  useEffect(() => {
    return window.museic.onSensorReading((reading) => {
      setLastReading(reading);
      const audio = audioRef.current;
      const songId = currentRef.current;
      if (!audio || !songId || audio.paused) return;
      const t = Math.floor(audio.currentTime);
      if (t < 0) return;
      bufferRef.current.push({
        t,
        raw: reading.raw,
        movement_intensity: reading.movement_intensity,
      });
    });
  }, []);

  // Periodic flush while playing.
  useEffect(() => {
    const id = setInterval(() => void flush(currentRef.current), FLUSH_EVERY_MS);
    return () => clearInterval(id);
  }, [flush]);

  // Cleanup on unmount: flush + stop capture + clear now-playing beacon.
  useEffect(() => {
    return () => {
      void flush(currentRef.current);
      void window.museic.stopCapture();
      void window.museic.setNowPlaying(null);
    };
  }, [flush]);

  const stopCurrent = useCallback(async () => {
    const audio = audioRef.current;
    if (audio) audio.pause();
    await flush(currentRef.current);
    currentRef.current = null;
    setCurrent(null);
    setCaptureNote(null);
    await window.museic.setNowPlaying(null);
  }, [flush]);

  const play = useCallback(
    async (song: Song) => {
      if (currentRef.current === song.song_id) {
        await stopCurrent();
        return;
      }
      await flush(currentRef.current);
      const audio = audioRef.current;
      if (!audio) return;
      setAudioError(null);
      try {
        audio.src = await audioUrl(song.song_id);
        audio.muted = false;
        audio.volume = 1;
        await audio.play();
      } catch (e) {
        setAudioError(`audio playback failed: ${String(e)}`);
        return;
      }
      currentRef.current = song.song_id;
      setCurrent(song.song_id);
      await window.museic.setNowPlaying(song.song_id); // Muse service beacon
      if (!captureMode) {
        const { mode } = await window.museic.startCapture();
        setCaptureMode(mode);
      }
    },
    [captureMode, flush, stopCurrent],
  );

  if (error) return <div className="pad error">{error}</div>;
  if (!songs) return <div className="pad muted">loading songs…</div>;
  if (songs.length === 0)
    return (
      <div className="pad">
        <h2>No songs yet</h2>
        <p className="muted">
          Seed the library first: <code>python scripts/extract_features.py --audio-dir …</code>
        </p>
      </div>
    );

  return (
    <div className="feed-wrap">
      <audio
        ref={audioRef}
        onEnded={() => void stopCurrent()}
        onError={() => setAudioError(describeMediaError(audioRef.current?.error ?? null))}
        onPlaying={() => setAudioError(null)}
      />
      {audioError && (
        <div className="banner error">
          Audio: {audioError}
          <button className="banner-dismiss" onClick={() => setAudioError(null)}>
            ✕
          </button>
        </div>
      )}
      {captureMode === "simulated" && (
        <div className="banner warn">
          Sensor data is SIMULATED — wire the Presage SDK to capture real reactions (SETUP.md).
        </div>
      )}
      {captureNote && current && captureMode === "presage" && (
        <div className="banner note">📷 {captureNote}</div>
      )}
      {lastReading && current && (
        <div className="banner live">
          ● live&nbsp; hr {lastReading.raw.hr_bpm ?? "–"} bpm · {lastReading.raw.expression ?? "–"}{" "}
          ({((lastReading.raw.expression_confidence ?? 0) * 100).toFixed(0)}%) · movement{" "}
          {((lastReading.movement_intensity ?? 0) * 100).toFixed(0)}%
        </div>
      )}
      <div className="feed">
        {songs.map((song) => {
          const isPlaying = current === song.song_id;
          const reacted = reactedRef.current.has(song.song_id);
          return (
            <section key={song.song_id} className={`song-card ${isPlaying ? "playing" : ""}`}>
              <div className="song-meta">
                <h2>{song.title}</h2>
                <p className="muted">{song.artist || "unknown artist"}</p>
                <p className="muted small">
                  {song.tempo_bpm ? `${song.tempo_bpm} bpm` : ""} {song.key ? `· ${song.key}` : ""}{" "}
                  {song.duration_s ? `· ${Math.floor(song.duration_s / 60)}:${String(song.duration_s % 60).padStart(2, "0")}` : ""}
                </p>
                {song.llm_tags?.mood && (
                  <div className="tags">
                    {song.llm_tags.mood.map((m) => (
                      <span key={m} className="tag">
                        {m}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="song-actions">
                <button className="primary big" onClick={() => void play(song)}>
                  {isPlaying ? "■ Stop" : "▶ Play & react"}
                </button>
                {(reacted || !isPlaying) && (
                  <button onClick={() => onOpenGraph(song.song_id)}>View my graph</button>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
