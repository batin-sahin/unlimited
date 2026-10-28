import { BrowserWindow, dialog, ipcMain } from "electron";
import { checkDelegateHealth } from "./delegates/health.js";
import { deleteProfile, listProfiles, loadProfile, saveProfile } from "./profiles.js";
import { RunManager } from "./orchestrator.js";
import type { DelegateKind, ProfileConfig, RunEvent } from "../shared/types";

let win: BrowserWindow | null = null;
let runManager: RunManager | null = null;

export function setWindow(w: BrowserWindow): void {
  win = w;
}

export function emit(event: RunEvent): void {
  if (win && !win.isDestroyed()) win.webContents.send("unlimited:event", event);
}

export function getRunManager(): RunManager {
  if (!runManager) runManager = new RunManager(emit);
  return runManager;
}

function manager(): RunManager {
  return getRunManager();
}

export function registerIpc(): void {
  ipcMain.handle("unlimited:bootstrap", () => ({
    version: "0.1.0",
    profiles: listProfiles(),
  }));

  ipcMain.handle("unlimited:save-profile", (_e, profile: ProfileConfig) => {
    saveProfile(profile);
  });

  ipcMain.handle("unlimited:load-profile", (_e, id: string) => loadProfile(id));

  ipcMain.handle("unlimited:delete-profile", (_e, id: string) => {
    deleteProfile(id);
  });

  ipcMain.handle("unlimited:pick-directory", async () => {
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      title: "Choose the target project directory",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });

  ipcMain.handle("unlimited:check-delegate", (_e, kind: DelegateKind) => checkDelegateHealth(kind));

  ipcMain.handle("unlimited:start-run", (_e, profileId: string) => manager().startRun(profileId));

  ipcMain.handle("unlimited:panic", () => {
    manager().panic();
  });
}
