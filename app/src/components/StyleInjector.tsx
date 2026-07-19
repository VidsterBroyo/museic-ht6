/**
 * Injects a <style> tag with the CSS for the application redesign.
 * This is a workaround because the project's main CSS file was not provided.
 */
export function StyleInjector() {
  return (
    <style>
      {`
@keyframes pulse {
  0%, 100% { opacity: 0.3; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(1.05); }
}

@keyframes dance {
  0%, 100% { transform: scaleY(0.1); }
  50% { transform: scaleY(1.0); }
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes btn-bump {
  0% { transform: scale(1); }
  35% { transform: scale(0.86); }
  65% { transform: scale(1.08); }
  100% { transform: scale(1); }
}

@keyframes song-enter {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}

:root {
  --bg-main: #ffffff;
  --bg-card: #f4f4f6;
  --text-main: #121218;
  --text-muted: rgba(18, 18, 24, 0.7);
  --accent: #FF5D8F;
  --accent-hover: #e84d7f;
  --accent-pink: #FF5D8F;
  --accent-cyan: #FF5D8F;
  --accent-yellow: #8a6d13;
  --accent-purple: #7A9BB8;
  --success-green: #FF5D8F; /* alias kept for old rules; not green */
  --border-color: rgba(18, 18, 24, 0.18);
  --font-sans: "Zalando Sans", "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  --font-display: "Bebas Neue", "Zalando Sans", Impact, sans-serif;
  --radius: 10px;
  --radius-sm: 6px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg-main: #000000;
    --bg-card: #141418;
    --text-main: #ececf1;
    --text-muted: rgba(236, 236, 241, 0.7);
    --border-color: rgba(236, 236, 241, 0.18);
  }
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

h1, h2, h3,
.meta-title {
  font-family: var(--font-display);
  color: var(--text-main);
  font-weight: 400;
  letter-spacing: 0.04em;
}

.muted {
  color: var(--text-muted);
}

button {
  background-color: var(--bg-card);
  color: var(--text-main);
  border: 1px solid var(--border-color);
  padding: 8px 16px;
  border-radius: var(--radius);
  cursor: pointer;
  transition: all 0.2s ease;
  font-weight: 500;
}

button:hover {
  border-color: var(--accent);
  color: var(--text-main);
  background-color: rgba(255, 93, 143, 0.18);
}

button.primary {
  background-color: var(--accent);
  border-color: var(--accent);
  color: var(--text-main);
  box-shadow: none;
}

button.primary:hover {
  background-color: var(--accent-hover);
  border-color: var(--accent-hover);
  color: var(--text-main);
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

input:not([type="checkbox"]):not([type="radio"]),
input[type="text"] {
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  color: var(--text-main);
  padding: 8px 12px;
  border-radius: var(--radius);
}
input:not([type="checkbox"]):not([type="radio"])::placeholder {
  color: var(--text-muted);
}

.tag {
  background-color: rgba(255, 93, 143, 0.16);
  color: var(--text-main);
  border: 1px solid var(--border-color);
}

.tag.neg {
  background-color: rgba(163, 66, 79, 0.1);
  color: #a3424f;
  border: 1px solid rgba(163, 66, 79, 0.35);
}

.tags .tag {
  background: none;
  border: none;
  border-radius: 0;
  padding: 0;
  font-size: 0.85rem;
  font-style: italic;
  color: var(--text-muted);
  opacity: 0.85;
}
.tags .tag.neg {
  background: none;
  border: none;
  color: #a3424f;
  opacity: 0.75;
}
.tags {
  gap: 10px;
}

.banner.warn {
  background-color: var(--warn-bg, #fff6d8);
  color: var(--warn-text, var(--accent-yellow));
  border-color: rgba(138, 109, 19, 0.35);
}
.banner.err,
.banner.error {
  background-color: var(--err-bg, #ffe3e7);
  color: var(--err-text, var(--danger, #a3424f));
}

/* Feed.tsx */
.feed-wrap {
  position: relative;
  min-height: 100%;
}
.live-hud {
  position: fixed;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(20, 20, 24, 0.9);
  backdrop-filter: blur(5px);
  padding: 6px 14px;
  border-radius: var(--radius);
  color: var(--text-muted, var(--muted));
  font-size: 0.8rem;
  z-index: 10;
  border: 1px solid var(--border-color, var(--border));
  font-variant-numeric: tabular-nums;
}
.live-hud-enjoy {
  color: var(--accent);
  font-weight: 600;
}
.live-hud-enjoy b {
  font-weight: 800;
  font-size: 1.05em;
}
.live-hud-rest {
  color: var(--text-muted, var(--muted));
}
.song-view {
  /* min-height (not height) so tall content can grow and main can scroll */
  min-height: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 28px 16px 40px;
}
.song-view .song-meta {
  text-align: center;
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
  position: relative; /* for pseudo-elements */
  /* Soft ambient glow from album color (waveform uses --accent separately) */
  box-shadow: 0 0 55px 18px color-mix(in srgb, var(--glow-color, var(--accent)) 50%, transparent);
}
.song-album-art::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background: var(--glow-color, var(--accent));
  box-shadow: 0 0 60px 20px var(--glow-color, var(--accent));
  z-index: -1;
  opacity: 0;
  transition: opacity 0.5s ease-in-out, background 0.4s ease, box-shadow 0.4s ease;
  animation-name: pulse;
  animation-duration: var(--beat-duration, 0.5s);
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
  animation-play-state: paused;
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
.sound-waves {
  position: absolute;
  width: 100%;
  height: 100%;
  top: 0;
  left: 0;
  display: flex;
  justify-content: center;
  align-items: flex-end;
  gap: 6px;
  z-index: 0;
  opacity: 0.15;
  transform: scale(1.1);
}
.wave-bar {
  width: 8px;
  height: 90%;
  background: var(--accent);
  border-radius: var(--radius-sm);
  animation-name: dance;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
  animation-play-state: paused;
}
.song-album-art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
}
.song-view .meta-title {
  font-size: 1.8rem;
  margin-bottom: 4px;
}
.song-view .meta-artist {
  font-size: 1.1rem;
  color: var(--text-muted);
  margin-bottom: 16px;
}
.meta-feedback {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  margin-top: 8px;
}
.like-count {
  color: var(--text-muted);
  font-size: 0.9rem;
}

.nav-panel {
  display: flex;
  align-items: center;
  justify-content: space-around;
  width: 400px;
  max-width: 90%;
  background: var(--bg-main);
  padding: 12px 24px;
  border-radius: var(--radius);
  border: 1px solid color-mix(in srgb, var(--border-color) 85%, var(--text-muted));
  box-shadow: none;
  margin: 24px 0;
}
.nav-panel button {
  background: transparent;
  border: none;
  font-size: 1.75rem;
  line-height: 1;
  padding: 8px 16px;
  border-radius: var(--radius);
  color: var(--text-main);
  transition: background 0.15s ease, color 0.15s ease;
}
.nav-panel button:hover:not(:disabled) {
  background: rgba(255, 93, 143, 0.14);
  color: var(--accent);
}
.nav-panel button:disabled {
  opacity: 0.3;
}
.nav-panel button.bump {
  animation: btn-bump 0.38s cubic-bezier(0.34, 1.4, 0.64, 1);
}
.nav-panel .play-button {
  width: 60px;
  height: 60px;
  border-radius: 50%;
  font-size: 24px;
  background-color: var(--accent);
  color: var(--text-main);
  border: none;
  box-shadow: 0 8px 22px rgba(255, 93, 143, 0.28);
}
.nav-panel .play-button:hover:not(:disabled) {
  background-color: var(--accent-hover, #e84d7f);
  color: var(--text-main);
}
.nav-panel .play-button.bump {
  animation: btn-bump 0.4s cubic-bezier(0.34, 1.5, 0.64, 1);
}
.song-view.song-enter {
  animation: song-enter 0.35s ease-out;
}
.song-view.is-playing .play-button {
  background-color: var(--accent);
  box-shadow: 0 8px 22px rgba(255, 93, 143, 0.35);
}
.song-view.active .song-album-art {
  animation: spin 12s linear infinite;
  animation-play-state: paused;
}
.song-view.active.is-playing .song-album-art {
  animation-play-state: running;
}
.song-view.is-playing .wave-bar {
  animation-play-state: running;
}
.song-view.is-playing .song-album-art::before {
  animation-play-state: running;
  opacity: 0.15;
}

/* ProfileView.tsx */
.narrative {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  padding: 16px;
  border-radius: var(--radius);
  font-style: normal;
  color: var(--text-muted);
  line-height: 1.55;
}
.narrative strong {
  font-weight: 700;
  color: var(--text);
}
.profile-userid {
  margin-top: 32px;
  opacity: 0.7;
}
.copy-id-wrap { position: relative; display: inline-flex; vertical-align: middle; }
.copy-id-btn {
  margin-left: 6px; padding: 2px 8px; font-size: 0.75rem; line-height: 1.3;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--panel); color: var(--muted); cursor: pointer;
}
.copy-id-btn:hover { color: var(--text); border-color: var(--muted); }
.copy-id-tip {
  position: absolute; left: 50%; bottom: calc(100% + 6px); transform: translateX(-50%);
  padding: 3px 8px; font-size: 0.7rem; white-space: nowrap;
  color: var(--text); background: var(--panel); border: 1px solid var(--border);
  border-radius: var(--radius); pointer-events: none;
  animation: copy-tip-in 0.15s ease-out;
}
@keyframes copy-tip-in {
  from { opacity: 0; transform: translateX(-50%) translateY(4px); }
  to { opacity: 1; transform: translateX(-50%) translateY(0); }
}
.quadrants {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.quadrant {
  background: var(--bg-card);
  padding: 16px;
  border-radius: var(--radius);
  border: 1px solid var(--border-color);
}
.quadrant .bar {
  background-color: var(--border-color);
}
.quadrant .fill {
  background: linear-gradient(90deg, #7A9BB8, var(--accent));
}
.peaks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.peaks li {
  display: flex;
  align-items: center;
  gap: 12px;
  background: none;
  border: none;
  padding: 0;
  margin: 0;
}
.peak-art {
  width: 48px;
  height: 48px;
  border-radius: 6px;
  object-fit: cover;
  flex-shrink: 0;
}
.peak-art-fallback {
  display: block;
  background: var(--border-color);
}
.peak-body { min-width: 0; line-height: 1.35; }
.peak-title {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.peak-meta { margin-top: 2px; }

/* CompareView.tsx */
.compat-score {
  text-align: center;
  margin: 32px 0;
}
.compat-score .big-number {
  font-size: 5rem;
  font-weight: 700;
  color: var(--accent);
  text-shadow: none;
}
.song-graph-hint {
  display: flex; align-items: center; gap: 8px;
  margin: 4px 0 0; line-height: 1.3;
}
.song-graph-band-swatch {
  flex: 0 0 auto; width: 14px; height: 10px; border-radius: 2px;
  background: rgba(232, 168, 74, 0.35);
  border: 1px solid rgba(232, 168, 74, 0.7);
}
.chart-box {
  background: var(--bg-card);
  padding: 16px;
  border-radius: var(--radius);
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
  background: transparent;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  padding: 6px 14px;
  font-weight: 600;
  color: var(--accent);
  box-shadow: none;
  transition: background 0.15s ease, color 0.15s ease;
}
.muse-pill .muse-toggle:hover {
  background: rgba(255, 93, 143, 0.18);
  border-color: var(--accent);
  color: var(--text, #ececf1);
}
.muse-pill.muse-streaming .muse-toggle {
  background: rgba(255, 93, 143, 0.16);
  border-color: var(--accent);
  color: var(--accent);
  box-shadow: none;
}
.muse-pill .muse-state {
  color: var(--text-muted);
}
      `}
    </style>
  );
}
