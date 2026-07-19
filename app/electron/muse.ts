/**
 * Muse 2 companion-service manager (RFC §2).
 *
 * Instead of the user running `python muse_service/muse_service.py` in a
 * separate terminal, the app spawns and supervises that same Python service as
 * a child process. The service's DSP (muselsl BLE -> pylsl -> welch band power)
 * is reused verbatim; this module only starts/stops it, injects the user's
 * access token automatically, and parses its `--emit-json` status lines so the
 * renderer can show live connection state.
 *
 * The service still writes to the backend over HTTP and reads the shared
 * now-playing beacon file, exactly as in standalone mode -- nothing about the
 * data path changes, only who launches it.
 */
import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

export type MuseStatus =
  | { state: "stopped" }
  | { state: "starting" }
  | { state: "connecting" }
  | {
      state: "streaming";
      simulated?: boolean;
      preview?: boolean;
      lastRatio?: number | null;
      bands?: Record<string, number> | null;
      movement?: number | null;
      asymmetry?: number | null;
      frontalTheta?: number | null;
      posted?: number;
    }
  | { state: "error"; message: string };

const STATUS_PREFIX = "@@MUSE_STATUS@@ ";

type Emit = (status: MuseStatus) => void;

let child: ChildProcess | null = null;
let status: MuseStatus = { state: "stopped" };
let emit: Emit = () => {};
let postedTotal = 0;

/** Repo root: dist-electron -> app -> repo. */
function repoRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

/** Prefer the repo-root venv interpreter (where muselsl/pylsl are installed). */
function resolvePython(): string {
  const root = repoRoot();
  const venv =
    process.platform === "win32"
      ? path.join(root, ".venv", "Scripts", "python.exe")
      : path.join(root, ".venv", "bin", "python");
  if (fs.existsSync(venv)) return venv;
  return process.platform === "win32" ? "python" : "python3";
}

function setStatus(next: MuseStatus): void {
  status = next;
  emit(next);
}

export function getStatus(): MuseStatus {
  return status;
}

export function isRunning(): boolean {
  return child !== null;
}

export function startMuse(
  opts: { token?: string; address?: string; simulate?: boolean },
  onStatus: Emit,
): MuseStatus {
  stopMuse();
  emit = onStatus;
  postedTotal = 0;

  const root = repoRoot();
  const script = path.join(root, "muse_service", "muse_service.py");
  const args = [script, "--emit-json"];
  if (opts.token) args.push("--token", opts.token); // omitted -> service preview mode
  if (opts.address) args.push("--address", opts.address);
  if (opts.simulate) args.push("--simulate");

  setStatus({ state: "starting" });
  try {
    child = spawn(resolvePython(), args, { cwd: root, env: { ...process.env } });
  } catch (err) {
    setStatus({ state: "error", message: `could not launch muse service: ${String(err)}` });
    child = null;
    return status;
  }

  // Parse newline-delimited stdout for @@MUSE_STATUS@@ sentinel lines.
  let buf = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      handleLine(line);
    }
  });
  child.stderr?.on("data", (d: Buffer) => console.error("[muse]", d.toString().trimEnd()));

  child.on("error", (err) => {
    setStatus({ state: "error", message: String(err) });
    child = null;
  });
  child.on("exit", (code, signal) => {
    child = null;
    // A clean SIGTERM (our own stopMuse) or code 0 is a normal stop; anything
    // else while we still thought we were running is an error.
    if (signal === "SIGTERM" || code === 0) {
      if (status.state !== "stopped") setStatus({ state: "stopped" });
    } else if (status.state !== "error") {
      setStatus({ state: "error", message: `muse service exited (code ${code ?? signal})` });
    }
  });

  return status;
}

function handleLine(line: string): void {
  if (!line.startsWith(STATUS_PREFIX)) return; // human log line; ignore
  let msg: { status: string; [k: string]: unknown };
  try {
    msg = JSON.parse(line.slice(STATUS_PREFIX.length));
  } catch {
    return;
  }
  switch (msg.status) {
    case "connecting":
      setStatus({ state: "connecting" });
      break;
    case "streaming":
      setStatus({
        state: "streaming",
        simulated: Boolean(msg.simulated),
        preview: Boolean(msg.preview),
        posted: postedTotal,
      });
      break;
    case "reading": {
      // Live band power + per-band powers, nothing persisted.
      const prev = status.state === "streaming" ? status : null;
      setStatus({
        state: "streaming",
        simulated: prev?.simulated,
        preview: prev?.preview ?? true,
        lastRatio: (msg.ratio as number | null) ?? null,
        bands: (msg.bands as Record<string, number> | null) ?? prev?.bands ?? null,
        // Explicit null (stale IMU) must clear, not stick to the last value.
        movement: (msg.movement as number | null | undefined) ?? null,
        asymmetry: (msg.asymmetry as number | null | undefined) ?? null,
        frontalTheta: (msg.frontal_theta as number | null | undefined) ?? null,
        posted: postedTotal,
      });
      break;
    }
    case "posted":
      postedTotal += typeof msg.count === "number" ? msg.count : 0;
      setStatus({
        state: "streaming",
        simulated: status.state === "streaming" ? status.simulated : undefined,
        preview: status.state === "streaming" ? status.preview : undefined,
        lastRatio: (msg.last_ratio as number | null) ?? null,
        bands: status.state === "streaming" ? status.bands : null,
        posted: postedTotal,
      });
      break;
    case "error":
      setStatus({ state: "error", message: String(msg.message ?? "muse service error") });
      break;
    default:
      break;
  }
}

export function stopMuse(): void {
  if (child) {
    child.kill("SIGTERM");
    child = null;
  }
  if (status.state !== "stopped") setStatus({ state: "stopped" });
}
