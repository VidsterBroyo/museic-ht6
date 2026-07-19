import { useCallback, useEffect, useRef, useState } from "react";
import { api, audioUrl } from "../api";
import { setEnjoymentMood } from "../enjoyment";
import { annotatePoint } from "./signals";
import type { SensorReading, Song, SongGraphPoint, SongGraphResponse } from "../types";
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

export default function Feed({ userId }: { userId: string }) {
  const [songs, setSongs] = useState<Song[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [captureMode, setCaptureMode] = useState<"presage" | "simulated" | null>(null);
  const [lastReading, setLastReading] = useState<SensorReading | null>(null);
  const [graphData, setGraphData] = useState<SongGraphResponse | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const bufferRef = useRef<BufferedReading[]>([]);
  const currentRef = useRef<string | null>(null);
  const lastReadingRef = useRef<SensorReading | null>(null);

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
    } catch (e) {
      console.error("batch post failed", e);
    }
  }, []);

  // Sensor readings -> tag with song second -> buffer.
  useEffect(() => {
    return window.museic.onSensorReading((reading) => {
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
        const fullPoint: SongGraphPoint = {
          t,
          ...newAnnotation,
          energy: prevData.song.features?.energy_curve?.[t] ?? null,
          brightness: prevData.song.features?.spectral_brightness_curve?.[t] ?? null,
          onset_density: prevData.song.features?.onset_density_curve?.[t] ?? null,
        };

        return { ...prevData, points: [...prevData.points, fullPoint] };
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
  }, [graphData]);

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
      setEnjoymentMood(null);
    };
  }, [flush]);

  const stopCurrent = useCallback(async () => {
    const audio = audioRef.current;
    if (audio) audio.pause();
    await flush(currentRef.current);
    currentRef.current = null;
    setCurrent(null);
    await window.museic.setNowPlaying(null);
    setEnjoymentMood(null);
  }, [flush]);

  const play = useCallback(
    async (song: Song) => {
      if (currentRef.current === song.song_id) {
        await stopCurrent();
        return;
      }
      await flush(currentRef.current);
      setGraphData({ song, points: [] }); // Show graph box immediately

      const audio = audioRef.current;
      if (!audio) return;
      try {
        audio.src = await audioUrl(song.song_id);
        // Pre-fetch existing graph data to append to.
        try {
          const initialGraphData = await api<SongGraphResponse>(`/song-graph/${userId}/${song.song_id}`);
          setGraphData(initialGraphData);
        } catch (e) {
          // 404 is fine, means no data yet.
          console.log(`No prior graph data for ${song.song_id}`);
        }
        await audio.play();
      } catch (e) {
        setError(`audio playback failed: ${String(e)}`);
        return;
      }
      currentRef.current = song.song_id;
      setCurrent(song.song_id);
      await window.museic.setNowPlaying(song.song_id); // Muse service beacon
      setEnjoymentMood(song.llm_tags?.mood ?? null);   // adapt enjoyment to genre/mood
      if (!captureMode) {
        const { mode } = await window.museic.startCapture();
        setCaptureMode(mode);
      }
    },
    [captureMode, flush, stopCurrent, userId],
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
      <StyleInjector />
      <audio ref={audioRef} onEnded={() => void stopCurrent()} />
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
      <div className="feed">
        {songs.map((song) => {
          const isPlaying = current === song.song_id;
          return (
            <section key={song.song_id} className={`song-card ${isPlaying ? "playing" : ""}`}>
              <div className="song-meta">
                <h2 className="song-title">{song.title}</h2>
                <p className="song-artist">{song.artist || "unknown artist"}</p>
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
              <div className="song-album-art">
                <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
                </svg>
              </div>
              <div className="song-actions">
                <button className="play-button" onClick={() => void play(song)}>
                  {isPlaying ? "■" : "▶"}
                </button>
              </div>
              <div className="chart-box">
                {graphData?.song.song_id === song.song_id && (
                  <SongGraph song={graphData.song} points={graphData.points} />
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
