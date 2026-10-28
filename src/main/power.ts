import { powerSaveBlocker } from "electron";

let blockerId: number | null = null;

/** Weeks-long runs must survive display sleep and App Nap. */
export function startPowerBlock(): void {
  if (blockerId == null) blockerId = powerSaveBlocker.start("prevent-app-suspension");
}

export function stopPowerBlock(): void {
  if (blockerId != null) {
    if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
}
