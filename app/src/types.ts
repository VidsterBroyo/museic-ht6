export interface SensorReading {
  raw: {
    hr_bpm: number | null;
    hrv_rmssd: number | null;
    stress_index: number | null;
    expression: string | null;
    expression_confidence: number | null;
    alpha_beta_ratio: null;
  };
  movement_intensity: number | null;
  simulated: boolean;
}

export interface Session {
  accessToken: string;
  user: { sub: string; name?: string; email?: string } | null;
}

export interface Song {
  song_id: string;
  title: string;
  artist: string;
  duration_s: number;
  tempo_bpm: number | null;
  key: string | null;
  llm_tags: { instruments?: string[]; vocal_character?: string; mood?: string[] } | null;
  spotify_uri: string | null;
}

export interface GraphPoint {
  t: number;
  arousal: number | null;
  valence: number | null;
  quadrant: string | null;
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
  n_moments: number;
  arousal_peaks: {
    song_id: string;
    title: string | null;
    artist: string | null;
    t: number;
    section: string | null;
    arousal: number;
    valence: number;
    quadrant: string;
  }[];
  narrative: string | null;
}

export interface Recommendation {
  song_id: string;
  title: string;
  artist: string;
  score: number;
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
      logout: () => Promise<void>;
      getSession: () => Promise<Session | null>;
      onAuthChanged: (cb: () => void) => () => void;
      startCapture: () => Promise<{ mode: "presage" | "simulated" }>;
      stopCapture: () => Promise<void>;
      onSensorReading: (cb: (reading: SensorReading) => void) => () => void;
      setNowPlaying: (songId: string | null) => Promise<void>;
      getConfig: () => Promise<{ backendUrl: string }>;
    };
  }
}
