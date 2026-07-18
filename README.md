# Museic

Scroll a feed of songs, capture biometric reactions (camera via Presage SmartSpectra + optional
Muse 2 EEG), derive per-second arousal/valence, build a music enjoyment profile, get
recommendations, and export a playlist to Spotify. See `museic-rfc.md` for the full design.

## Quick start

Read `SETUP.md` first — it lists every credential you need to create (MongoDB, Auth0, Backboard,
Gemini, Presage) and every placeholder in the code that needs your input. The steps below are the
condensed command sequence once your credentials are ready.

### 1. Configure
make sure u have a .env file with required stuffs

### 2. Install dependencies

```bash
python -m venv .venv
.\.venv\Scripts\Activate.ps1  # for macOS: source .venv/bin/activate
pip install -r backend/requirements.txt -r scripts/requirements.txt -r muse_service/requirements.txt

cd app && npm install && cd ..
```

### 3. Seed the song library

Point `AUDIO_DIR` in `.env` at a folder of local tracks (`Artist - Title.mp3` naming for
automatic metadata), then run the offline extraction pass once:

```bash
# venv active
python scripts/extract_features.py --audio-dir library
```

This computes per-second `librosa` feature curves for every track and writes them to the
`songs` collection. If `GEMINI_API_KEY` isn't set it skips the instrument/mood tagging pass and
seeds numeric features only — recommendations still work, just without genre/mood tags.

### 4. Start the backend

```bash
# venv active, from the repo root
uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

### 5. Start the Electron app

```bash
cd app
npm run dev
```

Log in (system browser opens → `museic://` bounces back into the app), then scroll and react.
Presage/Muse hardware is optional — without it, the app runs on a clearly-labelled simulated
sensor feed so the rest of the pipeline stays testable end-to-end.

See `SETUP.md` (c) for the Muse companion service and packaged-build steps.

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