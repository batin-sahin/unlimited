import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";

// ---- runtime shim for `node --test` on TypeScript sources -----------------
//
// npm test executes these .ts files directly (Node type stripping). Node
// resolves relative specifiers VERBATIM, so the codebase-mandated ".js"
// suffixes (required by tsc/esbuild for the bundled app) would not resolve.
// This synchronous hook rewrites ".js" → ".ts" for local files only, and
// falls back to the original specifier when no .ts twin exists. It exists
// only in this test file; the bundled production app never runs it.
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

const { Recall, sqliteBackendAvailable } = await import("./recall.js");
const { Ledger } = await import("./ledger.js");

type RecallCtor = typeof Recall;
type LedgerCtor = typeof Ledger;
type RecallInstance = InstanceType<RecallCtor>;
type LedgerInstance = InstanceType<LedgerCtor>;
type LedgerState = Parameters<LedgerInstance["save"]>[0];

if (!sqliteBackendAvailable) {
  console.warn("[recall.test] node:sqlite probe failed here: only the JSONL scan fallback is under test.");
}

function tmpRoot(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unlimited-compaction-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Fresh per-test run dir; deliberately nonexistent so the classes exercise their own 0700 mkdir. */
function runDir(t: TestContext): string {
  return path.join(tmpRoot(t), "runs", `run-${Math.random().toString(36).slice(2, 8)}`);
}

function modeOf(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

// ---- Recall: the same assertions run against EVERY available backend ----

function recallSuite(backend: "jsonl" | "sqlite", make: (t: TestContext) => { r: RecallInstance; dir: string }): void {
  const tag = `[recall:${backend}]`;

  test(`${tag} append → search roundtrip`, (t) => {
    const { r } = make(t);
    r.append("worker", "tool-result", "listed src/main: journal, profiles, compaction", 1000);
    r.append("worker", "agent-text", "the meter reports pressure ok and cold moved up", 2000);
    const hits = r.search("pressure");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].agentId, "worker");
    assert.equal(hits[0].kind, "agent-text");
    assert.equal(hits[0].at, 2000);
    assert.equal(hits[0].ref, "cold/worker.jsonl#L2");
    assert.ok(hits[0].snippet.toLowerCase().includes("pressure"));
    r.close();
  });

  test(`${tag} AND semantics: a missing term means no hit`, (t) => {
    const { r } = make(t);
    r.append("worker", "note", "alpha starts here", 10);
    r.append("worker", "note", "alpha and beta together", 20);
    assert.equal(r.search("alpha beta").length, 1);
    assert.equal(r.search("beta alpha")[0].ref, "cold/worker.jsonl#L2");
    assert.equal(r.search("gamma").length, 0);
    assert.equal(r.search("alpha gamma").length, 0);
    r.close();
  });

  test(`${tag} snippet is a single ~240 char region with ellipses`, (t) => {
    const { r } = make(t);
    const text = `${"lorem ipsum ".repeat(120)}needle in the middle${" tail ipsum ".repeat(120)}`;
    r.append("worker", "note", text, 10);
    const [hit] = r.search("needle");
    assert.ok(hit, "expected a hit");
    assert.ok(hit.snippet.length <= 242, `snippet too long: ${hit.snippet.length}`);
    assert.ok(hit.snippet.startsWith("…"), "expected a leading ellipsis");
    assert.ok(hit.snippet.endsWith("…"), "expected a trailing ellipsis");
    assert.ok(hit.snippet.toLowerCase().includes("needle"));
    // earliest matching term anchors the snippet: "beta" is far away and absent
    r.append("worker", "note", `${"word ".repeat(20)}alpha${" word".repeat(400)} beta`, 20);
    const [joint] = r.search("alpha beta");
    assert.ok(joint, "expected a hit");
    assert.ok(joint.snippet.toLowerCase().includes("alpha"));
    assert.ok(!joint.snippet.toLowerCase().includes("beta"));
    r.close();
  });

  test(`${tag} refs carry exact per-record line numbers`, (t) => {
    const { r } = make(t);
    r.append("worker", "note", "zeta-one first record", 10);
    r.append("worker", "note", "zeta-two second record", 20);
    r.append("worker", "note", "zeta-three third record", 30);
    assert.equal(r.search("zeta-one")[0].ref, "cold/worker.jsonl#L1");
    assert.equal(r.search("zeta-two")[0].ref, "cold/worker.jsonl#L2");
    assert.equal(r.search("zeta-three")[0].ref, "cold/worker.jsonl#L3");
    const all = r.search("zeta");
    assert.deepEqual(
      all.map((h) => h.ref),
      ["cold/worker.jsonl#L3", "cold/worker.jsonl#L2", "cold/worker.jsonl#L1"], // newest first
    );
    r.close();
  });

  test(`${tag} limit: default 5, explicit, and hard cap 20`, (t) => {
    const { r } = make(t);
    for (let i = 1; i <= 25; i += 1) r.append("worker", "note", `bulkmarker record ${i}`, i * 10);
    assert.equal(r.search("bulkmarker").length, 5);
    const five = r.search("bulkmarker");
    assert.deepEqual(
      five.map((h) => h.at), // newest first
      [250, 240, 230, 220, 210],
    );
    assert.equal(r.search("bulkmarker", 3).length, 3);
    assert.equal(r.search("bulkmarker", 25).length, 20); // max cap
    assert.equal(r.search("bulkmarker", 0).length, 1); // clamped to a sane minimum
    r.close();
  });

  test(`${tag} empty query yields no hits`, (t) => {
    const { r } = make(t);
    r.append("worker", "note", "something searchable", 10);
    assert.deepEqual(r.search(""), []);
    assert.deepEqual(r.search("   \t  "), []);
    r.close();
  });

  test(`${tag} unicode text survives disk and search`, (t) => {
    const { r, dir } = make(t);
    r.append("worker", "note", "término 東京です café 🎉 done", 700);
    for (const term of ["término", "東京です", "café"]) {
      const hits = r.search(term);
      assert.equal(hits.length, 1, `term ${term}`);
      assert.ok(hits[0].snippet.includes(term));
    }
    const raw = fs.readFileSync(path.join(dir, "cold-worker.jsonl"), "utf8");
    assert.ok(raw.includes("🎉"), "emoji must survive the JSONL roundtrip");
    r.close();
  });

  test(`${tag} per-agent isolation`, (t) => {
    const { r, dir } = make(t);
    r.append("agent-a", "note", "secret-alpha marker shared-token", 10);
    r.append("agent-b", "note", "secret-beta marker shared-token", 20);
    const shared = r.search("shared-token");
    assert.deepEqual(
      shared.map((h) => h.agentId).sort(),
      ["agent-a", "agent-b"],
    );
    const onlyA = r.search("secret-alpha");
    assert.equal(onlyA.length, 1);
    assert.equal(onlyA[0].agentId, "agent-a");
    assert.equal(onlyA[0].ref, "cold/agent-a.jsonl#L1");
    const rawA = fs.readFileSync(path.join(dir, "cold-agent-a.jsonl"), "utf8");
    assert.ok(!rawA.includes("secret-beta"), "agent files must not cross-contaminate");
    r.close();
  });

  test(`${tag} oversized line (>200k) is found via window scan, one physical line`, (t) => {
    const { r, dir } = make(t);
    const text = `${"x".repeat(1000)} needle-alpha ${"y".repeat(290000)} needle-beta`;
    r.append("worker", "tool-result", text, 4242);
    const hits = r.search("needle-alpha needle-beta"); // terms ~290k chars apart
    assert.equal(hits.length, 1);
    assert.equal(hits[0].ref, "cold/worker.jsonl#L1");
    assert.equal(hits[0].at, 4242);
    assert.equal(hits[0].kind, "tool-result");
    assert.equal(fs.readFileSync(path.join(dir, "cold-worker.jsonl"), "utf8").split("\n").length, 2); // record + trailing \n
    r.close();
  });

  test(`${tag} state survives close/reopen; line numbering continues`, (t) => {
    const dir = runDir(t);
    const r1 = new Recall("run-1", { baseDir: dir, backend }) as RecallInstance;
    r1.append("worker", "note", "persist-one", 10);
    r1.append("worker", "note", "persist-two", 20);
    r1.close();
    const r2 = new Recall("run-1", { baseDir: dir, backend }) as RecallInstance;
    assert.equal(r2.search("persist").length, 2);
    r2.append("worker", "note", "persist-three", 30);
    const hits = r2.search("persist");
    assert.equal(hits.length, 3);
    assert.equal(hits[0].ref, "cold/worker.jsonl#L3"); // newest first, numbering continued
    r2.close();
  });

  test(`${tag} file/dir permissions (0600 files, 0700 dirs)`, (t) => {
    const { r, dir } = make(t);
    r.append("worker", "note", "permission probe", 10);
    assert.equal(modeOf(dir), 0o700);
    assert.equal(modeOf(path.join(dir, "cold-worker.jsonl")), 0o600);
    if (backend === "sqlite") {
      assert.equal(modeOf(path.join(dir, "cold-index.db")), 0o600);
    } else {
      assert.ok(!fs.existsSync(path.join(dir, "cold-index.db")), "fallback must not create an index file");
    }
    r.close();
  });

  test(`${tag} close is idempotent; use afterwards throws`, (t) => {
    const { r } = make(t);
    r.append("worker", "note", "bye", 10);
    r.close();
    r.close(); // no-op
    assert.throws(() => r.append("worker", "note", "after close"));
    assert.throws(() => r.search("bye"));
  });
}

