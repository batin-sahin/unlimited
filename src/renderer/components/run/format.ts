/** Formatting helpers for the run console. Pure, no state. */

/** HH:MM:SS in local time, for feed rows and status lines. */
export function formatClock(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** "2d 3h 4m 5s" — every unit always present so the header never reflows. */
export function formatRemaining(ms: number): string {
  const safe = Math.max(0, Math.floor(ms));
  const d = Math.floor(safe / 86_400_000);
  const h = Math.floor((safe % 86_400_000) / 3_600_000);
  const m = Math.floor((safe % 3_600_000) / 60_000);
  const s = Math.floor((safe % 60_000) / 1000);
  return `${d}d ${h}h ${m}m ${s}s`;
}

/** 12400 → "12.4k", 128000 → "128k", 1_240_000 → "1.2M". */
export function formatTokens(n: number): string {
  const v = Math.max(0, n);
  if (v < 1000) return String(v);
  if (v < 1_000_000) {
    const k = v / 1000;
    const s = k >= 100 ? k.toFixed(0) : k.toFixed(1);
    return `${stripZeroDecimal(s)}k`;
  }
  const m = v / 1_000_000;
  return `${stripZeroDecimal(m.toFixed(1))}M`;
}

function stripZeroDecimal(s: string): string {
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/** First line of a multi-line output, hard-capped. */
export function firstLine(text: string, max = 120): string {
  const line = (text || "").split(/\r?\n/, 1)[0] ?? "";
  return truncate(line.trim(), max);
}

/** Single-line excerpt with an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  const t = text || "";
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

/** Short, stable display form of an id (uuid or otherwise). */
export function shortId(id: string): string {
  return (id || "").slice(0, 8);
}

/** "just now" / "5m ago" / "2h ago" / "3d ago" for last-activity stamps. */
export function formatAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** IPC and storage errors arrive as unknown; render them as one line. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}
