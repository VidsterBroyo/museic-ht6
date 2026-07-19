export interface RawSensorData {
  hr_bpm: number | null;
  hrv_rmssd: number | null;
  stress_index: number | null;
  expression: string | null;
  expression_confidence: number | null;
  alpha_beta_ratio: number | null;
}

export interface SensorReading {
  raw: RawSensorData;
  movement_intensity: number | null;
  simulated: boolean;
}

export interface Session {
  accessToken: string;
  user: { sub: string; name?: string; email?: string; picture?: string } | null;
}

/** A Presage capture-quality hint (e.g. "No face found."). code 0 means OK. */
export interface ValidationStatus {
  code: number;
  hint: string;
}

export type MuseStatus =
  | { state: "stopped" }
  | { state: "starting" }
  | { state: "connecting" }
  | {
      state: "streaming";
      simulated?: boolean;
      preview?: boolean;
      lastRatio?: number | null;
      bands?: Record<string, number> | null;
      movement?: number | null;
      asymmetry?: number | null;
      frontalTheta?: number | null;
      posted?: number;
    }
  | { state: "error"; message: string };

export interface Song {
  song_id: string;
  title: string;
  artist: string;
  duration_s: number;
  tempo_bpm: number | null;
  key: string | null;
  llm_tags: { instruments?: string[]; vocal_character?: string; mood?: string[] } | null;
  spotify_uri: string | null;
  sections: { start_s: number; end_s: number; label: string }[];
  album_art_b64: string | null;
  album_art_mime?: string | null;
  likes?: number;
}

export interface GraphPoint {
  t: number;
  arousal: number | null;
  valence: number | null;
  quadrant: string | null;
  muse: number | null;
  energy: number | null;
  brightness: number | null;
  onset_density: number | null;
}

export interface SongGraphResponse {
  song: {
    song_id: string;
    title: string;
    artist: string;
    duration_s: number;
    tempo_bpm: number | null;
    key: string | null;
    sections: { start_s: number; end_s: number; label: string }[];
  };
  points: GraphPoint[];
}

export interface Profile {
  user_id: string;
  taste_vector: Record<string, number> | null;
  top_tags: Record<string, number>;
  quadrant_counts: Record<string, number>;
  mean_arousal: number | null;
  mean_valence: number | null;
  n_moments: number;
  arousal_peaks: {
    song_id: string;
    title: string | null;
    artist: string | null;
    album_art_b64?: string | null;
    album_art_mime?: string | null;
    t: number;
    section: string | null;
    arousal: number;
    valence: number;
    quadrant: string;
  }[];
  narrative: string | null;
  insights: Insights | null;
}

export interface SonicSignature {
  sweet_spot_bpm: number;
  tempo_low: number;
  tempo_high: number;
  minor_pct: number | null;
  major_pct: number | null;
  dominant_mode: "minor" | "major" | null;
  top_key: string | null;
  n_songs: number;
}

export interface TopSong {
  song_id: string;
  title: string | null;
  artist: string | null;
  enjoyment: number;
  seconds: number;
  peak_arousal: number;
}

export interface CrowdStats {
  n_listeners: number;
  energy_pct?: number | null;
  positivity_pct?: number | null;
  tempo_pct?: number | null;
}

export interface Insights {
  sonic_signature: SonicSignature | null;
  top_songs: TopSong[];
  crowd: CrowdStats | null;
}

export interface Recommendation {
  song_id: string;
  title: string;
  artist: string;
  score: number;
  similarity_score?: number;
  ml_score?: number | null;
  spotify_uri: string | null;
}

export interface ComparePoint {
  t: number;
  arousal_a: number;
  arousal_b: number;
  valence_a: number | null;
  valence_b: number | null;
}

export interface CompareResponse {
  compatibility: number | null;
  shared_songs: {
    song_id: string;
    title: string | null;
    artist: string | null;
    score: number | null;
    points: ComparePoint[];
  }[];
  reason?: string;
}

declare global {
  interface Window {
    museic: {
      login: () => Promise<void>;
      connectSpotify: () => Promise<void>;
      logout: () => Promise<void>;
      getSession: () => Promise<Session | null>;
      onAuthChanged: (cb: () => void) => () => void;
      onSpotifyConnected: (cb: () => void) => () => void;
      startCapture: (opts?: { simulate?: boolean }) => Promise<{ mode: "presage" | "simulated" }>;
      stopCapture: () => Promise<void>;
      onSensorReading: (cb: (reading: SensorReading) => void) => () => void;
      onValidation: (cb: (status: ValidationStatus) => void) => () => void;
      setNowPlaying: (songId: string | null) => Promise<void>;
      startMuse: (opts?: { address?: string; simulate?: boolean }) => Promise<MuseStatus>;
      stopMuse: () => Promise<void>;
      getMuseStatus: () => Promise<MuseStatus>;
      onMuseStatus: (cb: (status: MuseStatus) => void) => () => void;
      getConfig: () => Promise<{ backendUrl: string }>;
    };
  }
}
