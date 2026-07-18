# Museic

Scroll a feed of songs, capture biometric reactions (camera via Presage SmartSpectra + optional
Muse 2 EEG), derive per-second arousal/valence, build a music enjoyment profile, get
recommendations, and export a playlist to Spotify. See `museic-rfc.md` for the full design.

## Repo layout

- `app/` — Electron desktop app (React + Vite + TypeScript). Feed UI, Presage SDK capture,
  Auth0 native login (system browser + PKCE + `museic://callback`), per-song graph view,
  two-person compare view.
- `backend/` — FastAPI backend. Auth0 JWT validation (`sub` claim = `user_id`), MongoDB
  (`songs`, `reactions` time-series, `profiles`), arousal/valence derivation, recommendations,
  Spotify playlist export via Auth0 Token Vault, Gemini narrative via Backboard.io.
- `scripts/` — Offline extraction pipeline: `extract_features.py` runs librosa per-second
  feature curves + a Gemini tagging pass per track and seeds the `songs` collection.
- `muse_service/` — Standalone muselsl companion service: Muse 2 over BLE → rolling
  alpha/beta band power (`scipy.signal.welch`) → posts into `reactions` with `source: "muse"`.
  Optional at runtime; the app works with Presage alone.

## Quick start

Read `SETUP.md` — it lists every credential you need to create, every placeholder in the code
that needs your input, and the exact commands to run on Windows and macOS.

Copy `.env.example` to `.env` and fill it in before running anything.
