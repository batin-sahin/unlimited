import fs from "node:fs";
import path from "node:path";
import { unlimitedHome } from "../profiles.js";

/**
 * The agent's structured self-state — the only thing guaranteed to survive
 * compaction. Storage is lossless; only render() caps what is re-injected
 * into context, because compaction never silently loses information.
 */

/** Per-agent self-state persisted as JSON; everything is coerced on save/load, never trusted. */
export interface LedgerState {
  doing: string;
  done: string[];
  decisions: { what: string; why: string }[];
  files: { path: string; note: string }[];
  gotchas: string[];
  updatedAt: number;
}

/** Persistent per-agent ledger at <baseDir>/ledger-<agentId>.json (file 0600, dir 0700). */
export class Ledger {
  private readonly dir: string;
  private readonly file: string;

  constructor(runId: string, agentId: string, baseDir?: string) {
    // baseDir override exists so tests can point at a tmp dir instead of the
    // real profile home; it is the only concession to testability here.
    this.dir = baseDir ?? path.join(unlimitedHome(), "runs", sanitizeToken(runId));
    this.file = path.join(this.dir, `ledger-${sanitizeToken(agentId)}.json`);
  }

  /** Read the ledger; a missing or corrupt file yields a fresh empty state (updatedAt 0). */
  load(): LedgerState {
    try {
      return normalizeState(JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch {
      return freshState();
    }
  }

  /** Coerce the incoming state defensively (models emit garbage sometimes) and persist it; fs errors propagate. */
  save(state: LedgerState): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, JSON.stringify(normalizeState(state)), { mode: 0o600 });
  }

  /** Compact markdown-ish block the summarizer re-injects into context every turn; section-capped and ~1200 tokens max. */
  render(state?: LedgerState): string {
    const s = state ?? this.load();
    const limits: Record<SectionKey, number> = {
      done: DONE_LIMIT,
      decisions: DECISIONS_LIMIT,
      files: FILES_LIMIT,
      gotchas: GOTCHAS_LIMIT,
    };
    let out = renderWithLimits(s, limits);
    while (estimateTokens(out.text) > TOKEN_BUDGET) {
      // Over the token budget: drop one more oldest entry from the section
      // holding the most, and re-render. Sections that lost entries get an
      // "(older trimmed)" marker so the agent knows disk has the rest.
      let biggest: SectionKey | null = null;
      for (const key of SECTION_KEYS) {
        if (out.kept[key] > 0 && (biggest === null || out.kept[key] > out.kept[biggest])) biggest = key;
      }
      if (biggest === null) {
        // Nothing left to drop and still over budget: the DOING text itself is
        // huge — hard-truncate it (the full text lives in the agent's own writes).
        return renderWithLimits(s, limits, TOKEN_BUDGET * CHARS_PER_TOKEN - 256).text;
      }
      limits[biggest] -= 1;
      out = renderWithLimits(s, limits);
    }
    return out.text;
  }
}

// ---- internals (not exported) ----

const DONE_LIMIT = 12;
const DECISIONS_LIMIT = 10;
const FILES_LIMIT = 12;
const GOTCHAS_LIMIT = 8;
const TOKEN_BUDGET = 1200; // ~1200 tokens for the whole rendered block
const CHARS_PER_TOKEN = 4; // rough estimate; honest, not exact

type SectionKey = "done" | "decisions" | "files" | "gotchas";
const SECTION_KEYS: SectionKey[] = ["done", "decisions", "files", "gotchas"];

function freshState(): LedgerState {
  return { doing: "", done: [], decisions: [], files: [], gotchas: [], updatedAt: 0 };
}

