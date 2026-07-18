# Museic — Technical RFC

## 1. Product scope

**Core loop:** user scrolls a feed of songs (TikTok-style) → we capture biometric signal *while each song plays*, from two independent physiological channels (camera + EEG) → we derive arousal and valence, timestamped to the second → we correlate that against timestamped song features → we generate a personalized "music enjoyment profile" (Gemini) and a set of recommendations → we export a playlist to Spotify. Every song a user reacts to gets its own arousal/valence overlay graph, viewable from the app (via `GET /song-graph`, §6) — this isn't just backend data, it's a user-facing screen, e.g. tapping into a song after reacting to it. Two users can also do the core loop side-by-side on the same laptop for a live compatibility-score demo.

This single flow covers: music enjoyment profiling, recommendations, emotion-based playlist bucketing, and a cross-person compatibility score — as one build, not four. Accounts are real, via Auth0 (§6) — identity is the Auth0 `sub` claim, and all reactions/profiles/graphs are tied to that, not to a device-local session. This is a core dependency, not a stretch goal: since everything else in the data model keys off identity, Auth0 needs to be working before the reaction-capture pipeline is built on top of it (§7).

## 2. Architecture

```
┌──────────────┐  login (browser +   ┌──────────────┐
│  Electron app │─PKCE)──────────────▶│    Auth0      │
│ (feed UI +    │◀──────JWT───────────│ identity +    │
│  Presage SDK) │                     │ Token Vault   │
└──────┬────────┘                     └──────┬───────┘
       │ JWT-authenticated requests           │ vends Spotify token
       ▼                                      │ at export time
┌────────────────────┐      ┌─────────────────┐│
│  FastAPI backend     │─────▶│    MongoDB        ││
│  reactions/profiles  │◀─────│ Atlas (time-series ││
│  recommendations     │      │  collections)      ││
│  song-graph/compare  │      └─────────────────┘│
└─────────┬───────┬────┘                         │
          │        └────────────────────────────▶│
          ▼                                       ▼
┌───────────────┐        ┌────────────┐  ┌───────────────┐
│ Backboard.io   │───────▶│  Gemini     │  │ Spotify API   │
│ (orchestration)│        └────────────┘  │ (search +     │
└───────────────┘                          │  playlist)     │
                                            └───────────────┘
┌──────────────┐
│ Muse via      │──▶ posts to FastAPI's /reactions/batch,
│ muselsl (BLE) │    same schema as Presage, source: "muse"
│ → band-power  │
│ companion svc │
└──────────────┘
```

**Frontend is an Electron app, not a website.** Presage's SmartSpectra SDK has no browser/JS-in-a-webpage option — supported platforms are Android (Kotlin), Swift/iOS, C++, and Node.js/Electron. Ship the feed UI as normal web code inside an Electron shell to get camera access to the SDK. Runs on the team's own demo laptop, so this is a non-issue for the live demo (nobody has to install anything).

**Muse runs as a small standalone Python service.** `muselsl` connects over BLE (`bleak` backend), streams raw EEG (channels TP9/AF7/AF8/TP10) plus accelerometer/gyro and PPG — the team's unit is a Muse 2, so PPG is available as a third physiological channel alongside EEG. `muselsl` does not give you alpha/beta band power directly — compute that yourself with `scipy.signal.welch` on a rolling 2–4s window of the raw signal, then post into the same `reactions` collection Presage writes to, tagged with a different `source` field so downstream code treats both sensors identically.

## 3. Song library and feature extraction

Spotify's audio content isn't usable as a live data source: `audio-features`/`audio-analysis` endpoints are dead for any app created after Nov 27, 2024, with no reinstatement path, and full-track raw audio is DRM-protected (Web Playback SDK gives no PCM access; `preview_url` is unreliable). Spotify is **write-only** in this architecture — used only to search for track IDs and create/populate a playlist at the end (`POST /me/playlists`, `POST /playlists/{id}/items`, `GET /search` — all supported in Development Mode, though `search` is capped at 10 results/call as of Feb 2026).