function recallFactory(backend: "jsonl" | "sqlite"): (t: TestContext) => { r: RecallInstance; dir: string } {
  return (t) => {
    const dir = runDir(t);
    return { r: new Recall("run-1", { baseDir: dir, backend }) as RecallInstance, dir };
  };
}

recallSuite("jsonl", recallFactory("jsonl"));
if (sqliteBackendAvailable) recallSuite("sqlite", recallFactory("sqlite"));

// ---- Ledger ----------------------------------------------------------------

test("[ledger] load on missing file returns a fresh empty state", (t) => {
  const ledger = new Ledger("run-1", "worker", runDir(t)) as LedgerInstance;
  assert.deepStrictEqual(ledger.load(), {
    doing: "",
    done: [],
    decisions: [],
    files: [],
    gotchas: [],
    updatedAt: 0,
  });
});

test("[ledger] save → load roundtrip preserves everything (incl. unicode)", (t) => {
  const ledger = new Ledger("run-1", "worker", runDir(t)) as LedgerInstance;
  const state: LedgerState = {
    doing: "implementing compaction — fase 5 🏗️",
    done: ["probed node:sqlite", "wrote the journal writer"],
    decisions: [{ what: "FTS5 when present", why: "indexed search beats linear scans at 50MB" }],
    files: [{ path: "src/main/compaction/recall.ts", note: "cold store" }],
    gotchas: ["FTS5 tokenizer diverges from substring search on punctuation"],
    updatedAt: 1234567890,
  };
  ledger.save(state);
  assert.deepStrictEqual(ledger.load(), state);
  // render() with no argument re-loads from disk
  const rendered = ledger.render();
  assert.ok(rendered.includes("FTS5 when present — indexed search beats linear scans at 50MB"));
  assert.ok(rendered.includes("implementing compaction"));
});

