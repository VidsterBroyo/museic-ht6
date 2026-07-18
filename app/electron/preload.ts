import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("museic", {
  login: () => ipcRenderer.invoke("auth:login"),
  logout: () => ipcRenderer.invoke("auth:logout"),
  getSession: () => ipcRenderer.invoke("auth:get-session"),
  onAuthChanged: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("auth:changed", listener);
    return () => ipcRenderer.removeListener("auth:changed", listener);
  },
  startCapture: () => ipcRenderer.invoke("capture:start"),
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
  getConfig: () => ipcRenderer.invoke("config:get"),
});
