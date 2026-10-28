import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { StringDecoder } from "node:string_decoder";
import { unlimitedHome } from "../profiles.js";

/**
 * Cold store for evicted context: every append is one JSONL record per line in
 * <baseDir>/cold-<agentId>.jsonl (file 0600, dir 0700) — cheap, synchronous,
 * crash-safe. JSONL is the source of truth; search runs on node:sqlite FTS5
 * when this runtime has it (derived index, rebuilt from JSONL on mismatch),
 * otherwise on a bounded linear scan of the JSONL files.
 */

/** One search result out of the cold store. */
export interface RecallHit {
  ref: string;
  agentId: string;
  kind: string;
  at: number;
  snippet: string;
}

/** Constructor options: baseDir is a test hook; backend forces a search backend ("auto" = probe verdict). */
export interface RecallOptions {
  baseDir?: string;
  backend?: "auto" | "sqlite" | "jsonl";
}

type SearchBackend = "sqlite" | "jsonl";

// ---- node:sqlite probe ------------------------------------------------
//
// VERDICT, verified on this machine (macOS, 2026-10):
//  - Electron 38.8.6 bundles Node 22.22.0: `require("node:sqlite")` works
//    WITHOUT a flag and FTS5 passes a functional in-memory probe (it emits an
//    ExperimentalWarning — cosmetic only). So the packaged app uses the
//    sqlite/FTS5 backend.
//  - System Node 26.11.1: probe passes too (this is what `npm test` runs).
//  - Older runtimes (Node < 22.5, or builds without FTS5): require throws →
//    probe returns null → the JSONL scan fallback is used. Both backends are
//    real code paths and are exercised by the test suite.
// ASSUMPTIONS, honestly stated:
//  - FTS5's unicode61 tokenizer matches whole tokens, while the fallback
//    matches raw substrings (plain includes()). Queries built of whole words
//    behave identically on both; a substring of a token (e.g. "comp" inside
//    "compaction") matches on the fallback but not on FTS5. Every FTS5
//    candidate is additionally re-checked in JS so AND semantics and
//    punctuation-only terms behave exactly like the fallback for whatever
//    FTS5 returns as candidates.
//  - node:sqlite is experimental in Node 22.x; if it ever throws at runtime,
//    the Recall instance permanently degrades to the JSONL scan.

type SqliteModule = typeof import("node:sqlite");

const SQLITE: SqliteModule | null = probeSqlite();

/** True when node:sqlite (DatabaseSync + FTS5) passed the guarded load-time probe in this runtime. */
export const sqliteBackendAvailable: boolean = SQLITE !== null;

