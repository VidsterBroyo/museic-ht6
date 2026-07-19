/**
 * Injects a <style> tag with the CSS for the application redesign.
 * This is a workaround because the project's main CSS file was not provided.
 */
export function StyleInjector() {
  return (
    <style>
      {`
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

:root {
  --bg-main: #DCFFFD;
  --bg-card: #ffffff;
  --text-main: #24401f;
  --text-muted: rgba(36, 64, 31, 0.82);
  --accent-pink: #52FFEE;
  --accent-cyan: #52FFEE;
  --accent-yellow: #8a6d13;
  --accent-purple: #4FB477;
  --success-green: #4FB477;
  --border-color: rgba(63, 102, 52, 0.42);
  --font-sans: "Zalando Sans", "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
}

body {
  background-color: var(--bg-main);
  color: var(--text-main);
  font-family: var(--font-sans);
}

body,
button,
input,
textarea,
select,
code,
pre,
blockquote,
svg text,
.recharts-wrapper,
.recharts-wrapper * {
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
  color: var(--text-main);
  background-color: rgba(82, 255, 238, 0.18);
}

button.primary {
  background-color: var(--accent-pink);
  border-color: var(--accent-pink);
  color: var(--text-main);
  box-shadow: none;
}

button.primary:hover {
  background-color: #36ead7;
  border-color: #36ead7;
  color: var(--text-main);
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
  background-color: rgba(79, 180, 119, 0.22);
  color: var(--text-main);
  border: 1px solid rgba(63, 102, 52, 0.42);
}

.tag.neg {
  background-color: rgba(163, 66, 79, 0.1);
  color: #a3424f;
  border: 1px solid rgba(163, 66, 79, 0.35);
}

.banner.warn {
  background-color: #fff6d8;
  color: var(--accent-yellow);
  border-color: rgba(138, 109, 19, 0.35);
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
  background: rgba(63,102,52,0.86);
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
  position: relative; /* For the disc hole */
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
  width: 240px;
  height: 240px;
  flex-shrink: 0; /* Prevent oval distortion */
  background: var(--border-color);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  overflow: hidden;
  box-shadow: 0 10px 30px rgba(63, 102, 52, 0.16);
}
.song-album-art::after {
  content: '';
  position: absolute;
  width: 25px;
  height: 25px;
  background: var(--bg-main);
  border-radius: 50%;
  border: 2px solid var(--border-color);
  box-shadow: inset 0 0 5px rgba(0,0,0,0.5);
  /* The parent is a flex container with align/justify center, so this is already centered */
  z-index: 1; /* Ensure it's on top of the image */
}
.song-album-art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
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
  color: var(--text-main);
  border: none;
  box-shadow: 0 8px 22px rgba(63, 102, 52, 0.14);
}
.song-card.playing .play-button {
  background-color: var(--success-green);
  box-shadow: 0 8px 22px rgba(63, 102, 52, 0.14);
}
.song-card.active .song-album-art {
  animation: spin 12s linear infinite;
  animation-play-state: paused;
}
.song-card.active.is-playing .song-album-art {
  animation-play-state: running;
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
  background: linear-gradient(90deg, var(--success-green), var(--accent-pink));
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
  text-shadow: none;
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
  background: rgba(255, 255, 255, 0.7);
  border: 1px solid var(--border-color);
  border-radius: 999px;
  padding: 8px 16px;
  font-weight: 500;
  box-shadow: 0 4px 20px rgba(63, 102, 52, 0.1);
  transition: all 0.3s ease;
}
.muse-pill .muse-toggle:hover {
  border-color: var(--accent-cyan);
  color: var(--accent-cyan);
}
.muse-pill.muse-streaming .muse-toggle {
  border-color: var(--success-green);
  color: var(--text-main);
  box-shadow: 0 4px 20px rgba(63, 102, 52, 0.12);
}
.muse-pill .muse-state {
  color: var(--text-muted);
}
      `}
    </style>
  );
}