Spotify auth is handled through **Auth0 Token Vault**, not a separately-built OAuth flow (see §6). Register the Spotify Developer app as usual, but point its redirect URI at Auth0's domain rather than the FastAPI backend — Auth0 owns the OAuth exchange and token refresh, and the backend just requests a Spotify-scoped token from Auth0 at export time.

Song content itself is a **curated local library of ~50 tracks**, prepared offline before the event, with two extraction passes per track:

- **Numeric, per-second curves** (tempo, key, RMS energy, spectral centroid) via `librosa`/`essentia`. This is what the arousal-overlay graph is plotted against, so it needs to be precise and timestamped to the second — an LLM listening to audio is not reliable for frame-accurate signal extraction, wrong tool for this part.
- **Qualitative tags** (instruments present, vocal character, mood/genre words) via one Gemini call per track, structured JSON output. This is a classification/description task an LLM is well-suited for, and not worth hand-building a classifier for in a weekend.

Both run once, offline, alongside library prep — not live during the demo.

## 4. Data model (MongoDB)

**`songs`** — static, populated offline:
```json
{
  "_id": "local_042",
  "title": "...", "artist": "...",
  "duration_s": 187,
  "sections": [ {"start_s": 0, "end_s": 18, "label": "intro"}, ... ],
  "features": {
    "tempo_bpm": 128, "key": "A minor",
    "energy_curve": [0.2, 0.24, 0.31, ...],
    "spectral_brightness_curve": [...],
    "onset_density_curve": [...]
  },
  "llm_tags": {
    "instruments": ["808 bass", "synth pad", "hi-hats"],
    "vocal_character": "breathy, mid-range female",
    "mood": ["moody", "propulsive"]
  },
  "spotify_uri": "spotify:track:..."
}
```

**`reactions`** — time-series collection, one document per (user, song, second), sensor-agnostic. `user_id` is the Auth0 `sub` claim — named `user_id`, not `session_id`, since it's a durable per-account identity, not a per-visit one. Raw sensor fields go in; `arousal`/`valence` are computed backend-side (§5), not read directly off any SDK:
```json
{
  "user_id": "...", "song_id": "local_042", "t": 42,
  "source": "presage",
  "raw": {
    "hr_bpm": 88, "hrv_rmssd": 34.2, "stress_index": 61,
    "expression": "happy", "expression_confidence": 0.72,
    "alpha_beta_ratio": null
  },
  "arousal": 0.71, "valence": 0.3,
  "movement_intensity": 0.4,
  "ts": ISODate(...)
}
```
Mongo's time-series bucketing is a genuine fit here — high-frequency, append-only, sensor-timestamped writes are exactly the workload it's built for.

**`profiles`** — derived taste vector per user, a weighted average of song features at high-arousal moments across everything they've reacted to. Construction: for each (song, second) where that user's arousal exceeds their own recent average — weighted by how far above, so bigger spikes count more — pull that song's feature vector at that moment (`energy_curve`, `spectral_brightness_curve`, `onset_density_curve`, tempo, plus the `llm_tags`) and fold it into a running weighted average, with valence sign applied so consistently negative-valence spikes don't get treated the same as positive ones. Recompute on every new batch of reactions — this weighted-average update is what makes the "learns about you over time" claim true, no trained model required. Keep this a similarity/weighted-average model for the hackathon timeframe, not a trained net. If someone wants to train something real for the Freesolo prize track, let it sit alongside as an optional second signal — not load-bearing for the core demo (see §6 for what that model would actually predict).

## 5. Deriving arousal and valence

Presage doesn't expose arousal or valence directly. Its Face Analysis output gives discrete facial expression classification (anger, contempt, disgust, fear, happiness, sadness, surprise, neutral) with confidence scores, plus blink/talk detection and landmarks. Its cardio/breathing output gives pulse rate, HRV (Mean NN, RMSSD, SDNN, Baevsky Stress Index), breathing rate, and waveforms. Only pulse rate and breathing rate are FDA-cleared — everything else is explicitly informational-only per Presage's docs, which is a fine caveat to have ready but doesn't block a hackathon demo.

**Valence:** map the highest-confidence expression category — happy/surprise → positive, sad/fear/anger/disgust/contempt → negative, neutral → baseline.

**Arousal — signal lag matters here.** Metrics update at different effective resolutions even though the payload is delivered at ~1Hz:

