/**
 * Crash-resume data layer (Faz 5): tolerant readers over the append-only run
 * journal (<runs>/<runId>.jsonl, one RunEvent per line — see journal.ts).
 * Reading a crashed run's journal must never explode on content garbage:
 * corrupt lines are counted and skipped, never fatal. Only genuine filesystem
 * problems (missing file, unreadable dir) surface as clear Errors.
 */
import fs from "node:fs";
import path from "node:path";
import type { RunEvent } from "../shared/types.js";
import { unlimitedHome } from "./profiles.js";

/** Result of a tolerant journal read: valid events in file order, plus corruption bookkeeping. */
export interface JournalRead {
  events: RunEvent[];
  corruptLines: number;
  totalLines: number;
}

/** Minimal structural guard for journaled events: an object with a string `type` and a finite numeric `at`. Field shapes are coerced downstream (resume/plan), not here — the guard stays deliberately loose. */
export function isRunEventLike(value: unknown): value is RunEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.type === "string" && typeof candidate.at === "number" && Number.isFinite(candidate.at);
}

function runsDir(baseDir?: string): string {
  return baseDir ?? path.join(unlimitedHome(), "runs");
}

/** Run ids are bare filename tokens; the charset check rejects separators and any traversal up front. */
function assertSafeRunId(runId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new Error(`invalid runId: ${JSON.stringify(runId)}`);
  }
}

/** Read one run's journal tolerantly: valid events in file order; JSON failures and non-conforming objects count as corruptLines and are skipped; blank lines are ignored entirely. Throws a clear Error only when the file itself cannot be read. */
export function readJournal(runId: string, baseDir?: string): JournalRead {
  assertSafeRunId(runId);
  const file = path.join(runsDir(baseDir), `${runId}.jsonl`);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
    throw new Error(`cannot read journal for run ${runId} at ${file}: ${code}`);
  }
  const events: RunEvent[] = [];
  let corruptLines = 0;
  let totalLines = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue; // trailing newline / blank padding: not data, not corruption
    totalLines += 1;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRunEventLike(parsed)) events.push(parsed);
      else corruptLines += 1;
    } catch {
      corruptLines += 1; // unparseable line — skip and count, never throw
    }
  }
  return { events, corruptLines, totalLines };
}

/** One flat journal file under the runs dir (per-run subdirs with their ledger and cold files are not journals). */
export interface RunFileEntry {
  runId: string;
  file: string;
  updatedAt: number;
  sizeBytes: number;
}

/** Scan the runs dir for flat *.jsonl journals, newest first; a missing dir yields [] (a fresh install, not an error). */
export function listRuns(baseDir?: string): RunFileEntry[] {
  const dir = runsDir(baseDir);
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const entries: RunFileEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith(".jsonl")) continue;
    // ledger/cold artifacts live in per-run subdirectories; also skip any
    // flat stragglers carrying those prefixes so they can never masquerade
    // as journals.
    if (dirent.name.startsWith("ledger-") || dirent.name.startsWith("cold-")) continue;
    const file = path.join(dir, dirent.name);
    try {
      const stat = fs.statSync(file);
      entries.push({
        runId: dirent.name.slice(0, -".jsonl".length),
        file,
        updatedAt: stat.mtimeMs,
        sizeBytes: stat.size,
      });
    } catch {
      // raced deletion — not listable
    }
  }
  return entries.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A journal worth resuming: it has a run-started identity and its last valid event is not run-ended (the run crashed or was interrupted). */
export interface ResumableRun {
  runId: string;
  file: string;
  updatedAt: number;
  sizeBytes: number;
  /** `at` of the last valid event — best-effort crash moment. */
  lastAt: number;
  /** profileId from the run's run-started event. */
  profileId: string;
}

/** listRuns filtered to interrupted runs, each annotated with lastAt and profileId, newest first. Runs without any valid event or without a run-started identity cannot be resumed and are excluded. */
export function resumableRuns(baseDir?: string): ResumableRun[] {
  const out: ResumableRun[] = [];
  for (const entry of listRuns(baseDir)) {
    let read: JournalRead;
    try {
      read = readJournal(entry.runId, baseDir);
    } catch {
      continue; // vanished between listing and reading — not resumable
    }
    if (read.events.length === 0) continue; // all-corrupt journal: nothing to resume from
    const last = read.events[read.events.length - 1];
    if (last.type === "run-ended") continue; // finished runs are history, not candidates
    let profileId = "";
    for (const event of read.events) {
      if (event.type === "run-started" && typeof event.profileId === "string") profileId = event.profileId;
    }
    if (!profileId) continue; // no identity — the resumed run would have nothing to load
    out.push({ ...entry, lastAt: typeof last.at === "number" ? last.at : 0, profileId });
  }
  return out;
}
