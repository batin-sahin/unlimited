import { BrowserWindow, dialog, ipcMain } from "electron";
import { checkDelegateHealth } from "./delegates/health.js";
import { deleteProfile, listProfiles, loadProfile, saveProfile } from "./profiles.js";
import type { DelegateKind, ProfileConfig, RunEvent } from "../shared/types";

let win: BrowserWindow | null = null;

export function setWindow(w: BrowserWindow): void {
  win = w;
}

export function emit(event: RunEvent): void {
  if (win && !win.isDestroyed()) win.webContents.send("unlimited:event", event);
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

  ipcMain.handle("unlimited:start-run", (_e, _profileId: string) => {
    // The orchestrator lands in Faz 2; the wizard stays honest until then.
    throw new Error("Run engine is not wired yet (Faz 2).");
  });

  ipcMain.handle("unlimited:panic", () => {
    // Faz 2: stop every agent and every delegate child.
  });
}
