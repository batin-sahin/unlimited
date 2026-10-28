/**
 * Turn watchdog: a dead provider connection looks exactly like a patiently
 * thinking model until someone notices. This timer notices. Pure timing —
 * no I/O, no Electron, no clocks of its own beyond one setTimeout.
 */

/** Six minutes of TOTAL silence from a provider is a dead connection, not a thinking model. */
export const TURN_WATCHDOG_MS = 6 * 60_000;

/** One-shot inactivity timer for a provider turn: arm → feed() on every stream chunk → onTimeout fires once after timeoutMs of total silence; re-arm to go again. */
export class TurnWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private firedThisArm = false;
  private readonly opts: { timeoutMs: number; onTimeout: () => void };

  constructor(opts: { timeoutMs: number; onTimeout: () => void }) {
    this.opts = opts;
  }

  /** Start (or restart) the silence timer; any pending timer is replaced and the once-per-arm latch resets. */
  arm(): void {
    this.clear();
    this.firedThisArm = false;
    this.start();
  }

  /** Reset the running timer (call on every stream chunk); a no-op when the watchdog is not armed. Feeding never arms a disarmed watchdog and never re-fires a fired one. */
  feed(): void {
    if (!this.timer) return;
    this.clear();
    this.start();
  }

  /** Cancel the pending timer; the watchdog stays inert until armed again. */
  disarm(): void {
    this.clear();
  }

  /** Cancel the pending timer for good hygiene at teardown; harmless to call repeatedly, and the instance can be armed again afterwards. */
  dispose(): void {
    this.clear();
  }

  /** setTimeout is inherently one-shot, but the latch makes the once-per-arm contract explicit and re-entry-proof. */
  private start(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.firedThisArm) return;
      this.firedThisArm = true;
      this.opts.onTimeout();
    }, Math.max(1, this.opts.timeoutMs));
  }

  private clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
