<div align="center">
  <img src="" width="200" />
</div>

<h1 align = "center">
    Museic
</h1>

<div align = "center"> Your body already knows your favourite song, let it pick for you! </div>

<br>
<br>

Scroll a feed of songs, capture biometric reactions (camera via Presage SmartSpectra + optional
Muse 2 EEG), derive per-second arousal/valence, build a music enjoyment profile, get
recommendations, export a playlist to Spotify, and connect with other users with similar music preferences!
See `museic-rfc.md` for the full design.

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

## Architecture

Museic is built around an offline-prepared song library, a live biometric reaction loop, and
external services that only handle identity, narratives, and playlist export.

```text
                         ┌────────────────────────────┐
                         │            Auth0           │
                         │ identity + JWTs            │
                         │ Spotify Token Vault        │
                         └─────────────▲──────┬───────┘
                                       │      │ Spotify token at export
                         browser PKCE  │      ▼
┌────────────────────────────┐         │  ┌────────────────────────────┐
│        Electron app        │─────────┘  │        Spotify API         │
│ React feed UI              │            │       search tracks        │
│ local song playback        │◀───────────│  create/populate playlist  │
│ Presage camera capture     │ playlist   └───────────────▲────────────┘
│ song graphs + compare UI   │ result                     │
└──────────────┬─────────────┘                            │
               │ JWT-authenticated API calls              │ export request
               │ feed songs / post reactions / get graph  │
               ▼                                          │
┌────────────────────────────┐       narrative request    │
│       FastAPI backend      │────────────────────────┐   │
│ Auth0 JWT validation       │                        ▼   │
│ arousal/valence derivation │               ┌────────────────────────────┐
│ profile rebuilds           │               │       Backboard.io         │
│ recommendations + ML blend │               │ Gemini profile narrative   │
│ song-graph + compare APIs  │               └────────────────────────────┘
│ playlist export API        │──────────────────────────────┘
└───────▲──────┬──────▲──────┘
        │      │      │
        │      │      │ read songs/profiles, write reactions/profiles
        │      │      ▼
        │      │  ┌────────────────────────────┐
        │      │  │          MongoDB           │
        │      │  │ songs                      │
        │      │  │ reactions time-series      │
        │      │  │ profiles                   │
        │      │  └─────────────▲──────────────┘
        │      │                │ seed songs
        │      │                │
        │      │  ┌─────────────|──────────────┐
        │      │  │     Offline extraction     │
        │      │  │    local audio library     │
        │      │  │   librosa feature curves   │
        │      │  │     Gemini audio tags      │
        │      │  └────────────────────────────┘
        │      │
        │      │ same reactions schema as Presage
        │      │ source: "muse"
        │      │
┌───────┴──────▼─────────────┐
│     Optional Muse path     │
│      Muse 2 over BLE       │
│   muse_service band power  │
│    POST /reactions/batch   │
└────────────────────────────┘
```

Spotify is not the source of song audio or analysis data. The app uses a curated local audio
library for playback and feature extraction, then uses Spotify only at export time to search for
matching tracks and create a playlist.

Connection notes:

- Electron gets login tokens from Auth0, then sends those JWTs to FastAPI on every backend call.
- FastAPI is the only runtime writer to `reactions` and `profiles`; offline extraction is the
  writer for seeded `songs`.
- Presage and Muse data land in the same `POST /reactions/batch` shape, with `source` separating
  camera-derived and EEG-derived readings.
- Backboard/Gemini generates profile narratives; Gemini audio tagging happens offline during song
  extraction.
- Spotify stays write-only from Museic's perspective: search for matching tracks, create playlist,
  add recommended songs.

The recommendation path is deliberately staged:

1. **Cold start:** rank songs by cosine similarity between the user's derived taste vector and each
   song's aggregate feature vector.
2. **After enough reactions:** train a tiny per-user ridge model to predict arousal from song
   features, then blend that model score into the recommendation ranking.
3. **Freesolo / free-solo model track:** if we pursue the prize-track training angle, use the
   accumulated cross-user reaction data to train a small model that predicts a per-second arousal
   curve from a song's per-second feature curve. That can be a real trained model demo, but it
   should stay an optional side signal rather than replacing the stable recommender, because the
   event dataset will be small.

## Repo layout

- `app/` — Electron desktop app (React + Vite + TypeScript). Feed UI, Presage SDK capture,
  Auth0 native login (system browser + PKCE + `museic://callback`), per-song graph view,
  two-person compare view.
- `backend/` — FastAPI backend. Auth0 JWT validation (`sub` claim = `user_id`), MongoDB
  (`songs`, `reactions` time-series, `profiles`), arousal/valence derivation, recommendations,
  small per-user arousal model, Spotify playlist export via Auth0 Token Vault, Gemini narrative
  via Backboard.io.
- `scripts/` — Offline extraction pipeline: `extract_features.py` runs librosa per-second
  feature curves + a Gemini tagging pass per track and seeds the `songs` collection.
- `muse_service/` — Standalone muselsl companion service: Muse 2 over BLE → rolling
  alpha/beta band power (`scipy.signal.welch`) → posts into `reactions` with `source: "muse"`.
  Optional at runtime; the app works with Presage alone.
