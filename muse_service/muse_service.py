#!/usr/bin/env python3
"""Muse 2 companion service (RFC §2). Standalone and OPTIONAL at runtime --
the Museic app works with Presage alone if this isn't running or the Muse
doesn't connect.

Pipeline:
  Muse 2 --BLE (muselsl/bleak)--> LSL EEG stream (TP9/AF7/AF8/TP10 @ 256 Hz)
  -> rolling 3 s window -> scipy.signal.welch -> alpha (8-12 Hz) & beta
  (13-30 Hz) band power -> alpha/beta ratio -> POST {BACKEND_URL}/reactions/batch
  with source: "muse", the same schema Presage data uses. muselsl does NOT
  provide band power directly; it is computed here, per §2.

Song alignment: the Electron app writes the currently-playing song to
  <system temp dir>/museic_now_playing.json  ({"song_id": ..., "started_at_ms": ...})
This service polls that file so its readings share the song's second-offsets.
If the file is absent you can pin a song manually with --song-id.

Auth: pass --token <JWT> to persist readings (Copy API token in the app top bar).
Without a token it runs in preview mode -- live band power, nothing posted. When
launched from the app itself, the token is injected automatically.

MUST run natively on Windows/macOS -- WSL has no working Bluetooth (see SETUP.md).

Usage:
    python muse_service.py                     # auto-connect, follow now-playing file
    python muse_service.py --address XX:XX:..  # explicit Muse MAC address
    python muse_service.py --simulate          # no hardware; synthetic band power
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import numpy as np
import requests
from dotenv import load_dotenv
from scipy.signal import welch

NOW_PLAYING_FILE = Path(tempfile.gettempdir()) / "museic_now_playing.json"

# When --emit-json is set, structured status lines are printed with this prefix
# so a parent process (the Electron app) can parse them out of stdout. Human
# prints are left intact for standalone terminal use.
STATUS_PREFIX = "@@MUSE_STATUS@@ "
EMIT_JSON = False


def emit_status(status: str, **extra) -> None:
    if EMIT_JSON:
        print(STATUS_PREFIX + json.dumps({"status": status, **extra}), flush=True)


# np.trapz was renamed to np.trapezoid in NumPy 2.0 and removed; support both.
_trapz = getattr(np, "trapezoid", None) or getattr(np, "trapz")

EEG_SFREQ = 256.0
WINDOW_S = 3.0          # rolling analysis window (2-4 s per RFC §2/§5)
STREAM_TIMEOUT_S = 4.0  # no EEG samples for this long -> stream is dead, stop
POST_EVERY_S = 5        # batch readings before posting
ALPHA_BAND = (8.0, 12.0)
BETA_BAND = (13.0, 30.0)


def band_power(freqs: np.ndarray, psd: np.ndarray, band: tuple[float, float]) -> float:
    mask = (freqs >= band[0]) & (freqs <= band[1])
    if not mask.any():
        return 0.0
    return float(_trapz(psd[mask], freqs[mask]))


def alpha_beta_ratio(window: np.ndarray) -> float | None:
    """window: (n_samples, n_channels). Mean alpha/beta power ratio over channels."""
    if window.shape[0] < int(EEG_SFREQ):
        return None
    ratios = []
    for ch in range(window.shape[1]):
        sig = window[:, ch]
        sig = sig - np.mean(sig)
        freqs, psd = welch(sig, fs=EEG_SFREQ, nperseg=min(512, len(sig)))
        alpha = band_power(freqs, psd, ALPHA_BAND)
        beta = band_power(freqs, psd, BETA_BAND)
        if beta > 0:
            ratios.append(alpha / beta)
    return float(np.mean(ratios)) if ratios else None


# Canonical EEG bands (Hz). Gamma is capped low -- consumer EEG at 256 Hz is
# noisy up top, and the Muse's useful range tops out ~44 Hz.
BANDS: dict[str, tuple[float, float]] = {
    "delta": (1.0, 4.0),
    "theta": (4.0, 8.0),
    "alpha": (8.0, 12.0),
    "beta": (13.0, 30.0),
    "gamma": (30.0, 44.0),
}


def band_powers(window: np.ndarray) -> dict[str, float] | None:
    """Relative power in each canonical band (fraction of total, sums to ~1),
    averaged across the 4 EEG channels. Relative (not absolute) power is far more
    stable for display -- it normalises out per-channel amplitude/contact quality."""
    if window.shape[0] < int(EEG_SFREQ):
        return None
    totals = {b: 0.0 for b in BANDS}
    for ch in range(window.shape[1]):
        sig = window[:, ch] - np.mean(window[:, ch])
        freqs, psd = welch(sig, fs=EEG_SFREQ, nperseg=min(512, len(sig)))
        for b, rng in BANDS.items():
            totals[b] += band_power(freqs, psd, rng)
    total = sum(totals.values())
    if total <= 0:
        return None
    return {b: round(totals[b] / total, 4) for b in BANDS}


def _sim_band_powers() -> dict[str, float]:
    """Plausible drifting relative band powers for --simulate (no hardware)."""
    base = np.array([0.34, 0.20, 0.20, 0.18, 0.08]) + np.random.randn(5) * 0.05
    base = np.clip(base, 0.02, None)
    base /= base.sum()
    return {b: round(float(base[i]), 4) for i, b in enumerate(BANDS)}


def now_playing(cli_song_id: str | None) -> tuple[str, float] | None:
    """Return (song_id, seconds_into_song) or None if nothing is playing."""
    if cli_song_id:
        return cli_song_id, time.time() - _SERVICE_START
    try:
        data = json.loads(NOW_PLAYING_FILE.read_text())
        song_id = data.get("song_id")
        started_ms = data.get("started_at_ms")
        if not song_id or not started_ms:
            return None
        return song_id, time.time() - (started_ms / 1000.0)
    except (OSError, json.JSONDecodeError):
        return None


_SERVICE_START = time.time()


def post_batch(backend: str, token: str, song_id: str, readings: list[dict]) -> None:
    try:
        resp = requests.post(
            f"{backend}/reactions/batch",
            headers={"Authorization": f"Bearer {token}"},
            json={"song_id": song_id, "source": "muse", "readings": readings},
            timeout=10,
        )
        if resp.status_code == 401:
            print("!! backend rejected the token (401). Re-copy the token from the app (it expires).")
            emit_status("error", message="backend rejected the token (401)")
        elif resp.status_code != 200:
            print(f"!! post failed: {resp.status_code} {resp.text[:200]}")
            emit_status("error", message=f"post failed: {resp.status_code}")
        else:
            print(f"posted {len(readings)} muse reading(s) for {song_id}")
            last_ratio = readings[-1].get("raw", {}).get("alpha_beta_ratio") if readings else None
            emit_status("posted", count=len(readings), song_id=song_id, last_ratio=last_ratio)
    except requests.RequestException as exc:
        print(f"!! backend unreachable ({exc}); dropping batch")
        emit_status("error", message=f"backend unreachable: {exc}")


def connect_lsl(address: str | None):
    """Resolve an LSL EEG stream; if none, spawn `muselsl stream` and retry."""
    from pylsl import StreamInlet, resolve_byprop

    emit_status("connecting")
    print("looking for an LSL EEG stream ...")
    streams = resolve_byprop("type", "EEG", timeout=5)
    if not streams:
        print("none found -- launching `muselsl stream` (BLE connect, can take ~20 s)")
        cmd = [sys.executable, "-m", "muselsl", "stream"]
        if address:
            cmd += ["--address", address]
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 60
        while time.time() < deadline:
            streams = resolve_byprop("type", "EEG", timeout=5)
            if streams:
                break
        if not streams:
            print("!! could not find a Muse EEG stream. Is the headband on and in range?")
            print("   (Run `muselsl list` to check discovery. Windows/macOS native only, not WSL.)")
            emit_status("error", message="no Muse EEG stream found (is the headband on and in range?)")
            sys.exit(1)
    print("EEG stream connected")
    return StreamInlet(streams[0], max_chunklen=64)


def run(backend: str, token: str | None, cli_song_id: str | None, address: str | None,
        simulate: bool) -> None:
    buf: list[list[float]] = []  # rolling raw samples, 4 channels
    pending: list[dict] = []
    current_song: str | None = None
    inlet = None if simulate else connect_lsl(address)

    # No token -> "preview" mode: still connect and compute band power so the
    # headband can be verified and its live signal shown, but nothing is posted
    # to the backend (reactions are always keyed to an authenticated user).
    preview = token is None
    emit_status("streaming", simulated=simulate, preview=preview)
    print("streaming; Ctrl+C to stop" + (" (preview: not logged in, nothing saved)" if preview else ""))
    last_reading_sec = -1        # wall-clock second of the last UI reading emit
    last_song_t = -1             # song-offset second of the last posted reading
    last_ratio: float | None = None
    last_data_ts = time.time()   # wall-clock of the last real EEG samples received
    while True:
        if simulate:
            time.sleep(1.0 / 32)
            buf.append(list(np.random.randn(4) * 30))
        else:
            chunk, _ = inlet.pull_chunk(timeout=1.0, max_samples=64)
            for sample in chunk:
                buf.append(sample[:4])  # TP9, AF7, AF8, TP10 (drop AUX)
            if chunk:
                last_data_ts = time.time()
            elif time.time() - last_data_ts > STREAM_TIMEOUT_S:
                # The LSL stream stopped delivering (headband dropped / muselsl
                # stream died). Fail loudly instead of looping on a stale buffer
                # and emitting the same frozen ratio forever.
                print("!! EEG stream went silent -- headband disconnected? Stopping.")
                emit_status("error", message="EEG stream lost (headband disconnected or out of range)")
                return
        max_len = int(EEG_SFREQ * WINDOW_S)
        if len(buf) > max_len:
            del buf[: len(buf) - max_len]

        # 1) Live signal for the UI: compute band power once per wall-clock
        # second and emit it ALWAYS -- regardless of login or whether a song is
        # playing. This is what drives the Signals dashboard; without it a
        # logged-in user sitting on that page (no song) would see nothing.
        now_sec = int(time.time())
        if now_sec != last_reading_sec and len(buf) >= int(EEG_SFREQ):
            window = np.asarray(buf, dtype=float)
            ratio = alpha_beta_ratio(window)
            bands = band_powers(window)
            if simulate:
                ratio = float(np.clip(np.random.lognormal(mean=0.0, sigma=0.4), 0.2, 4.0))
                bands = _sim_band_powers()
            if ratio is not None:
                emit_status("reading", ratio=round(ratio, 4), bands=bands)
                last_reading_sec = now_sec
                last_ratio = ratio

        # 2) Preview mode (no token): never post to the backend.
        if preview:
            continue

        # 3) Logged in: attribute the latest reading to the currently-playing
        # song and post it. Only the alpha/beta ratio is persisted (it feeds
        # arousal); the per-band powers stay display-only.
        playing = now_playing(cli_song_id)
        if playing is None:
            if pending and current_song:
                post_batch(backend, token, current_song, pending)
                pending = []
            current_song = None
            continue
        song_id, t_float = playing
        t = int(t_float)
        if t < 0:
            continue

        if song_id != current_song:
            if pending and current_song:
                post_batch(backend, token, current_song, pending)
            pending = []
            current_song = song_id
            last_song_t = -1

        if t != last_song_t and last_ratio is not None:
            pending.append(
                {
                    "t": t,
                    "raw": {"alpha_beta_ratio": round(last_ratio, 4)},
                    "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                }
            )
            last_song_t = t
        if len(pending) >= POST_EVERY_S and current_song:
            post_batch(backend, token, current_song, pending)
            pending = []


def main() -> int:
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", default=os.getenv("BACKEND_URL", "http://127.0.0.1:8000"))
    parser.add_argument("--token", default=None,
                        help="user JWT to persist readings (app: top bar -> Copy API token). "
                             "Omit to run in preview mode (live signal only, nothing saved).")
    parser.add_argument("--song-id", help="pin a song id instead of following the app")
    parser.add_argument("--address", help="Muse MAC address (skips discovery)")
    parser.add_argument("--simulate", action="store_true", help="no hardware; fake band power")
    parser.add_argument("--emit-json", action="store_true",
                        help="print machine-readable status lines for a parent process (the app)")
    args = parser.parse_args()

    global EMIT_JSON
    EMIT_JSON = args.emit_json

    # No token (or empty) -> preview mode.
    token = args.token or None
    if token is None:
        # Preview mode: connect + show live band power without posting. Useful
        # for verifying the headband before login. Pass --token to persist.
        print("No user token -- running in preview mode (live signal only, nothing saved).",
              file=sys.stderr)
    try:
        run(args.backend, token, args.song_id, args.address, args.simulate)
    except KeyboardInterrupt:
        print("\nstopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
