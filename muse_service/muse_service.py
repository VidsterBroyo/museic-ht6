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

Auth: needs a user JWT (MUSE_USER_TOKEN in the repo-root .env, or --token).
Copy it from the app: profile menu -> "Copy API token".

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

EEG_SFREQ = 256.0
WINDOW_S = 3.0          # rolling analysis window (2-4 s per RFC §2/§5)
POST_EVERY_S = 5        # batch readings before posting
ALPHA_BAND = (8.0, 12.0)
BETA_BAND = (13.0, 30.0)


def band_power(freqs: np.ndarray, psd: np.ndarray, band: tuple[float, float]) -> float:
    mask = (freqs >= band[0]) & (freqs <= band[1])
    if not mask.any():
        return 0.0
    return float(np.trapz(psd[mask], freqs[mask]))


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
            print("!! backend rejected the token (401). Re-copy MUSE_USER_TOKEN from the app.")
        elif resp.status_code != 200:
            print(f"!! post failed: {resp.status_code} {resp.text[:200]}")
        else:
            print(f"posted {len(readings)} muse reading(s) for {song_id}")
    except requests.RequestException as exc:
        print(f"!! backend unreachable ({exc}); dropping batch")


def connect_lsl(address: str | None):
    """Resolve an LSL EEG stream; if none, spawn `muselsl stream` and retry."""
    from pylsl import StreamInlet, resolve_byprop

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
            sys.exit(1)
    print("EEG stream connected")
    return StreamInlet(streams[0], max_chunklen=64)


def run(backend: str, token: str, cli_song_id: str | None, address: str | None,
        simulate: bool) -> None:
    buf: list[list[float]] = []  # rolling raw samples, 4 channels
    pending: list[dict] = []
    current_song: str | None = None
    inlet = None if simulate else connect_lsl(address)

    print("streaming; Ctrl+C to stop")
    last_second_emitted = -1
    while True:
        if simulate:
            time.sleep(1.0 / 32)
            buf.append(list(np.random.randn(4) * 30))
        else:
            chunk, _ = inlet.pull_chunk(timeout=1.0, max_samples=64)
            for sample in chunk:
                buf.append(sample[:4])  # TP9, AF7, AF8, TP10 (drop AUX)
        max_len = int(EEG_SFREQ * WINDOW_S)
        if len(buf) > max_len:
            del buf[: len(buf) - max_len]

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
            last_second_emitted = -1

        if t != last_second_emitted and len(buf) >= int(EEG_SFREQ):
            window = np.asarray(buf, dtype=float)
            ratio = alpha_beta_ratio(window)
            if simulate:
                ratio = float(np.clip(np.random.lognormal(mean=0.0, sigma=0.4), 0.2, 4.0))
            if ratio is not None:
                pending.append(
                    {
                        "t": t,
                        "raw": {"alpha_beta_ratio": round(ratio, 4)},
                        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    }
                )
                last_second_emitted = t
        if len(pending) >= POST_EVERY_S and current_song:
            post_batch(backend, token, current_song, pending)
            pending = []


def main() -> int:
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", default=os.getenv("BACKEND_URL", "http://127.0.0.1:8000"))
    parser.add_argument("--token", default=os.getenv("MUSE_USER_TOKEN"),
                        help="user JWT (app: profile menu -> Copy API token)")
    parser.add_argument("--song-id", help="pin a song id instead of following the app")
    parser.add_argument("--address", help="Muse MAC address (skips discovery)")
    parser.add_argument("--simulate", action="store_true", help="no hardware; fake band power")
    args = parser.parse_args()

    if not args.token:
        print("No user token. Set MUSE_USER_TOKEN in .env or pass --token.", file=sys.stderr)
        return 1
    try:
        run(args.backend, args.token, args.song_id, args.address, args.simulate)
    except KeyboardInterrupt:
        print("\nstopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