function probeSqlite(): SqliteModule | null {
  try {
    const mod = loadSqlite();
    if (!mod) return null;
    const db = new mod.DatabaseSync(":memory:");
    try {
      db.exec("CREATE VIRTUAL TABLE probe_fts USING fts5(x)");
      db.prepare("INSERT INTO probe_fts (x) VALUES (?)").run("probe");
      const row = db.prepare("SELECT x FROM probe_fts WHERE probe_fts MATCH ?").get("probe");
      return row != null ? mod : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function loadSqlite(): SqliteModule | null {
  // Bundled CJS (esbuild) has CommonJS require; plain ESM (node --test) does not.
  try {
    if (typeof require === "function") return require("node:sqlite") as SqliteModule;
  } catch {
    /* fall through to the ESM path */
  }
  try {
    return createRequire(import.meta.url)("node:sqlite") as SqliteModule;
  } catch {
    return null;
  }
}

// ---- limits -----------------------------------------------------------

const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;
const MAX_TERM_CHARS = 2048; // window overlap guarantee holds up to this term length
const OVERSIZED_LINE_CHARS = 200_000; // lines longer than this are scanned in windows, never buffered whole
const SCAN_WINDOW_CHARS = 65_536;
const SCAN_WINDOW_OVERLAP = 2_048; // terms up to this length never straddle a window boundary
const LINE_PREFIX_KEEP = 512; // kept from oversized lines to recover "at"/"kind"
const REBUILD_LINE_CHARS = 16 * 1024 * 1024; // safety cap when ingesting a single record into FTS
const READ_CHUNK_BYTES = 1 << 20;
const SNIPPET_WIDTH = 240;
const SNIPPET_CONTEXT = 72;
const PER_FILE_HITS_SOFT = 4000; // bounded memory on pathological all-matching files
const PER_FILE_HITS_KEEP = 2000;

type ColdHit = RecallHit & { line: number };

/** Searchable cold store: per-agent JSONL appends plus a best-available search backend. */
export class Recall {
  private readonly baseDir: string;
  private readonly forceBackend: "auto" | "sqlite" | "jsonl";
  private backend: SearchBackend = "jsonl";
  private db: InstanceType<SqliteModule["DatabaseSync"]> | null = null;
  private dbTried = false;
  private closed = false;
  private readonly fds = new Map<string, number>();
  private readonly nextLine = new Map<string, number>();

  constructor(runId: string, options: RecallOptions = {}) {
    // baseDir override exists so tests can point at a tmp dir instead of the
    // real profile home; it is the only concession to testability here.
    this.baseDir = options.baseDir ?? path.join(unlimitedHome(), "runs", sanitizeToken(runId));
    this.forceBackend = options.backend ?? "auto";
  }

  /** Append one record; one synchronous JSONL line per call, then (best effort) into the FTS index. */
  append(agentId: string, kind: string, text: string, at?: number): void {
    this.ensureOpen();
    this.ensureBackend();
    const id = sanitizeToken(agentId);
    const record = { at: finiteNumberOrNow(at), kind: coerceText(kind), text: coerceText(text) };
    const fd = this.fdFor(id); // first: opens the file and pads a torn last line if any
    const lineNo = this.claimLine(id); // then: count lines so the ref number is exact
    fs.writeSync(fd, `${JSON.stringify(record)}\n`);
    if (this.backend === "sqlite" && this.db) {
      try {
        this.insertIntoIndex(record.text, id, lineNo, record.at, record.kind);
      } catch {
        // The JSONL line is already durable; drop the index (it rebuilds from
        // JSONL on the next open) rather than losing the record.
        this.degrade();
      }
    }
  }

  /** Search all cold files; ALL query terms must appear (AND). Hits are newest-first. Default 5, max 20 results. */
  search(query: string, limit?: number): RecallHit[] {
    this.ensureOpen();
    this.ensureBackend();
    const parsed = Number(limit ?? DEFAULT_SEARCH_LIMIT);
    const max = Math.min(
      Math.max(1, Number.isFinite(parsed) ? Math.trunc(parsed) : DEFAULT_SEARCH_LIMIT),
      MAX_SEARCH_LIMIT,
    );
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    if (this.backend === "sqlite" && this.db) {
      const hits = this.searchSqlite(terms, max);
      if (hits !== null) return hits;
    }
    return this.searchJsonl(terms, max);
  }

  /** Close file handles and (if any) the sqlite index; the instance is final afterwards. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const fd of this.fds.values()) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore double-close */
      }
    }
    this.fds.clear();
    try {
      this.db?.close();
    } catch {
      /* ignore double-close */
    }
    this.db = null;
  }

  // ---- internals ----

  private ensureOpen(): void {
    if (this.closed) throw new Error("Recall: instance is closed");
  }

  /** Resolve the search backend once: forced jsonl, forced sqlite (must exist), or probe verdict. */
  private ensureBackend(): void {
    if (this.dbTried) return;
    this.dbTried = true;
    if (this.forceBackend === "jsonl") {
      this.backend = "jsonl";
      return;
    }
    if (this.forceBackend === "sqlite" && !sqliteBackendAvailable) {
      throw new Error("Recall: node:sqlite (FTS5) is not available in this runtime");
    }
    this.backend = sqliteBackendAvailable && this.openSqlite() ? "sqlite" : "jsonl";
  }

  private openSqlite(): boolean {
    if (!SQLITE) return false;
    try {
      fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
      const dbFile = path.join(this.baseDir, "cold-index.db");
      fs.closeSync(fs.openSync(dbFile, "a", 0o600)); // pre-create 0600; sqlite would otherwise use the umask
      const db = new SQLITE.DatabaseSync(dbFile);
      db.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS cold_fts USING fts5(text, agent UNINDEXED, line UNINDEXED, at UNINDEXED, kind UNINDEXED)",
      );
      db.exec("CREATE TABLE IF NOT EXISTS cold_meta (agent TEXT PRIMARY KEY, lines INTEGER NOT NULL)");
      this.db = db;
      this.reconcileIndex();
      return true;
    } catch {
      try {
        this.db?.close();
      } catch {
        /* ignore */
      }
      this.db = null;
      return false;
    }
  }

  /** JSONL is the source of truth: rebuild index rows for any agent whose line count drifted. */
  private reconcileIndex(): void {
    const db = this.db;
    if (!db) return;
    const present = new Set(listColdFiles(this.baseDir));
    const known = db.prepare("SELECT agent FROM cold_meta").all() as Array<{ agent: unknown }>;
    const purge = db.prepare("DELETE FROM cold_fts WHERE agent = ?");
    const purgeMeta = db.prepare("DELETE FROM cold_meta WHERE agent = ?");
    for (const row of known) {
      const id = coerceText(row.agent);
      if (id.length > 0 && !present.has(id)) {
        purge.run(id);
        purgeMeta.run(id);
      }
    }
    for (const id of present) {
      const file = this.fileFor(id);
      const count = countLines(file);
      const prev = db.prepare("SELECT lines FROM cold_meta WHERE agent = ?").get(id) as { lines: unknown } | undefined;
      if (prev !== undefined && Number(prev.lines) === count) continue;
      purge.run(id);
      rebuildIndex(db, file, id);
      db.prepare(
        "INSERT INTO cold_meta (agent, lines) VALUES (?, ?) ON CONFLICT(agent) DO UPDATE SET lines = excluded.lines",
      ).run(id, count);
    }
  }

  private insertIntoIndex(text: string, agentId: string, line: number, at: number, kind: string): void {
    this.db
      ?.prepare("INSERT INTO cold_fts (text, agent, line, at, kind) VALUES (?, ?, ?, ?, ?)")
      .run(text, agentId, line, at, kind);
  }

  /** Permanently drop a broken sqlite index; the JSONL scan takes over for this instance. */
  private degrade(): void {
    try {
      this.db?.close();
    } catch {
      /* ignore */
    }
    this.db = null;
    this.backend = "jsonl";
  }

  private searchSqlite(terms: string[], limit: number): RecallHit[] | null {
    const db = this.db;
    if (!db) return null;
    try {
      // Quoted phrases joined by implicit AND; embedded quotes doubled.
      const match = terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" ");
      const rows = db
        .prepare(
          "SELECT agent, line, at, kind, text FROM cold_fts WHERE cold_fts MATCH ? ORDER BY at DESC, line DESC LIMIT ?",
        )
        // Generous candidate pool: FTS5 is only a pre-filter — the JS-side AND
        // re-check rejects candidates whose tokenizer split a term, and a thin
        // pool would silently under-deliver below the requested limit.
        .all(match, Math.max(limit * 3, 60)) as Array<{ agent: unknown; line: unknown; at: unknown; kind: unknown; text: unknown }>;
      const hits: RecallHit[] = [];
      for (const row of rows) {
        const text = coerceText(row.text);
        const lower = text.toLowerCase();
        // Exact AND parity with the fallback: every raw query term must be a
        // substring of the record text; FTS5 is only a fast pre-filter.
        if (!terms.every((t) => lower.includes(t))) continue;
        const agentId = coerceText(row.agent);
        hits.push({
          ref: `cold/${agentId}.jsonl#L${Number(row.line) || 0}`,
          agentId,
          kind: coerceText(row.kind),
          at: Number(row.at) || 0,
          snippet: extractSnippet(text, terms),
        });
        if (hits.length >= limit) break;
      }
      return hits;
    } catch {
      this.degrade();
      return null;
    }
  }

  private searchJsonl(terms: string[], limit: number): RecallHit[] {
    const hits: ColdHit[] = [];
    for (const id of listColdFiles(this.baseDir)) {
      hits.push(...scanJsonlFile(this.fileFor(id), id, terms));
    }
    hits.sort((a, b) => b.at - a.at || b.line - a.line);
    return hits.slice(0, limit).map(({ line: _line, ...hit }) => hit);
  }

  private fileFor(agentId: string): string {
    return path.join(this.baseDir, `cold-${agentId}.jsonl`);
  }

  private fdFor(agentId: string): number {
    const existing = this.fds.get(agentId);
    if (existing !== undefined) return existing;
    fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    const file = this.fileFor(agentId);
    const fd = fs.openSync(file, "a", 0o600);
    // A crash may have left a torn final line without "\n"; start this record
    // on a fresh line so one-record-per-line and the ref numbering hold.
    try {
      const size = fs.fstatSync(fd).size;
      if (size > 0) {
        const one = Buffer.alloc(1);
        const got = fs.readSync(fd, one, 0, 1, size - 1);
        if (got === 1 && one[0] !== 0x0a) fs.writeSync(fd, "\n");
      }
    } catch {
      /* best effort */
    }
    this.fds.set(agentId, fd);
    return fd;
  }

  /** Next 1-based line number for this agent's file (counts existing lines once). */
  private claimLine(agentId: string): number {
    let next = this.nextLine.get(agentId);
    if (next === undefined) next = countLines(this.fileFor(agentId)) + 1;
    this.nextLine.set(agentId, next + 1);
    return next;
  }
}

