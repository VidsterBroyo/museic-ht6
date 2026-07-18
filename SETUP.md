# Museic — Setup

Three sections, per the build brief:
**(a)** every credential/account you must create yourself,
**(b)** every stub/placeholder in the code that needs something only you can provide,
**(c)** exact commands to run everything locally on Windows and macOS.

---

## (a) Credentials & accounts you need to create

All of these go into the repo-root `.env` (copy `.env.example` → `.env`). Nothing is hardcoded.

### 1. MongoDB (`MONGODB_URI`)
- Create a free cluster at https://cloud.mongodb.com (or run a local `mongod`).
- Atlas: Database Access → add a user; Network Access → allow your IP; Connect → Drivers → copy the connection string.
- The backend creates `reactions` as a **time-series collection** automatically on first start (requires MongoDB 5.0+; Atlas free tier is fine).

### 2. Auth0 — identity (`AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_AUDIENCE`)
1. Create a tenant at https://manage.auth0.com.
2. **Native application** (Applications → Create Application → *Native* — NOT SPA):
   - Allowed Callback URLs: `museic://callback`
   - Grant types (Advanced Settings → Grant Types): Authorization Code + Refresh Token.
   - Copy Domain → `AUTH0_DOMAIN`, Client ID → `AUTH0_CLIENT_ID`.
3. **Backend API** (Applications → APIs → Create API):
   - Identifier: e.g. `https://api.museic.local` → `AUTH0_AUDIENCE` (cannot be changed later).

