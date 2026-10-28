/**
 * Unit tests for the crash-resume data layer: journal-reader (tolerant JSONL
 * reads over a tmp dir) and resume/plan (pure reconstruction).
 * Run via node --test; the resolve shim below lets the codebase-mandated .js
 * specifiers resolve to their .ts sources under native type stripping.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { describe, test, type TestContext } from "node:test";
import type { RunEvent } from "../../shared/types.js";

// ---- runtime shim for `node --test` on TypeScript sources (same as recall.test.ts) ----
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".js") && context.parentURL?.endsWith(".ts")) {
      try {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      } catch {
        /* no .ts twin — use the original specifier */
      }
    }
    return nextResolve(specifier, context);
  },
});

const { isRunEventLike, listRuns, readJournal, resumableRuns } = await import("../journal-reader.js");
const { buildResumePlan } = await import("./plan.js");

type ResumePlan = NonNullable<ReturnType<typeof buildResumePlan>>;

function tmpDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unlimited-resume-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJournal(t: TestContext, runId: string, lines: string[]): { baseDir: string; file: string } {
  const baseDir = tmpDir(t);
  const file = path.join(baseDir, `${runId}.jsonl`);
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return { baseDir, file };
}

function jsonLines(events: unknown[]): string[] {
  return events.map((event) => JSON.stringify(event));
}

const STARTED = { type: "run-started", runId: "run-a", profileId: "prof-1", at: 1_000 };
const WORKER_STARTED = { type: "agent-started", agentId: "w1", role: "worker", label: "Worker", model: "m-1", at: 1_100 };
const BOSS_STARTED = { type: "agent-started", agentId: "s1", role: "supervisor", label: "Boss", model: "m-1", at: 1_150 };

// ---- journal-reader ---------------------------------------------------------

describe("isRunEventLike", () => {
  test("accepts a minimal conforming event (extra fields allowed)", () => {
    assert.equal(isRunEventLike({ type: "agent-text", at: 0 }), true);
    assert.equal(isRunEventLike({ type: "agent-text", at: 1.5, extra: "junk" }), true);
  });

  test("rejects non-objects and shape violations", () => {
    for (const bad of [null, undefined, "run-started", 42, [], {}, { type: 42, at: 1 }, { type: "x" }, { at: 1 }, { type: "x", at: "soon" }, { type: "x", at: Number.NaN }]) {
      assert.equal(isRunEventLike(bad), false, JSON.stringify(bad));
    }
  });
});

describe("readJournal", () => {
  test("keeps valid events in order and counts corrupt lines and non-blank total", (t) => {
    const { baseDir } = writeJournal(t, "run-mixed", [
      jsonLines([STARTED, WORKER_STARTED])[0],
      "this is not json {",
      JSON.stringify({ type: 42, at: 5 }), // type not a string → corrupt
      jsonLines([{ type: "agent-text", agentId: "w1", text: "hello", at: 1_200 }])[0],
      JSON.stringify({ type: "agent-status", at: "soon" }), // at not numeric → corrupt
      "", // blank padding: ignored entirely
    ]);
    const read = readJournal("run-mixed", baseDir);
    assert.equal(read.events.length, 2);
    assert.deepEqual(read.events.map((e) => e.type), ["run-started", "agent-text"]);
    assert.equal(read.corruptLines, 3);
    assert.equal(read.totalLines, 5);
  });

  test("event order matches file order", (t) => {
    const { baseDir } = writeJournal(t, "run-order", jsonLines([
      STARTED,
      { type: "agent-text", agentId: "w1", text: "one", at: 2 },
      { type: "agent-text", agentId: "w1", text: "two", at: 3 },
    ]));
    const read = readJournal("run-order", baseDir);
    assert.deepEqual(
      read.events.filter((e) => e.type === "agent-text").map((e) => (e as { text?: string }).text),
      ["one", "two"],
    );
  });

  test("empty and blank-only journals read clean", (t) => {
    const { baseDir } = writeJournal(t, "run-empty", []);
    assert.deepEqual(readJournal("run-empty", baseDir), { events: [], corruptLines: 0, totalLines: 0 });
    const blankDir = tmpDir(t);
    fs.writeFileSync(path.join(blankDir, "run-blank.jsonl"), "\n\n   \n");
    assert.deepEqual(readJournal("run-blank", blankDir), { events: [], corruptLines: 0, totalLines: 0 });
  });

  test("missing journal throws a clear Error naming the run and path", (t) => {
    const baseDir = tmpDir(t);
    assert.throws(() => readJournal("run-ghost", baseDir), (err: Error) => {
      return err.message.includes("run-ghost") && err.message.includes("run-ghost.jsonl");
    });
  });

  test("runId with separators is rejected up front (no path traversal)", (t) => {
    const baseDir = tmpDir(t);
    assert.throws(() => readJournal("../evil", baseDir), /invalid runId/);
    assert.throws(() => readJournal("a/b", baseDir), /invalid runId/);
  });
});

