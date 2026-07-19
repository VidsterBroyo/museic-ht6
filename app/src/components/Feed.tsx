import { useCallback, useEffect, useRef, useState, type MouseEvent, type MutableRefObject } from "react";
import { extractAlbumGlowColor } from "../albumGlow";
import { api, audioUrl } from "../api";
import { setEnjoymentMood, useEnjoyment } from "../enjoyment";
import { annotatePoint } from "./signals";
import type { GraphPoint, SensorReading, Song, SongGraphResponse } from "../types";
import { StyleInjector } from "./StyleInjector";
import SongGraph from "./SongGraph";

/** Stable wave-bar phase offsets (random-per-render was thrashing the GPU). */
const WAVE_DELAYS = Array.from({ length: 25 }, (_, i) => -((i * 0.037) % 0.5));

function bumpButton(el: HTMLButtonElement | null) {
  if (!el) return;
  el.classList.remove("bump");
  void el.offsetWidth; // restart CSS animation
  el.classList.add("bump");
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
const MAX_LIVE_POINTS = 300;

function graphSong(song: Song): SongGraphResponse["song"] {
  return {
    song_id: song.song_id,
    title: song.title,
    artist: song.artist,
    duration_s: song.duration_s,
    tempo_bpm: song.tempo_bpm,
    key: song.key,
    sections: [],
  };
}

export default function Feed({ userId, active = true }: { userId: string; active?: boolean }) {
  const [songs, setSongs] = useState<Song[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentSongIndex, setCurrentSongIndex] = useState(0);
  const [current, setCurrent] = useState<string | null>(null);
  const [captureMode, setCaptureMode] = useState<"presage" | "simulated" | null>(null);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [graphData, setGraphData] = useState<SongGraphResponse | null>(null);
  const [glowColor, setGlowColor] = useState("var(--accent)");

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const bufferRef = useRef<BufferedReading[]>([]);
  const currentRef = useRef<string | null>(null);
  const lastReadingRef = useRef<SensorReading | null>(null);
  const hudReadingRef = useRef<SensorReading | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    let cancelled = false;
    api<Song[]>("/songs")
      .then((s) => {
        if (!cancelled) setSongs(Array.isArray(s) ? s : []);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
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
    } catch (e) {
      console.error("batch post failed", e);
    }
  }, []);

  // Sensor readings -> tag with song second -> buffer.
  useEffect(() => {
    return window.museic.onSensorReading((reading) => {
      if (!activeRef.current) return;
      const prevReading = lastReadingRef.current;
      lastReadingRef.current = reading;
      hudReadingRef.current = reading; // Store latest reading without re-rendering

      const audio = audioRef.current;
      const songId = currentRef.current;
      if (!audio || !songId || audio.paused) return;

      // Real-time graph update.
      setGraphData((prevData) => {
        if (!prevData || prevData.song.song_id !== songId) return prevData;

        const t = Math.floor(audio.currentTime);
        if (t < 0 || (prevData.points.length > 0 && prevData.points[prevData.points.length - 1].t === t)) {
          return prevData; // Avoid duplicate points for the same second.
        }

        const newAnnotation = annotatePoint(reading, prevReading);
        // Feature curves aren't sent to the client, but the pre-fetched
        // /song-graph points already carry per-second energy/brightness/onset.
        const pointIndex = prevData.points.findIndex((p) => p.t === t);
        const existing = pointIndex >= 0 ? prevData.points[pointIndex] : undefined;
        const fullPoint: GraphPoint = {
          t,
          ...newAnnotation,
          muse: existing?.muse ?? null,
          energy: existing?.energy ?? null,
          brightness: existing?.brightness ?? null,
          onset_density: existing?.onset_density ?? null,
        };

        const nextPoints =
          pointIndex >= 0
            ? prevData.points.map((point) => (point.t === t ? fullPoint : point))
            : [...prevData.points, fullPoint];
        return { ...prevData, points: nextPoints.slice(-MAX_LIVE_POINTS) };
      });

      // Buffering for backend.
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

  // Cleanup on unmount. Camera stop is refcounted + debounced in Electron main
  // so StrictMode / tab switches don't SIGBUS the Presage SDK.
  useEffect(() => {
    return () => {
      void flush(currentRef.current);
      void window.museic.setNowPlaying(null);
      void window.museic.stopCapture();
    };
  }, [flush]);

  const currentSong = songs?.[currentSongIndex];

  // Load graph data for the visible song.
  useEffect(() => {
    if (!currentSong || !userId || graphData?.song.song_id === currentSong.song_id) return;

    setGraphData({ song: graphSong(currentSong), points: [] }); // Show empty graph immediately.
    api<SongGraphResponse>(`/song-graph/${encodeURIComponent(userId)}/${currentSong.song_id}`)
      .then((data) => {
        setGraphData(data);
      })
      .catch(() => {
        console.log(`No prior graph data for ${currentSong.song_id}`);
      });
  }, [currentSong, userId, graphData?.song.song_id]);

  const stopCurrent = useCallback(async () => {
    audioRef.current?.pause();
    await flush(currentRef.current);
    currentRef.current = null;
    setCurrent(null);
    setEnjoymentMood(null);
    await window.museic.setNowPlaying(null);
  }, [flush]);

  const play = useCallback(
    async () => {
      if (!currentSong) return;
      if (currentRef.current === currentSong.song_id) {
        // If it's the current song, toggle play/pause instead of stopping.
        if (audioRef.current?.paused) {
          await audioRef.current?.play();
        } else {
          audioRef.current?.pause();
        }
        return;
      }
      await flush(currentRef.current);
      setGraphData({ song: graphSong(currentSong), points: [] }); // Show graph box immediately

      const audio = audioRef.current;
      if (!audio) return;
      try {
        audio.src = await audioUrl(currentSong.song_id);
        await audio.play();
      } catch (e) {
        setError(`audio playback failed: ${String(e)}`);
        return;
      }
      currentRef.current = currentSong.song_id;
      setCurrent(currentSong.song_id);
      setEnjoymentMood(currentSong.llm_tags?.mood ?? null);
      await window.museic.setNowPlaying(currentSong.song_id); // Muse service beacon
      if (!captureMode) {
        const { mode } = await window.museic.startCapture();
        setCaptureMode(mode);
      }
    },
    [captureMode, flush, stopCurrent, currentSong],
  );

  const navigate = useCallback((direction: "next" | "prev") => {
    if (!songs) return;
    void stopCurrent();
    const nextIndex = direction === "next" ? currentSongIndex + 1 : currentSongIndex - 1;
    if (nextIndex >= 0 && nextIndex < songs.length) {
      setCurrentSongIndex(nextIndex);
    }
  }, [songs, currentSongIndex, stopCurrent]);

  const onNavClick = (
    e: MouseEvent<HTMLButtonElement>,
    action: () => void,
  ) => {
    bumpButton(e.currentTarget);
    action();
  };

  useEffect(() => {
    let cancelled = false;
    if (!currentSong?.album_art_b64) {
      setGlowColor("var(--accent)");
      return;
    }
    const src = `data:${currentSong.album_art_mime || "image/jpeg"};base64,${currentSong.album_art_b64}`;
    void extractAlbumGlowColor(src).then((color) => {
      if (!cancelled) setGlowColor(color ?? "var(--accent)");
    });
    return () => {
      cancelled = true;
    };
  }, [currentSong?.song_id, currentSong?.album_art_b64, currentSong?.album_art_mime]);

  const beatDuration = currentSong?.tempo_bpm
    ? `${(60 / currentSong.tempo_bpm).toFixed(2)}s`
    : "0.5s";
  const viewStyle = {
    "--glow-color": glowColor,
    "--beat-duration": beatDuration,
  } as React.CSSProperties;

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
  if (!currentSong) {
    return (
      <div className="pad muted">
        Couldn’t show song {currentSongIndex + 1} of {songs.length}.{" "}
        <button type="button" onClick={() => setCurrentSongIndex(0)}>Go to first</button>
      </div>
    );
  }

  return (
    <div className="feed-wrap">
      <StyleInjector />
      <audio
        ref={audioRef}
        onEnded={() => void stopCurrent()}
        onPlay={() => setIsAudioPlaying(true)}
        onPause={() => setIsAudioPlaying(false)}
      />
      {captureMode === "simulated" && (
        <div className="banner warn">
          Sensor data is SIMULATED — wire the Presage SDK to capture real reactions (SETUP.md).
        </div>
      )}
      {/* Own component so enjoyment ticks don't re-render the chart / album art. */}
      {current && <FeedLiveHud readingRef={hudReadingRef} />}
      <div
        key={currentSong.song_id}
        className={`song-view song-enter ${current === currentSong.song_id ? "active" : ""} ${
          current === currentSong.song_id && isAudioPlaying ? "is-playing" : ""
        }`}
        style={viewStyle}
      >
        <div className="song-album-art">
          <div className="sound-waves">
            {WAVE_DELAYS.map((delay, i) => (
              <div
                key={i}
                className="wave-bar"
                style={{
                  animationDuration: currentSong.tempo_bpm ? `${(60 / currentSong.tempo_bpm).toFixed(2)}s` : "0.5s",
                  animationDelay: `${delay}s`,
                }}
              />
            ))}
          </div>
          {currentSong.album_art_b64 ? (
            <img src={`data:${currentSong.album_art_mime || "image/jpeg"};base64,${currentSong.album_art_b64}`} alt={`Album art for ${currentSong.title}`} />
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
            </svg>
          )}
        </div>
        <div className="song-meta">
          <h2 className="meta-title">{currentSong.artist || "unknown artist"}</h2>
          <p className="meta-artist">{currentSong.title}</p>
          <p className="muted small">
            {currentSong.tempo_bpm ? `${currentSong.tempo_bpm} bpm` : ""} {currentSong.key ? `· ${currentSong.key}` : ""}{" "}
            {currentSong.duration_s ? `· ${Math.floor(currentSong.duration_s / 60)}:${String(currentSong.duration_s % 60).padStart(2, "0")}` : ""}
          </p>
          <div className="meta-feedback">
            {currentSong.llm_tags?.mood && (
              <div className="tags">
                {currentSong.llm_tags.mood.map((m) => (
                  <span key={m} className="tag">
                    {m}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="nav-panel">
          <button
            type="button"
            disabled={currentSongIndex === 0}
            onClick={(e) => onNavClick(e, () => navigate("prev"))}
          >
            ⏮
          </button>
          <button
            type="button"
            className="play-button"
            onClick={(e) => onNavClick(e, () => void play())}
          >
            {current === currentSong.song_id && isAudioPlaying ? "❚❚" : "▶"}
          </button>
          <button
            type="button"
            disabled={currentSongIndex === songs.length - 1}
            onClick={(e) => onNavClick(e, () => navigate("next"))}
          >
            ⏭
          </button>
        </div>

        <div className="chart-box">
          {graphData?.song.song_id === currentSong.song_id && (
            <SongGraph song={graphData.song} points={graphData.points} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Isolated HUD — keeps high-frequency sensor UI out of the Feed render tree. */
function FeedLiveHud({
  readingRef,
}: {
  readingRef: MutableRefObject<SensorReading | null>;
}) {
  const enjoyment = useEnjoyment();
  const [reading, setReading] = useState<SensorReading | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      if (readingRef.current) setReading(readingRef.current);
    }, 1000);
    return () => clearInterval(id);
  }, [readingRef]);

  if (enjoyment == null && !reading) return null;

  return (
    <div className="live-hud">
      {enjoyment != null ? (
        <span className="live-hud-enjoy">
          ● enjoy <b>{Math.round(enjoyment * 100)}</b>
        </span>
      ) : (
        <span>● live</span>
      )}
      {reading && (
        <span className="live-hud-rest">
          {" "}· hr {reading.raw.hr_bpm ?? "–"} · {reading.raw.expression ?? "–"}{" "}
          ({((reading.raw.expression_confidence ?? 0) * 100).toFixed(0)}%) · move{" "}
          {((reading.movement_intensity ?? 0) * 100).toFixed(0)}%
        </span>
      )}
    </div>
  );
}