### 3. Auth0 — Token Vault for Spotify (`AUTH0_TOKEN_VAULT_CLIENT_ID/SECRET`, `AUTH0_SPOTIFY_CONNECTION`)
Auth0 owns the Spotify OAuth exchange — there is deliberately **no Spotify OAuth flow in this codebase**.
1. **Spotify Developer app** (https://developer.spotify.com/dashboard → Create app):
   - Redirect URI: `https://YOUR_AUTH0_DOMAIN/login/callback` (points at Auth0, NOT this backend).
   - Note the Client ID/Secret for the next step.
2. **Auth0 Spotify connection** (Authentication → Social → Create Connection → Spotify):
   - Paste the Spotify Client ID/Secret; scopes must include `playlist-modify-public playlist-modify-private`.
   - Enable **Connected Accounts for Token Vault** on the connection.
   - Connection name → `AUTH0_SPOTIFY_CONNECTION` (usually `spotify`).
3. **Custom API Client** for the access-token exchange (Applications → APIs → your backend API → *Add Application*):
   - The created client has the Token Vault grant enabled; copy its Client ID/Secret →
     `AUTH0_TOKEN_VAULT_CLIENT_ID` / `AUTH0_TOKEN_VAULT_CLIENT_SECRET`.
   - Tenant MFA policy must not be "Always" (Token Vault limitation).
4. Each user connects their Spotify account once (Connected Accounts flow) before their first
   playlist export — otherwise the exchange returns 401 and the backend surfaces a clear error.
5. RFC §8 risk: spike-test `search` + playlist create early — Spotify Development Mode limits are tight.

### 4. Backboard.io (`BACKBOARD_API_KEY`, optional `BACKBOARD_ASSISTANT_ID`)
- Sign up at https://app.backboard.io → Settings → API Keys.
- Leave `BACKBOARD_ASSISTANT_ID` empty on first run; the backend creates a "Museic Narrator"
  assistant and logs its id — paste that into `.env` so narrative memory persists across restarts.

### 5. Gemini direct key (`GEMINI_API_KEY`) — offline tagging only
- https://aistudio.google.com/apikey.
- Used ONLY by `scripts/extract_features.py`. **Deviation from RFC §3, agreed during the build:**
  Backboard.io does not accept audio file uploads, so the per-song tagging pass calls the Gemini
  API directly with the audio; the per-profile narrative still goes through Backboard.

### 6. Presage SmartSpectra (`PRESAGE_API_KEY`)
- Register at https://physiology.presagetech.com → get an API key.
- The Electron app uses Presage's public `@smartspectra/node-sdk` package. The SDK docs list
  macOS Apple Silicon (`darwin-arm64`), Linux x64/ARM64, and Windows x64 as supported.
- Optional camera overrides for the Electron app: `PRESAGE_CAMERA_INDEX`, `PRESAGE_CAMERA_WIDTH`,
  `PRESAGE_CAMERA_HEIGHT`, `PRESAGE_CAMERA_FPS`.

---

## (b) Stubs / placeholders that need something only you can provide

1. **Presage API key.** The SDK wiring is installed in `app/electron/presage.ts`; you only need
   to set `PRESAGE_API_KEY` in `.env`. If the key is missing or the native SDK cannot start,
   the app falls back to a clearly-labelled **simulation** (yellow banner in the feed) so every
   downstream piece is still testable end-to-end.
2. **Your audio library.** Point `AUDIO_DIR` in `.env` at your folder of ~50 local tracks and run
   `scripts/extract_features.py` (see below). Name files `Artist - Title.mp3` for automatic
   metadata. Tracks over ~18 MB skip Gemini tagging (inline upload limit) — re-encode or tag
   manually in Mongo.
3. **`spotify_uri` on songs is `null` by default** — export falls back to Spotify search per
   track (title/artist), which is fuzzy. Pre-fill `spotify_uri` in the `songs` collection for
   tracks you care about in the demo.
4. **`BACKBOARD_ASSISTANT_ID`** — created on first profile view; paste the logged id into `.env`
   (see section a.4).
5. **`MUSE_USER_TOKEN`** — per-session user JWT for the Muse companion service. Log into the app →
   top bar → **Copy API token** → paste into `.env` (tokens expire; re-copy each session).
6. **Song sections are heuristic** (energy-based high/low segmentation in
   `scripts/extract_features.py:heuristic_sections`) — hand-edit the `sections` array in Mongo
   for demo tracks if you want accurate "peaked during the drop" labels.

---

## (c) Running locally

### One-time setup (both OSes)

```
git clone <this repo> && cd museic
copy .env.example .env        # macOS/Linux: cp .env.example .env
# fill in .env per section (a)
```

Python (3.11+ recommended) — one venv per component, or a shared one:

```
python -m venv .venv
# Windows (PowerShell):
.\.venv\Scripts\Activate.ps1
# macOS:
source .venv/bin/activate

pip install -r backend/requirements.txt -r scripts/requirements.txt -r muse_service/requirements.txt
```

Node 18+ (Electron 33 bundles its own runtime):

```
cd app
npm install
cd ..
```

### 1. Seed the song library (offline, once)

```
# venv active, from the repo root
python scripts/extract_features.py --audio-dir "C:\path\to\your\music"
# macOS: python scripts/extract_features.py --audio-dir "/path/to/your/music"
```

### 2. Start the backend

```
# venv active, from the repo root
uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

### 3. Start the Electron app (dev mode)

```
cd app
npm run dev
```

Log in (system browser opens → museic:// bounces back into the app), then scroll and react.

### 4. (Optional) Muse companion service

⚠️ Run **natively on Windows or macOS — NOT inside WSL**. WSL2's default kernel has no
Bluetooth support (webcam passthrough is similarly unreliable); the backend and extraction
script are fine in WSL, the two hardware-touching pieces are not.

```
# venv active, Muse 2 powered on, MUSE_USER_TOKEN set in .env
python muse_service/muse_service.py
# no hardware handy? end-to-end test with:
python muse_service/muse_service.py --simulate
```

The app writes the currently-playing song to a temp file the service follows automatically.
Everything works without this service — it's an additive third signal.

### 5. Packaged builds (needed to test the real login flow on macOS)

```
cd app
npm run package:win    # Windows: NSIS installer, registers museic:// in the registry
npm run package:mac    # macOS: registers CFBundleURLTypes + NSCameraUsageDescription (Info.plist)
```

- The `museic://` scheme and the macOS camera-permission entitlement are configured in
  `app/package.json` → `build.protocols` / `build.mac.extendInfo`. These only take full effect
  in packaged builds.
- RFC §8: on macOS, **test login in the packaged app specifically** — dev-mode custom-scheme
  delivery differs from packaged behaviour.

### Two-person compare demo

1. Person A logs in, reacts to 2–3 songs. Log out.
2. Person B logs in (different Auth0 account), reacts to the same songs.
3. Compare tab → paste person A's user id (their Auth0 `sub`, shown in the profile view/top bar).