/** Never trust model-shaped input: coerce every field to the contract shape or drop it. */
function normalizeState(raw: unknown): LedgerState {
  const r = isObject(raw) ? raw : {};
  const done = arrayOf(r.done).map(coerceText).filter((s) => s.length > 0);
  const gotchas = arrayOf(r.gotchas).map(coerceText).filter((s) => s.length > 0);
  const decisions = arrayOf(r.decisions)
    .map((d) => (isObject(d) ? { what: coerceText(d.what), why: coerceText(d.why) } : null))
    .filter((d): d is { what: string; why: string } => d !== null && (d.what.length > 0 || d.why.length > 0));
  const files = arrayOf(r.files)
    .map((f) => (isObject(f) ? { path: coerceText(f.path), note: coerceText(f.note) } : null))
    .filter((f): f is { path: string; note: string } => f !== null && f.path.length > 0);
  const updatedAt = typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt) ? r.updatedAt : 0;
  return { doing: coerceText(r.doing), done, decisions, files, gotchas, updatedAt };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function arrayOf(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** String-coerce anything a caller (or a model) might pass; never throw. */
function coerceText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw === null || raw === undefined) return "";
  try {
    return String(raw);
  } catch {
    return "";
  }
}

/** Filesystem-safe single path token for runId/agentId (no traversal, no separators). */
function sanitizeToken(raw: string): string {
  const cleaned = coerceText(raw).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  return cleaned.length > 0 ? cleaned : "unknown";
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

interface Rendered {
  text: string;
  kept: Record<SectionKey, number>;
}

function renderWithLimits(s: LedgerState, limits: Record<SectionKey, number>, clampDoingChars?: number): Rendered {
  const kept: Record<SectionKey, number> = { done: 0, decisions: 0, files: 0, gotchas: 0 };
  const out: string[] = ["## Ledger (state that must survive)"];

  // DOING
  const doing = clampDoingChars !== undefined && s.doing.length > clampDoingChars
    ? `${s.doing.slice(0, clampDoingChars)}…(trimmed)`
    : s.doing;
  if (doing.trim().length > 0) out.push("", `DOING: ${doing.trim()}`);

  // DONE — stored chronologically (push = newest last), rendered latest first.
  // Beware slice(-0) === slice(0): compute the start index explicitly.
  const doneStart = Math.max(0, s.done.length - limits.done);
  const doneShown = s.done.slice(doneStart).reverse();
  if (s.done.length > 0) {
    out.push("", "DONE (latest first):", ...doneShown.map((d) => `- ${d}`));
    if (doneShown.length < s.done.length) out.push("(older trimmed)");
  }
  kept.done = doneShown.length;

  // DECISIONS — chronological, keep the latest N.
  const decStart = Math.max(0, s.decisions.length - limits.decisions);
  const decShown = s.decisions.slice(decStart);
  if (s.decisions.length > 0) {
    out.push("", "DECISIONS:", ...decShown.map((d) => (d.why.length > 0 ? `- ${d.what} — ${d.why}` : `- ${d.what}`)));
    if (decShown.length < s.decisions.length) out.push("(older trimmed)");
  }
  kept.decisions = decShown.length;

  // FILES — chronological, keep the latest N.
  const fileStart = Math.max(0, s.files.length - limits.files);
  const fileShown = s.files.slice(fileStart);
  if (s.files.length > 0) {
    out.push("", "FILES:", ...fileShown.map((f) => (f.note.length > 0 ? `- ${f.path} — ${f.note}` : `- ${f.path}`)));
    if (fileShown.length < s.files.length) out.push("(older trimmed)");
  }
  kept.files = fileShown.length;

  // GOTCHAS — chronological, keep the latest N.
  const gotStart = Math.max(0, s.gotchas.length - limits.gotchas);
  const gotShown = s.gotchas.slice(gotStart);
  if (s.gotchas.length > 0) {
    out.push("", "GOTCHAS:", ...gotShown.map((g) => `- ${g}`));
    if (gotShown.length < s.gotchas.length) out.push("(older trimmed)");
  }
  kept.gotchas = gotShown.length;

  return { text: out.join("\n"), kept };
}
