/**
 * Injects a <style> tag with the CSS for the application redesign.
 * This is a workaround because the project's main CSS file was not provided.
 */
export function StyleInjector() {
  return (
    <style>
      {`
:root {
  --bg-main: #0d0d1a;
  --bg-card: #1a1a2e;
  --text-main: #e0e0ff;
  --text-muted: #8080a0;
  --accent-pink: #ff00a0;
  --accent-cyan: #00f5d4;
  --accent-yellow: #ffee00;
  --accent-purple: #a100ff;
  --border-color: #2a2a35;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
}

body {
  background-color: var(--bg-main);
  color: var(--text-main);
  font-family: var(--font-sans);
}

.pad {
  background-color: var(--bg-main);
}

h2, h3 {
  color: var(--text-main);
  font-weight: 600;
}

.muted {
  color: var(--text-muted);
}

button {
  background-color: var(--bg-card);
  color: var(--text-main);
  border: 1px solid var(--border-color);
  padding: 8px 16px;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
  font-weight: 500;
}

button:hover {
  border-color: var(--accent-cyan);
  color: var(--accent-cyan);
}

button.primary {
  background-color: var(--accent-pink);
  border-color: var(--accent-pink);
  color: #fff;
  box-shadow: 0 0 15px -5px var(--accent-pink);
}

button.primary:hover {
  background-color: #ff33b8;
  border-color: #ff33b8;
  color: #fff;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

input[type="text"] {
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  color: var(--text-main);
  padding: 8px 12px;
  border-radius: 8px;
}

.tag {
  background-color: rgba(0, 245, 212, 0.1);
  color: var(--accent-cyan);
  border: 1px solid rgba(0, 245, 212, 0.2);
}

.tag.neg {
  background-color: rgba(255, 0, 160, 0.1);
  color: var(--accent-pink);
  border: 1px solid rgba(255, 0, 160, 0.2);
}

.banner.warn {
  background-color: #332800;
  color: var(--accent-yellow);
  border-color: var(--accent-yellow);
}

/* Feed.tsx */
.feed-wrap {
  position: relative;
}
.feed {
  height: 100vh;
  overflow-y: scroll;
  scroll-snap-type: y mandatory;
  scroll-behavior: smooth;
}
.live-hud {
  position: fixed;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0,0,0,0.5);
  backdrop-filter: blur(5px);
  padding: 6px 12px;
  border-radius: 20px;
  color: var(--accent-cyan);
  font-size: 0.8rem;
  z-index: 10;
  border: 1px solid var(--border-color);
}
.song-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 24px;
  height: 100vh;
  scroll-snap-align: start;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
}
.song-card .song-meta {
  text-align: center;
}
.song-card .song-actions {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.song-album-art {
  width: 140px;
  height: 140px;
  background: var(--border-color);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
}
.song-card .song-title {
  font-size: 1.8rem;
  margin-bottom: 4px;
}
.song-card .song-artist {
  font-size: 1.1rem;
  color: var(--text-muted);
  margin-bottom: 16px;
}
.song-card .play-button {
  width: 60px;
  height: 60px;
  border-radius: 50%;
  font-size: 24px;
  background-color: var(--accent-pink);
  color: white;
  border: none;
  box-shadow: 0 0 20px -5px var(--accent-pink);
}
.song-card.playing .play-button {
  background-color: var(--accent-cyan);
  box-shadow: 0 0 20px -5px var(--accent-cyan);
}

/* ProfileView.tsx */
.narrative {
  background: var(--bg-card);
  border-left: 3px solid var(--accent-purple);
  padding: 16px;
  border-radius: 8px;
  font-style: italic;
  color: var(--text-muted);
}
.quadrants {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.quadrant {
  background: var(--bg-card);
  padding: 16px;
  border-radius: 8px;
  border: 1px solid var(--border-color);
}
.quadrant .bar {
  background-color: var(--border-color);
}
.quadrant .fill {
  background: linear-gradient(90deg, var(--accent-purple), var(--accent-pink));
}
.peaks li {
  background: var(--bg-card);
  padding: 12px;
  border-radius: 8px;
  margin-bottom: 8px;
  border: 1px solid var(--border-color);
}

/* CompareView.tsx */
.compat-score {
  text-align: center;
  margin: 32px 0;
}
.compat-score .big-number {
  font-size: 5rem;
  font-weight: 700;
  color: var(--accent-cyan);
  text-shadow: 0 0 25px var(--accent-cyan);
}
.chart-box {
  background: var(--bg-card);
  padding: 16px;
  border-radius: 12px;
  margin-bottom: 16px;
  border: 1px solid var(--border-color);
  width: 90%;
  max-width: 1000px;
}

/* MuseControl.tsx */
.muse-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.9rem;
}
.muse-pill .muse-toggle {
  background: rgba(26, 26, 46, 0.7);
  border: 1px solid var(--border-color);
  border-radius: 999px;
  padding: 8px 16px;
  font-weight: 500;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  transition: all 0.3s ease;
}
.muse-pill .muse-toggle:hover {
  border-color: var(--accent-cyan);
  color: var(--accent-cyan);
}
.muse-pill.muse-streaming .muse-toggle {
  border-color: var(--accent-cyan);
  color: var(--accent-cyan);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3), 0 0 15px -2px var(--accent-cyan);
}
.muse-pill .muse-state {
  color: var(--text-muted);
}
      `}
    </style>
  );
}