describe("listRuns", () => {
  test("lists only flat *.jsonl files, newest first, ignoring subdirs and ledger/cold stragglers", (t) => {
    const baseDir = tmpDir(t);
    const old = path.join(baseDir, "run-old.jsonl");
    const young = path.join(baseDir, "run-young.jsonl");
    fs.writeFileSync(old, "x");
    fs.writeFileSync(young, "yy");
    fs.utimesSync(old, new Date(1_000_000), new Date(1_000_000)); // older mtime
    fs.utimesSync(young, new Date(2_000_000), new Date(2_000_000));
    // per-run subdir artifacts must not appear…
    fs.mkdirSync(path.join(baseDir, "run-old"));
    fs.writeFileSync(path.join(baseDir, "run-old", "ledger-w1.json"), "{}");
    fs.writeFileSync(path.join(baseDir, "run-old", "cold-worker.jsonl"), "record\n");
    // …nor flat stragglers with artifact prefixes, nor non-journal files
    fs.writeFileSync(path.join(baseDir, "ledger-stray.jsonl"), "x");
    fs.writeFileSync(path.join(baseDir, "cold-stray.jsonl"), "x");
    fs.writeFileSync(path.join(baseDir, "notes.txt"), "x");

    const runs = listRuns(baseDir);
    assert.deepEqual(runs.map((r) => r.runId), ["run-young", "run-old"]); // newest first
    assert.equal(runs[0].sizeBytes, 2);
    assert.equal(runs[0].file, young);
    assert.equal(runs[0].updatedAt, 2_000_000);
  });

  test("a missing runs dir yields [] instead of throwing", (t) => {
    const baseDir = path.join(tmpDir(t), "does-not-exist");
    assert.deepEqual(listRuns(baseDir), []);
  });
});

describe("resumableRuns", () => {
  test("keeps unterminated runs with identity, ignores ended/garbage/anonymous ones", (t) => {
    const baseDir = tmpDir(t);
    fs.writeFileSync(path.join(baseDir, "run-crashed.jsonl"), `${jsonLines([
      STARTED,
      WORKER_STARTED,
      { type: "agent-status", agentId: "w1", status: "running", note: "mid-edit", at: 5_000 },
    ]).join("\n")}\n`);
    fs.writeFileSync(path.join(baseDir, "run-ended.jsonl"), `${jsonLines([
      STARTED,
      { type: "run-ended", runId: "run-a", reason: "done", summary: "ok", at: 9_000 },
    ]).join("\n")}\n`);
    fs.writeFileSync(path.join(baseDir, "run-garbage.jsonl"), "garbage\n{\n");
    fs.writeFileSync(path.join(baseDir, "run-anon.jsonl"), `${jsonLines([
      { type: "agent-text", agentId: "w1", text: "no run-started here", at: 10 },
    ]).join("\n")}\n`);

    const runs = resumableRuns(baseDir);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].runId, "run-crashed");
    assert.equal(runs[0].profileId, "prof-1");
    assert.equal(runs[0].lastAt, 5_000);
    assert.ok(runs[0].sizeBytes > 0);
    assert.ok(runs[0].file.endsWith("run-crashed.jsonl"));
  });

  test("orders resumable candidates newest first", (t) => {
    const baseDir = tmpDir(t);
    const a = path.join(baseDir, "run-a.jsonl");
    const b = path.join(baseDir, "run-b.jsonl");
    fs.writeFileSync(a, `${JSON.stringify(STARTED)}\n`);
    fs.writeFileSync(b, `${JSON.stringify({ ...STARTED, runId: "run-b", at: 2 })}\n`);
    fs.utimesSync(a, new Date(1_000_000), new Date(1_000_000));
    fs.utimesSync(b, new Date(2_000_000), new Date(2_000_000));
    assert.deepEqual(resumableRuns(baseDir).map((r) => r.runId), ["run-b", "run-a"]);
  });
});