- HRV / Baevsky Stress Index: a **60-second rolling window** (confidence is 0 until 60s of data accumulates). A single-moment spike gets smeared across a full minute of lookback — cannot localize to a specific second. Treat it as continuous across the whole session rather than reset per song (it's tracking cardiovascular state, not song-specific), but it stays a slow trend line regardless.
- Pulse rate: a 12-second rolling average. Better, still blurs sharp events.
- Facial expression transitions and movement/accelerometer magnitude: low-lag, near-instant — these are what actually spike *when* something happens, e.g. a surprise-expression jump or a sudden head-bop right as a drop hits.
- Muse alpha/beta band power on a short 2–4s window: same "fast enough to localize" tier as expression/movement.

**Design implication:** the moment-by-moment overlay graph — "arousal peaked when the beat dropped" — should be driven mainly by **expression-transition intensity + movement magnitude (+ Muse band power if connected)**, with HR/HRV folded in underneath as a slower corroborating trend, not the primary line. Weighting all fields equally would wash out exactly the moments the graph exists to show.

**Emotion-triggered playlists fall out of this for free.** Arousal × valence gives the standard circumplex quadrants (hype / chill / sad / tense), computed from data already captured for the core profile — no separate feature build or self-reported mood dataset needed.

## 6. Backend components

**FastAPI endpoints.** No session-creation endpoint — identity comes from the Auth0-issued JWT on every request (validated by FastAPI middleware, `sub` claim used as `user_id`), not a separate call:
- `POST /reactions/batch` — ingest buffered Presage/Muse/IMU data for (user, song)
- `GET /profile/{user_id}` — compute taste vector, trigger Gemini narrative (aggregate across all songs)
- `GET /song-graph/{user_id}/{song_id}` — the per-song arousal/valence overlay graph itself: pulls that user's `reactions` for that one song, joined against the song's `features` curves from §4, returns second-by-second data for the frontend to plot. This is the direct implementation of the original "graph of emotion overlaid on the music" feature — every song a user reacts to should have one, not just the two-person comparison case
- `POST /recommendations/{user_id}` — ranked songs from the local library, scored by cosine similarity between the user's `profiles` taste vector and each song's aggregate feature vector, excluding songs already reacted to (or scored separately if a "you'd probably still like this" repeat path is wanted). Genre/artist/language filters from the original PRD layer on as either a hard filter or an extra weighted term — cheap to add since the `llm_tags` from §3 already carry genre/mood
- `POST /playlist/export` — search Spotify per recommended track, create playlist, add items
- `GET /compare/{user_a}/{user_b}` — same idea as `song-graph`, but joins two users' curves on a shared song, returns compatibility score + graph data

**Recommendations use content similarity first, then trained ML when enough data exists.** At startup, the system ranks by cosine similarity between the user's taste vector and each song's aggregate features. Once the user has enough reaction moments, a small per-user ridge regression predicts arousal from song features and blends that predicted-arousal score into the ranking. This keeps cold-start behavior stable while still making the "learns more about you over time" claim literal.

**The Freesolo-track model, if pursued, is a different task, not a replacement for the recommender.** Train a small model (a light MLP or 1D-CNN is enough) to predict a per-second **arousal curve from a song's feature curve**, using reaction data accumulated across all users during the event as training data. That's a real, honestly-trained model with a clear input/output, demoable for that specific prize track — but it stays an optional side signal alongside the content-based recommender, not a replacement, precisely because the event's dataset will be too small to trust as the sole recommendation source.

**Gemini via Backboard.io.** Route through Backboard rather than hitting Gemini directly, for two concrete reasons: its persistent memory lets the "gets to know you over time" narrative accumulate across sessions without hand-rolled context management, and it's a single swap point if Gemini rate-limits during judging. Two prompt shapes: (1) offline, per-song, structured-JSON instrument/mood tagging from raw audio; (2) per-profile, short narrative generation from arousal-peak timestamps + song metadata.

**Auth0.** Electron apps can't use a normal web login flow — an embedded `BrowserWindow` login form is explicitly the wrong pattern (insecure, violates the OAuth spec's native-app guidance, and Auth0 itself steers you away from it). The correct integration: register the app as a **Native** application type in the Auth0 dashboard (not SPA, not Machine-to-Machine), open the **system browser** for login using Authorization Code Flow with PKCE, and receive the callback back into the app via a **custom URI scheme** (e.g. `museic://callback`) registered as an allowed redirect URI. Store tokens with Electron's `safeStorage`, not plaintext or `localStorage`. Once authenticated, the Auth0 `sub` claim becomes the `user_id` used everywhere else in the data model (§4) — reactions, profiles, and graphs all key off it.

