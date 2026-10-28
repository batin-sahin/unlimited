import { contextBridge, ipcRenderer } from "electron";
import type { RunEvent, UnlimitedApi } from "../shared/types";

const api: UnlimitedApi = {
  bootstrap: () => ipcRenderer.invoke("unlimited:bootstrap"),
  saveProfile: (profile) => ipcRenderer.invoke("unlimited:save-profile", profile),
  loadProfile: (id) => ipcRenderer.invoke("unlimited:load-profile", id),
  deleteProfile: (id) => ipcRenderer.invoke("unlimited:delete-profile", id),
  pickDirectory: () => ipcRenderer.invoke("unlimited:pick-directory"),
  checkDelegate: (kind) => ipcRenderer.invoke("unlimited:check-delegate", kind),
  startRun: (profileId) => ipcRenderer.invoke("unlimited:start-run", profileId),
  resumeRun: (priorRunId) => ipcRenderer.invoke("unlimited:resume-run", priorRunId),
  resumableRuns: () => ipcRenderer.invoke("unlimited:resumable-runs"),
  panic: () => ipcRenderer.invoke("unlimited:panic"),
  onEvent: (cb) => {
    const listener = (_e: unknown, event: RunEvent) => cb(event);
    ipcRenderer.on("unlimited:event", listener);
    return () => ipcRenderer.removeListener("unlimited:event", listener);
  },
};

contextBridge.exposeInMainWorld("unlimited", api);