// ---- resume/plan ------------------------------------------------------------

function agentStarted(agentId: string, role: string, at: number): unknown {
  return { type: "agent-started", agentId, role, label: `${role}-${agentId}`, model: "m-1", at };
}

describe("buildResumePlan", () => {
  test("null for empty input and for input without run-started", () => {
    assert.equal(buildResumePlan([]), null);
    assert.equal(
      buildResumePlan([{ type: "agent-text", agentId: "w1", text: "orphan", at: 1 } as RunEvent]),
      null,
    );
  });

  test("full crashed run: budget from LAST tick, statuses, counts, coldMoved sum", () => {
    const events = [
      STARTED,
      WORKER_STARTED,
      BOSS_STARTED,
      { type: "budget-tick", runId: "run-a", remainingMs: 500_000, windowOpen: true, paused: false, at: 2_000 },
      { type: "budget-tick", runId: "run-a", remainingMs: 300_000, windowOpen: false, paused: true, at: 3_000 },
      { type: "agent-text", agentId: "w1", text: "first words", at: 2_100 },
      { type: "agent-text", agentId: "w1", text: "second words", at: 2_200 },
      { type: "agent-text", agentId: "w1", text: "third words", at: 2_300 },
      { type: "agent-text", agentId: "w1", text: "fourth words", at: 2_400 },
      { type: "agent-text", agentId: "w1", text: "fifth words", at: 2_500 },
      { type: "supervisor-verdict", verdict: { targetAgentId: "w1", action: "warn", reason: "drift", at: 2_600 } },
      { type: "compaction", agentId: "w1", beforeTokens: 100, afterTokens: 60, episodesSummarized: 3, outputsElided: 2, coldMoved: 1_500, at: 2_700 },
      { type: "compaction", agentId: "w1", beforeTokens: 90, afterTokens: 50, episodesSummarized: 2, outputsElided: 1, coldMoved: 700, at: 2_800 },
      { type: "agent-status", agentId: "w1", status: "killed", note: "supervisor killed the worker", at: 3_500 },
    ] as unknown as RunEvent[];

    const plan = buildResumePlan(events) as ResumePlan;
    assert.equal(plan.profileId, "prof-1");
    assert.equal(plan.priorRunId, "run-a");
    assert.equal(plan.budgetRemainingMs, 300_000); // last tick wins
    assert.equal(plan.windowOpen, false);
    assert.equal(plan.supervisorVerdicts, 1);
    assert.equal(plan.compactions, 2);
    assert.equal(plan.coldMovedTokens, 2_200);
    assert.equal(plan.agents.length, 2);
    const worker = plan.agents.find((a) => a.agentId === "w1");
    const boss = plan.agents.find((a) => a.agentId === "s1");
    assert.deepEqual(
      { worker: worker && { role: worker.role, lastStatus: worker.lastStatus, statusNote: worker.statusNote, model: worker.model, label: worker.label } },
      { worker: { role: "worker", lastStatus: "killed", statusNote: "supervisor killed the worker", model: "m-1", label: "Worker" } },
    );
    assert.deepEqual(boss && { lastStatus: boss.lastStatus, statusNote: boss.statusNote }, { lastStatus: "running", statusNote: "" }); // no status events → defaults
  });

  test("workerTail keeps the LAST 3 worker texts in order, then the status note as a user line", () => {
    const events = [
      STARTED,
      WORKER_STARTED,
      { type: "agent-status", agentId: "w1", status: "running", note: "refactoring the meter", at: 9_900 },
      { type: "agent-text", agentId: "w1", text: "t1", at: 1 },
      { type: "agent-text", agentId: "w1", text: "t2", at: 2 },
      { type: "agent-text", agentId: "w1", text: "t3", at: 3 },
      { type: "agent-text", agentId: "w1", text: "t4", at: 4 },
      { type: "agent-text", agentId: "w1", text: "t5", at: 5 },
    ] as unknown as RunEvent[];
    const plan = buildResumePlan(events) as ResumePlan;
    assert.deepEqual(plan.workerTail, [
      { role: "assistant", text: "t3" },
      { role: "assistant", text: "t4" },
      { role: "assistant", text: "t5" },
      { role: "user", text: "refactoring the meter" },
    ]);
  });

  test("workerTail without a status note has only the assistant lines; non-worker texts are excluded", () => {
    const events = [
      STARTED,
      WORKER_STARTED,
      BOSS_STARTED,
      { type: "agent-text", agentId: "w1", text: "worker words", at: 1 },
      { type: "agent-text", agentId: "s1", text: "boss words must not leak into the worker tail", at: 2 },
    ] as unknown as RunEvent[];
    const plan = buildResumePlan(events) as ResumePlan;
    assert.deepEqual(plan.workerTail, [{ role: "assistant", text: "worker words" }]);
  });

  test("no budget-tick → remainingMs 0 and windowOpen null", () => {
    const plan = buildResumePlan([STARTED, WORKER_STARTED] as unknown as RunEvent[]) as ResumePlan;
    assert.equal(plan.budgetRemainingMs, 0);
    assert.equal(plan.windowOpen, null);
  });

  test("kill-after-run: a killed status as the very last event still yields a plan", () => {
    const events = [
      STARTED,
      WORKER_STARTED,
      { type: "agent-status", agentId: "w1", status: "killed", note: "forbidden-list breach", at: 9_999 },
    ] as unknown as RunEvent[];
    const plan = buildResumePlan(events) as ResumePlan;
    assert.equal(plan.agents[0].lastStatus, "killed");
    assert.equal(plan.agents[0].statusNote, "forbidden-list breach");
    assert.deepEqual(plan.workerTail, [{ role: "user", text: "forbidden-list breach" }]);
  });

  test("malformed agent fields coerce to contract defaults instead of poisoning the plan", () => {
    const events = [
      STARTED,
      { type: "agent-started", agentId: "x1", role: "wizard", label: 42, model: null, at: 1 },
      { type: "agent-status", agentId: "x1", status: "exploded", note: 7, at: 2 },
      { type: "compaction", agentId: "x1", coldMoved: "lots", at: 3 },
    ] as unknown as RunEvent[];
    const plan = buildResumePlan(events) as ResumePlan;
    assert.equal(plan.agents.length, 1);
    assert.deepEqual(
      { role: plan.agents[0].role, label: plan.agents[0].label, model: plan.agents[0].model, lastStatus: plan.agents[0].lastStatus, note: plan.agents[0].statusNote },
      { role: "sub", label: "", model: "", lastStatus: "running", note: "" },
    );
    assert.equal(plan.compactions, 1);
    assert.equal(plan.coldMovedTokens, 0);
  });

  test("agents array preserves first-appearance order across interleaved events", () => {
    const events = [
      STARTED,
      agentStarted("a1", "sub", 1),
      agentStarted("b1", "coordinator", 2),
      agentStarted("c1", "worker", 3),
    ] as unknown as RunEvent[];
    const plan = buildResumePlan(events) as ResumePlan;
    assert.deepEqual(plan.agents.map((a) => a.agentId), ["a1", "b1", "c1"]);
    assert.deepEqual(plan.agents.map((a) => a.role), ["sub", "coordinator", "worker"]);
  });
});