test("[ledger] save coerces garbage input; corrupt file loads fresh", (t) => {
  const dir = runDir(t);
  const ledger = new Ledger("run-1", "worker", dir) as LedgerInstance;
  const garbage = {
    doing: 42,
    done: "not-an-array",
    decisions: "nope",
    files: [{ path: 5 }],
    gotchas: [null, "real gotcha"],
    updatedAt: "soon",
  } as unknown as LedgerState;
  assert.doesNotThrow(() => ledger.save(garbage));
  const loaded = ledger.load();
  assert.equal(loaded.doing, "42");
  assert.deepEqual(loaded.done, []);
  assert.deepEqual(loaded.decisions, []);
  assert.deepEqual(loaded.files, [{ path: "5", note: "" }]);
  assert.deepEqual(loaded.gotchas, ["real gotcha"]);
  assert.equal(loaded.updatedAt, 0);
  // a corrupt ledger file is tolerated, not fatal
  fs.writeFileSync(path.join(dir, "ledger-worker.json"), "{ this is not json");
  assert.deepStrictEqual(ledger.load().done, []);
});

test("[ledger] empty state renders as the header only", (t) => {
  const ledger = new Ledger("run-1", "worker", runDir(t)) as LedgerInstance;
  assert.equal(ledger.render(), "## Ledger (state that must survive)");
});