// ---- JSONL fallback scan (bounded memory, no regex) --------------------

function scanJsonlFile(file: string, agentId: string, terms: string[]): ColdHit[] {
  const hits: ColdHit[] = [];
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return hits;
  }
  try {
    const decoder = new StringDecoder("utf8");
    let lineNo = 0;
    let lineOpen = false;
    let carry = ""; // current line accumulation in normal mode
    let prefix = ""; // first LINE_PREFIX_KEEP chars of the current line (raw)
    let oversized = false; // current line exceeded OVERSIZED_LINE_CHARS → window mode
    let tail = ""; // window-mode rolling remainder
    let matched = new Set<string>(); // oversized AND accumulator across windows
    let firstMatch: string | null = null; // first oversized window containing any term (raw)

    const startLine = (): void => {
      lineNo += 1;
      lineOpen = true;
      carry = "";
      prefix = "";
      oversized = false;
      tail = "";
      matched = new Set();
      firstMatch = null;
    };

    const pushOversizedHit = (): void => {
      if (matched.size !== terms.length) return;
      const meta = parseRecordPrefix(prefix);
      hits.push({
        ref: `cold/${agentId}.jsonl#L${lineNo}`,
        agentId,
        kind: meta.kind,
        at: meta.at,
        // Degraded but honest: the snippet may show raw JSON scaffolding for
        // pathological lines that were never buffered whole.
        snippet: extractSnippet(firstMatch ?? "", terms),
        line: lineNo,
      });
    };

    const finishLine = (): void => {
      if (!lineOpen) return;
      if (oversized) {
        checkWindow(tail);
        pushOversizedHit();
      } else {
        emitNormal(carry.replace(/\r$/, ""));
      }
      lineOpen = false;
    };

    const checkWindow = (window: string): void => {
      if (window.length === 0) return;
      const lower = window.toLowerCase();
      let any = false;
      for (const term of terms) {
        if (!matched.has(term) && lower.includes(term)) {
          matched.add(term);
          any = true;
        }
      }
      if (any && firstMatch === null) firstMatch = window;
    };

    // Consume full windows from s; returns the unchecked remainder (< one window).
    const drainWindows = (s: string): string => {
      let pos = 0;
      while (s.length - pos >= SCAN_WINDOW_CHARS) {
        checkWindow(s.slice(pos, pos + SCAN_WINDOW_CHARS));
        pos += SCAN_WINDOW_CHARS - SCAN_WINDOW_OVERLAP;
      }
      return s.slice(pos);
    };

    const emitNormal = (raw: string): void => {
      const rec = parseRecord(raw);
      if (!rec) return; // torn or foreign line: not searchable
      const lower = rec.text.toLowerCase();
      if (!terms.every((t) => lower.includes(t))) return;
      hits.push({
        ref: `cold/${agentId}.jsonl#L${lineNo}`,
        agentId,
        kind: rec.kind,
        at: rec.at,
        snippet: extractSnippet(rec.text, terms),
        line: lineNo,
      });
    };

    const buf = Buffer.alloc(READ_CHUNK_BYTES);
    for (;;) {
      const got = fs.readSync(fd, buf, 0, buf.length, null);
      if (got <= 0) break;
      let chunk = decoder.write(buf.subarray(0, got));
      while (chunk.length > 0) {
        if (!lineOpen) startLine();
        if (!oversized) {
          const nl = chunk.indexOf("\n");
          if (nl < 0) {
            carry += chunk;
            if (prefix.length < LINE_PREFIX_KEEP) prefix = carry.slice(0, LINE_PREFIX_KEEP);
            if (carry.length > OVERSIZED_LINE_CHARS) {
              // Never buffer the whole pathological line: switch to windows.
              oversized = true;
              tail = drainWindows(carry);
              carry = "";
            }
            chunk = "";
          } else {
            const complete = carry + chunk.slice(0, nl);
            chunk = chunk.slice(nl + 1);
            lineOpen = false;
            emitNormal(complete.replace(/\r$/, ""));
          }
        } else {
          tail += chunk;
          chunk = "";
          if (prefix.length < LINE_PREFIX_KEEP) prefix = tail.slice(0, LINE_PREFIX_KEEP);
          tail = drainWindows(tail);
          const nl = tail.indexOf("\n");
          if (nl >= 0) {
            const finalSegment = tail.slice(0, nl);
            const rest = tail.slice(nl + 1); // remainder starts the next line
            tail = "";
            checkWindow(finalSegment);
            pushOversizedHit();
            lineOpen = false;
            chunk = rest;
          }
        }
      }
      if (hits.length > PER_FILE_HITS_SOFT) {
        // Bounded memory on pathological files: keep only the newest chunk.
        hits.sort((a, b) => b.at - a.at || b.line - a.line);
        hits.length = PER_FILE_HITS_KEEP;
      }
    }
    finishLine(); // EOF: a torn final line counts as complete for scanning
    return hits;
  } catch {
    return hits;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

/** Feed every full line (up to a 16MiB per-line safety cap) into the FTS index. */
function rebuildIndex(db: InstanceType<SqliteModule["DatabaseSync"]>, file: string, agentId: string): void {
  const insert = db.prepare("INSERT INTO cold_fts (text, agent, line, at, kind) VALUES (?, ?, ?, ?, ?)");
  let lineNo = 0;
  eachFullLine(file, (raw) => {
    lineNo += 1;
    const rec = parseRecord(raw);
    if (rec) insert.run(rec.text, agentId, lineNo, rec.at, rec.kind);
  });
}

function eachFullLine(file: string, onLine: (line: string) => void): void {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return;
  }
  try {
    const decoder = new StringDecoder("utf8");
    let carry = "";
    let truncated = false;
    const buf = Buffer.alloc(READ_CHUNK_BYTES);
    for (;;) {
      const got = fs.readSync(fd, buf, 0, buf.length, null);
      if (got <= 0) break;
      const chunk = decoder.write(buf.subarray(0, got));
      for (let start = 0; start < chunk.length; ) {
        const nl = chunk.indexOf("\n", start);
        if (nl < 0) {
          if (!truncated) carry += chunk.slice(start);
          if (carry.length > REBUILD_LINE_CHARS) {
            // Safety cap for pathological records: the index keeps the
            // searchable prefix; the JSONL file itself keeps everything.
            truncated = true;
            carry = carry.slice(0, REBUILD_LINE_CHARS);
          }
          start = chunk.length;
        } else {
          if (!truncated) onLine((carry + chunk.slice(start, nl)).replace(/\r$/, ""));
          carry = "";
          truncated = false;
          start = nl + 1;
        }
      }
    }
    if (carry.length > 0 && !truncated) onLine(carry.replace(/\r$/, ""));
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

// ---- parsing / snippet helpers -----------------------------------------

function parseRecord(line: string): { at: number; kind: string; text: string } | null {
  try {
    const v: unknown = JSON.parse(line);
    if (typeof v !== "object" || v === null) return null;
    const o = v as Record<string, unknown>;
    if (typeof o.text !== "string") return null;
    return {
      at: typeof o.at === "number" && Number.isFinite(o.at) ? o.at : 0,
      kind: typeof o.kind === "string" ? o.kind : "",
      text: o.text,
    };
  } catch {
    return null;
  }
}

/** Best-effort "at"/"kind" recovery from the first bytes of a line we never buffered whole. */
function parseRecordPrefix(prefix: string): { at: number; kind: string } {
  let at = 0;
  let kind = "";
  try {
    const i = prefix.indexOf('"at":');
    if (i >= 0) {
      const rest = prefix.slice(i + 5);
      const end = rest.search(/[^0-9-]/);
      at = Number(end < 0 ? rest : rest.slice(0, end)) || 0;
    }
    const k = prefix.indexOf('"kind":"');
    if (k >= 0) {
      const rest = prefix.slice(k + 8);
      for (let j = 0; j < rest.length; j += 1) {
        const c = rest[j];
        if (c === '"') break;
        if (c === "\\") {
          j += 1;
          kind += rest[j] ?? "";
        } else {
          kind += c;
        }
      }
    }
  } catch {
    /* keep defaults */
  }
  return { at, kind: kind.length > 0 ? kind : "unknown" };
}

/**
 * ~240-char single-line region around the earliest occurrence of any query
 * term, with "…" ellipses where text was cut. Never throws, never exceeds
 * SNIPPET_WIDTH + 2 chars.
 */
function extractSnippet(text: string, terms: string[], width = SNIPPET_WIDTH, context = SNIPPET_CONTEXT): string {
  if (text.length === 0) return "";
  const lower = text.toLowerCase();
  let pos = -1;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
  }
  if (pos < 0) pos = 0; // hit came from a window scan; show the head of the text
  const lineStart = (() => {
    const i = lower.lastIndexOf("\n", pos);
    return i < 0 ? 0 : i + 1;
  })();
  const lineEnd = (() => {
    const i = lower.indexOf("\n", pos);
    return i < 0 ? lower.length : i;
  })();
  let start = Math.max(lineStart, pos - context);
  const end = Math.min(lineEnd, start + width);
  if (end - start < Math.min(width, lineEnd - lineStart)) start = Math.max(lineStart, end - width);
  const head = start > lineStart || lineStart > 0 ? "…" : "";
  const tail = end < lineEnd || lineEnd < lower.length ? "…" : "";
  return `${head}${text.slice(start, end)}${tail}`;
}

function tokenize(query: string): string[] {
  return coerceText(query)
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.slice(0, MAX_TERM_CHARS))
    .filter((t) => t.length > 0);
}

function listColdFiles(baseDir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(baseDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    const m = /^cold-([A-Za-z0-9._-]+)\.jsonl$/.exec(name);
    if (m) out.push(m[1]);
  }
  return out.sort();
}

function countLines(file: string): number {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return 0;
  }
  try {
    const size = fs.fstatSync(fd).size;
    let count = 0;
    let pos = 0;
    const buf = Buffer.alloc(READ_CHUNK_BYTES);
    while (pos < size) {
      const got = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
      if (got <= 0) break;
      const view = buf.subarray(0, got);
      for (let i = view.indexOf(0x0a); i >= 0; i = view.indexOf(0x0a, i + 1)) count += 1;
      pos += got;
    }
    return count;
  } catch {
    return 0;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

function coerceText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw === null || raw === undefined) return "";
  try {
    return String(raw);
  } catch {
    return "";
  }
}

function sanitizeToken(raw: string): string {
  const cleaned = coerceText(raw).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  return cleaned.length > 0 ? cleaned : "unknown";
}

function finiteNumberOrNow(at: unknown): number {
  return typeof at === "number" && Number.isFinite(at) ? at : Date.now();
}
