import type { DailyWindow } from "../shared/types.js";

/**
 * Wall-clock work budget. Only ticks while unpaused AND inside the daily
 * window, so a paused night costs nothing. Deadline is recomputed as
 * "now + remaining", never as a fixed wall deadline.
 */
export class BudgetClock {
  private totalMs: number;
  private accumulated = 0;
  private segmentStart: number | null = null;
  private forcedPaused = false;
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<(remainingMs: number, paused: boolean, windowOpen: boolean) => void>();

  constructor(totalMs: number, private window: DailyWindow | null) {
    this.totalMs = Math.max(60_000, totalMs);
  }

  start(): void {
    if (this.timer) return;
    this.segmentStart = Date.now();
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref?.();
  }

  stop(): void {
    this.closeSegment();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Manual pause (panic, supervision). */
  pause(): void {
    this.forcedPaused = true;
    this.closeSegment();
  }

  resume(): void {
    this.forcedPaused = false;
    this.openSegment();
  }

  get paused(): boolean {
    return this.forcedPaused || !this.windowOpen();
  }

  windowOpen(now: Date = new Date()): boolean {
    if (!this.window?.enabled) return true;
    const minutes = now.getHours() * 60 + now.getMinutes();
    const [sh, sm] = this.window.start.split(":").map(Number);
    const [eh, em] = this.window.end.split(":").map(Number);
    const start = (sh || 0) * 60 + (sm || 0);
    const end = (eh || 0) * 60 + (em || 0);
    return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  }

  remainingMs(): number {
    const live = this.segmentStart ? Date.now() - this.segmentStart : 0;
    return Math.max(0, this.totalMs - this.accumulated - live);
  }

  onTick(cb: (remainingMs: number, paused: boolean, windowOpen: boolean) => void): void {
    this.listeners.add(cb);
  }

  private openSegment(): void {
    if (this.segmentStart == null && !this.exhausted()) this.segmentStart = Date.now();
  }

  private closeSegment(): void {
    if (this.segmentStart != null) {
      this.accumulated += Date.now() - this.segmentStart;
      this.segmentStart = null;
    }
  }

  private exhausted(): boolean {
    return this.remainingMs() <= 0;
  }

  private tick(): void {
    // Night window handling: close the live segment while outside the window,
    // reopen it when the window opens. Budget only runs while open.
    if (!this.forcedPaused && this.windowOpen()) this.openSegment();
    else this.closeSegment();

    for (const cb of this.listeners) cb(this.remainingMs(), this.paused, this.windowOpen());
  }
}

/** "2d 4h 11m" — the shape agents are told in every turn header. */
export function formatRemaining(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
