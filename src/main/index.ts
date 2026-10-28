import { app, BrowserWindow, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import { registerIpc, getRunManager, setWindow } from "./ipc.js";
import { buildMenu } from "./menu.js";

const smoke = process.argv.includes("--smoke");
const openDevtools = process.argv.includes("--devtools");
const devServer = process.env.UNLIMITED_DEV_SERVER || "";

app.setName("Unlimited");
if (process.platform === "win32") app.setAppUserModelId("com.asael.unlimited");
// Smoke must not fight an installed app for the single-instance lock or touch
// the real ~/.unlimited profile; give it a throwaway userData path of its own.
if (smoke) {
  app.setPath("userData", path.join(app.getPath("temp"), "unlimited-smoke-user"));
}

let win: BrowserWindow | null = null;

function createWindow(): void {
  const size = /^(\d+)x(\d+)$/.exec(process.env.UNLIMITED_SMOKE_SIZE || "");
  win = new BrowserWindow({
    width: size ? Number(size[1]) : 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: "Unlimited",
    backgroundColor: "#e9ebe7",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 18, y: 20 },
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  setWindow(win);
  buildMenu(win);
  win.webContents.setZoomFactor(1.06);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  win.once("ready-to-show", () => {
    win?.show();
    if (openDevtools) win?.webContents.openDevTools({ mode: "detach" });
  });

  win.on("closed", () => {
    win = null;
  });

  if (devServer) {
    void win.loadURL(devServer);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  if (smoke) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          if (process.env.UNLIMITED_SMOKE_REDUCED) {
            win!.webContents.debugger.attach("1.3");
            await win!.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
              features: [{ name: "prefers-reduced-motion", value: "reduce" }],
            });
          }
          const script = process.env.UNLIMITED_SMOKE_JS;
          if (script) {
            const result = await win!.webContents.executeJavaScript(script, true);
            if (process.env.UNLIMITED_SMOKE_DEBUG) {
              console.log(`SMOKE_JS ${JSON.stringify(result)}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 650));
          }
          const image = await win!.webContents.capturePage();
          const out = path.join(app.getPath("temp"), "unlimited-smoke.png");
          fs.writeFileSync(out, image.toPNG());
          console.log(`SMOKE_OK ${out}`);
        } catch (err: any) {
          console.error(`SMOKE_FAIL ${err?.message || err}`);
        } finally {
          app.quit();
        }
      }, 2200);
    });
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    registerIpc();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin" || smoke) app.quit();
  });

  app.on("before-quit", () => {
    void getRunManager().shutdown();
  });
}
