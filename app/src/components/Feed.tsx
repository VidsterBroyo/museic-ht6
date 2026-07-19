import { useCallback, useEffect, useRef, useState } from "react";
import { api, audioUrl } from "../api";
import { annotatePoint } from "./signals";
import type { GraphPoint, SensorReading, Song, SongGraphResponse } from "../types";
import { StyleInjector } from "./StyleInjector";
import SongGraph from "./SongGraph";

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
  const [current, setCurrent] = useState<string | null>(null);
  const [captureMode, setCaptureMode] = useState<"presage" | "simulated" | null>(null);
  const [lastReading, setLastReading] = useState<SensorReading | null>(null);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [graphData, setGraphData] = useState<SongGraphResponse | null>(null);
  const [likedSongs, setLikedSongs] = useState<Set<string>>(new Set());

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const bufferRef = useRef<BufferedReading[]>([]);
  const currentRef = useRef<string | null>(null);
  const lastReadingRef = useRef<SensorReading | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    api<Song[]>("/songs").then((s) => {
      setSongs(s);
    }).catch((e) => setError(String(e)));
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
      setLastReading(reading);

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

  // Cleanup on unmount: flush + stop capture + clear now-playing beacon.
  useEffect(() => {
    return () => {
      void flush(currentRef.current);
      void window.museic.stopCapture();
      void window.museic.setNowPlaying(null);
    };
  }, [flush]);

  const currentSong = songs?.[currentSongIndex];

  // Load graph data for the visible song.
  useEffect(() => {
    if (!currentSong || graphData?.song.song_id === currentSong.song_id) return;

    setGraphData({ song: graphSong(currentSong), points: [] }); // Show empty graph immediately.
    api<SongGraphResponse>(`/song-graph/${userId}/${currentSong.song_id}`)
      .then((data) => setGraphData(data))
      .catch(() => console.log(`No prior graph data for ${currentSong.song_id}`));

  }, [currentSong, userId, graphData]);

  const stopCurrent = useCallback(async () => {
    await flush(currentRef.current);
    currentRef.current = null;
    setCurrent(null);
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

  const shuffle = useCallback(() => {
    if (!songs) return;
    void stopCurrent();
    const shuffled = [...songs].sort(() => Math.random() - 0.5);
    setSongs(shuffled);
    setCurrentSongIndex(0);
  }, [songs, stopCurrent]);

  const like = useCallback(async () => {
    if (!currentSong || likedSongs.has(currentSong.song_id)) return;
    try {
      const { likes } = await api<{ likes: number }>(`/songs/${currentSong.song_id}/like`, { method: "POST" });
      setLikedSongs((prev) => new Set(prev).add(currentSong.song_id));
      setSongs((prevSongs) =>
        prevSongs?.map((s) => (s.song_id === currentSong.song_id ? { ...s, likes } : s)) ?? null
      );
    } catch (e) {
      console.error("Failed to like song", e);
    }
  }, [currentSong, likedSongs]);

  if (error) return <div className="pad error">{error}</div>;
  if (!songs || !currentSong) return <div className="pad muted">loading songs…</div>;
  if (songs.length === 0 || !currentSong)
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
      {lastReading && current && (
        <div className="live-hud">
          ● live&nbsp; hr {lastReading.raw.hr_bpm ?? "–"} bpm · {lastReading.raw.expression ?? "–"}{" "}
          ({((lastReading.raw.expression_confidence ?? 0) * 100).toFixed(0)}%) · movement{" "}
          {((lastReading.movement_intensity ?? 0) * 100).toFixed(0)}%
        </div>
      )}
      <div className={`song-view ${current === currentSong.song_id ? "active" : ""} ${current === currentSong.song_id && isAudioPlaying ? "is-playing" : ""}`}>
        <div className="song-album-art">
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
            <span className="like-count">♥ {currentSong.likes ?? 0}</span>
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
          <button onClick={shuffle} title="Shuffle playlist">🔀 Shuffle</button>
          <button onClick={() => navigate("prev")} disabled={currentSongIndex === 0}>⏮ Prev</button>
          <button className="play-button" onClick={() => void play()}>
            {current === currentSong.song_id && isAudioPlaying ? "❚❚" : "▶"}
          </button>
          <button onClick={() => navigate("next")} disabled={currentSongIndex === songs.length - 1}>Next ⏭</button>
          <button onClick={like} disabled={likedSongs.has(currentSong.song_id)} title="Like song">👍 Like</button>
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