test("[ledger] render caps sections and shows DONE latest-first with trim markers", (t) => {
  const ledger = new Ledger("run-1", "worker", runDir(t)) as LedgerInstance;
  const state: LedgerState = {
    doing: "busy",
    done: Array.from({ length: 30 }, (_, i) => `item-${String(i + 1).padStart(2, "0")}`),
    decisions: Array.from({ length: 15 }, (_, i) => ({ what: `decision-${i + 1}`, why: `why-${i + 1}` })),
    files: Array.from({ length: 15 }, (_, i) => ({ path: `file-${i + 1}.ts`, note: `note-${i + 1}` })),
    gotchas: Array.from({ length: 10 }, (_, i) => `got-${i + 1}`),
    updatedAt: 1,
  };
  const text = ledger.render(state);
  const doneLines = text.split("\n").filter((l) => /^- item-/.test(l));
  assert.equal(doneLines.length, 12); // DONE max 12
  assert.equal(doneLines[0], "- item-30"); // latest first
  assert.equal(doneLines[11], "- item-19");
  assert.ok(!text.includes("\n- item-18\n"), "older entries must be dropped");
  assert.equal(text.split("\n").filter((l) => /^- decision-/.test(l)).length, 10); // DECISIONS max 10
  assert.equal(text.split("\n").filter((l) => /^- file-/.test(l)).length, 12); // FILES max 12
  assert.equal(text.split("\n").filter((l) => /^- got-/.test(l)).length, 8); // GOTCHAS max 8
  assert.equal(text.split("(older trimmed)").length - 1, 4); // every capped section announces the trim
});

test("[ledger] render honors the ~1200 token hard cap", (t) => {
  const ledger = new Ledger("run-1", "worker", runDir(t)) as LedgerInstance;
  const state: LedgerState = {
    doing: "churning",
    done: Array.from({ length: 60 }, (_, i) => `filler-${i} ${"x".repeat(500)}`),
    decisions: Array.from({ length: 20 }, (_, i) => ({ what: `huge-decision-${i}`, why: "y".repeat(600) })),
    files: [],
    gotchas: [],
    updatedAt: 1,
  };
  const text = ledger.render(state);
  assert.ok(Math.ceil(text.length / 4) <= 1200, `rendered block too large: ${text.length} chars`);
  assert.ok(text.includes("(older trimmed)"));
  assert.ok(text.includes("- filler-"), "the latest entries must survive the trim");
});

test("[ledger] file/dir permissions (0600 file, 0700 dir)", (t) => {
  const dir = runDir(t);
  const ledger = new Ledger("run-1", "worker", dir) as LedgerInstance;
  ledger.save({ doing: "", done: ["x"], decisions: [], files: [], gotchas: [], updatedAt: 1 });
  assert.equal(modeOf(dir), 0o700);
  assert.equal(modeOf(path.join(dir, "ledger-worker.json")), 0o600);
});
