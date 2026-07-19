import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("museic", {
  login: () => ipcRenderer.invoke("auth:login"),
  connectSpotify: () => ipcRenderer.invoke("auth:connect-spotify"),
  logout: () => ipcRenderer.invoke("auth:logout"),
  getSession: () => ipcRenderer.invoke("auth:get-session"),
  onAuthChanged: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("auth:changed", listener);
    return () => ipcRenderer.removeListener("auth:changed", listener);
  },
  onSpotifyConnected: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("spotify:connected", listener);
    return () => ipcRenderer.removeListener("spotify:connected", listener);
  },
  startCapture: (opts?: { simulate?: boolean }) => ipcRenderer.invoke("capture:start", opts),
  stopCapture: () => ipcRenderer.invoke("capture:stop"),
  onSensorReading: (cb: (reading: unknown) => void) => {
    const listener = (_e: unknown, reading: unknown) => cb(reading);
    ipcRenderer.on("sensor:reading", listener);
    return () => ipcRenderer.removeListener("sensor:reading", listener as never);
  },
  onValidation: (cb: (status: unknown) => void) => {
    const listener = (_e: unknown, status: unknown) => cb(status);
    ipcRenderer.on("sensor:validation", listener);
    return () => ipcRenderer.removeListener("sensor:validation", listener as never);
  },
  setNowPlaying: (songId: string | null) => ipcRenderer.invoke("now-playing:set", songId),
  startMuse: (opts?: { address?: string; simulate?: boolean }) =>
    ipcRenderer.invoke("muse:start", opts),
  stopMuse: () => ipcRenderer.invoke("muse:stop"),
  getMuseStatus: () => ipcRenderer.invoke("muse:status"),
  onMuseStatus: (cb: (status: unknown) => void) => {
    const listener = (_e: unknown, status: unknown) => cb(status);
    ipcRenderer.on("muse:status", listener);
    return () => ipcRenderer.removeListener("muse:status", listener as never);
  },
  getConfig: () => ipcRenderer.invoke("config:get"),
});
