/**
 * Electron main process.
 *
 * Cross-platform custom URI scheme handling for the Auth0 callback:
 *  - Windows: the OS launches a second instance with museic://... in argv ->
 *    single-instance lock + "second-instance" event. Dev-mode registration
 *    needs setAsDefaultProtocolClient with execPath+argv; packaged builds get
 *    a registry entry from electron-builder's `protocols` config.
 *  - macOS: the OS delivers "open-url" to the running instance. Packaged
 *    builds get CFBundleURLTypes from the same `protocols` config. NOTE: test
 *    the PACKAGED app's login flow on macOS specifically -- dev-mode protocol
 *    delivery behaves differently (RFC §8).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BrowserWindow, app, ipcMain } from "electron";
import * as dotenv from "dotenv";

// Load repo-root .env (app/ is one level below the repo root in dev).
dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") });
dotenv.config({ path: path.resolve(__dirname, "..", ".env") }); // optional app/.env override

import * as auth from "./auth";
import * as presage from "./presage";
import * as muse from "./muse";

// macOS GPU driver crashes (SIGBUS + "texture unloadable") when compositing the
// live webcam <video> texture alongside the charts. Software compositing is
// plenty for this UI and sidesteps the native crash. Must run before app-ready.
app.disableHardwareAcceleration();

const BACKEND_URL = process.env.BACKEND_URL ?? "http://127.0.0.1:8000";
const NOW_PLAYING_FILE = path.join(os.tmpdir(), "museic_now_playing.json");

let mainWindow: BrowserWindow | null = null;

// ---------------------------------------------------------------------------
// Protocol registration + single instance (Windows callback path)
// ---------------------------------------------------------------------------
if (process.defaultApp && process.argv.length >= 2) {
  // Dev mode (`electron .`): must pass execPath + entry arg for Windows.
  app.setAsDefaultProtocolClient("museic", process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient("museic");
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    // Windows/Linux: the museic:// url arrives in the second instance's argv.
    const url = argv.find((a) => a.startsWith("museic://"));
    if (url) void handleAuthCallback(url);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// macOS: open-url can fire before ready; capture and replay.
let pendingOpenUrl: string | null = null;
app.on("open-url", (event, url) => {
  event.preventDefault();
  if (app.isReady()) void handleAuthCallback(url);
  else pendingOpenUrl = url;
});

async function handleAuthCallback(url: string): Promise<void> {
  const ok = await auth.handleCallbackUrl(url);
  if (ok) mainWindow?.webContents.send("auth:changed");
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: "#0e0e14",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const devServer = process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:5173";
  if (app.isPackaged) {
    void mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  } else {
    void mainWindow.loadURL(devServer);
  }
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  if (pendingOpenUrl) {
    void handleAuthCallback(pendingOpenUrl);
    pendingOpenUrl = null;
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  presage.stopCapture();
  muse.stopMuse();
  clearNowPlaying();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  muse.stopMuse();
});

// ---------------------------------------------------------------------------
// Now-playing beacon for the optional Muse companion service
// ---------------------------------------------------------------------------
function setNowPlaying(songId: string | null): void {
  try {
    if (songId) {
      fs.writeFileSync(
        NOW_PLAYING_FILE,
        JSON.stringify({ song_id: songId, started_at_ms: Date.now() }),
      );
    } else {
      clearNowPlaying();
    }
  } catch (err) {
    console.warn("could not write now-playing file", err);
  }
}

function clearNowPlaying(): void {
  try {
    fs.rmSync(NOW_PLAYING_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// IPC surface (see preload.ts)
// ---------------------------------------------------------------------------
ipcMain.handle("auth:login", () => auth.beginLogin());
ipcMain.handle("auth:logout", () => {
  auth.logout();
  mainWindow?.webContents.send("auth:changed");
});
ipcMain.handle("auth:get-session", async () => {
  const accessToken = await auth.getAccessToken();
  return accessToken ? { accessToken, user: auth.getUserClaims() } : null;
});

ipcMain.handle("capture:start", (_event, opts?: { simulate?: boolean }) => {
  return presage.startCapture(
    (reading) => {
      mainWindow?.webContents.send("sensor:reading", reading);
    },
    (status) => {
      mainWindow?.webContents.send("sensor:validation", status);
    },
    opts,
  );
});
ipcMain.handle("capture:stop", () => presage.stopCapture());

ipcMain.handle("now-playing:set", (_event, songId: string | null) => setNowPlaying(songId));

// Muse companion service: launched in-process, token injected from the session.
ipcMain.handle("muse:start", async (_event, opts?: { address?: string; simulate?: boolean }) => {
  // Token optional: without login the service runs in preview mode (live signal
  // only, nothing persisted). With a token, readings are saved for the user.
  const token = (await auth.getAccessToken()) ?? undefined;
  return muse.startMuse(
    { token, address: opts?.address, simulate: opts?.simulate },
    (s) => mainWindow?.webContents.send("muse:status", s),
  );
});
ipcMain.handle("muse:stop", () => muse.stopMuse());
ipcMain.handle("muse:status", () => muse.getStatus());

ipcMain.handle("config:get", () => ({ backendUrl: BACKEND_URL }));