**Auth0 is also the Spotify auth mechanism, via Token Vault** — this is a real use of Auth0 beyond login, not just a login screen. Auth0's Token Vault has a first-party Spotify integration built for connecting a user's account so an app can manage playlists on their behalf: the Spotify Developer app's redirect URI points at Auth0's domain, Auth0 handles the OAuth exchange, and the FastAPI backend requests a Spotify-scoped token from Auth0 at export time rather than implementing Spotify's OAuth flow and token refresh itself. This directly replaces what would otherwise be custom auth code in `POST /playlist/export` (§6).

Optionally, `user_metadata` (Auth0's small per-user key-value store) is a reasonable place for lightweight, user-editable settings — e.g. the genre/language filters mentioned in the recommendations endpoint (§6) — but it's sized for small settings, not for taste vectors or reaction time-series data, which stay in MongoDB regardless.

## 7. Suggested build order

1. Offline: curate ~50-track library, run librosa extraction + one Gemini tagging pass per track, seed Mongo
2. Electron shell spike: confirm camera permissions and the Presage Node SDK behave as expected, alongside the Auth0 native-app login flow (system browser + PKCE + custom URI scheme callback) — both are new platform surfaces worth de-risking together before building on top of either
3. Feed UI + Presage capture + reaction batching, keyed to the authenticated user's `user_id` (Auth0 `sub`) → `reactions` populated end-to-end
4. Muse companion service (band-power calc, same `reactions` schema) — get it in early enough to debug BLE flakiness, but the pipeline above must work without it
5. Arousal/valence derivation (§5) + overlay graph on frontend
6. Two-person compare endpoint + side-by-side graph
7. Emotion-quadrant bucketing (falls out of step 5, minimal extra work)
8. Gemini/Backboard narrative card
9. Spotify search + playlist export
10. Stretch: trained model for Freesolo track

## 8. Remaining risks

- Auth0's native-app flow (system browser + PKCE + custom URI scheme callback) is a different integration than a typical web signup and has more moving parts to get wrong — test the full login round-trip on day one, not as an afterthought once other features depend on it.
- If venue Wi-Fi/BLE is dense with other teams' devices, test Muse's BLE range/stability in that environment before relying on it for the live demo, not just at home.
- Spike-test `POST /me/playlists` + `search` under Development Mode's tightened limits before committing the export flow.
- **Run the Electron app and Muse companion service natively on Windows or macOS, not inside WSL.** WSL2's default kernel has no Bluetooth support (getting it working requires a custom kernel rebuild — an open, unresolved item on Microsoft's own WSL repo, not worth attempting on a clock), and webcam passthrough is similarly unreliable. The backend and offline extraction script have no hardware dependency and can run in WSL2 without issue if that's the preferred dev environment; the two pieces that touch camera/Bluetooth cannot.
- **macOS requires an explicit camera-permission entitlement** (`NSCameraUsageDescription` in the packaged app's Info.plist, set via `electron-builder`'s `mac.extendInfo`) or Presage's camera access silently fails. This isn't automatic just because Electron is cross-platform — it has to be set in the packaging config.
- **Auth0's custom URI scheme callback needs separate registration per OS** in the packaging config (Windows: registry; macOS: `CFBundleURLTypes` in Info.plist) — can behave differently in a packaged build vs. running in dev mode, especially on macOS, so test the packaged app's login flow specifically, not just `electron .`.
- **Presage's Node.js/Electron SDK's macOS support isn't explicitly confirmed** the way their C++ SDK's is (documented for macOS/Linux/Windows). Very likely fine given the shared underlying engine, but worth confirming directly with Presage's docs or support before assuming, rather than discovering it at the venue.
