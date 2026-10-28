import type { ToolDef } from "../agents/tools/types.js";
import type { Ledger } from "./ledger.js";

/**
 * The `ledger` tool: agents maintain their own durable state. Everything
 * written here survives compaction by construction (the ledger is pinned
 * and re-injected every turn).
 */
export function ledgerTool(ledger: Ledger): ToolDef {
  return {
    name: "ledger",
    description:
      "Record durable state about YOUR work: what you are doing now, what finished (one item), a decision with its why, a file worth remembering, or a gotcha for later. Written state survives context compaction — use it the moment something matters.",
    parameters: {
      type: "object",
      properties: {
        doing: { type: "string", description: "Replace the current-focus line." },
        done: { type: "string", description: "Append one completed item." },
        decision_what: { type: "string", description: "Decision made (with decision_why)." },
        decision_why: { type: "string", description: "Rationale for the decision." },
        file_path: { type: "string", description: "File worth remembering (with file_note)." },
        file_note: { type: "string", description: "Why this file matters." },
        gotcha: { type: "string", description: "A trap or surprise for later you." },
      },
    },
    execute: async (args) => {
      const state = ledger.load();
      if (typeof args.doing === "string" && args.doing.trim()) state.doing = args.doing.trim().slice(0, 300);
      // The ledger stores chronologically (push = newest last); render() shows latest first.
      if (typeof args.done === "string" && args.done.trim()) state.done.push(args.done.trim().slice(0, 300));
      if (typeof args.decision_what === "string" && args.decision_what.trim()) {
        state.decisions.push({
          what: args.decision_what.trim().slice(0, 200),
          why: String(args.decision_why || "").trim().slice(0, 200),
        });
      }
      if (typeof args.file_path === "string" && args.file_path.trim()) {
        state.files.push({
          path: args.file_path.trim().slice(0, 200),
          note: String(args.file_note || "").trim().slice(0, 200),
        });
      }
      if (typeof args.gotcha === "string" && args.gotcha.trim()) state.gotchas.push(args.gotcha.trim().slice(0, 300));
      state.updatedAt = Date.now();
      ledger.save(state);
      return { ok: true, output: "Ledger updated. This state survives compaction." };
    },
  };
}

/**
 * The `recall` tool: verbatim return of evicted context.
 */
export function recallTool(recall: { search(query: string, limit?: number): { ref: string; agentId: string; kind: string; at: number; snippet: string }[] }): ToolDef {
  return {
    name: "recall",
    description:
      "Search everything evicted from your context (older tool outputs, earlier episodes). Give a focused query; matching lines come back verbatim with references.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "All words must match. e.g. \"config loader error\"" },
        limit: { type: "number", description: "Max hits (default 5, max 20)." },
      },
      required: ["query"],
    },
    execute: async (args) => {
      const query = String(args.query || "").trim();
      if (!query) return { ok: false, output: "recall needs a non-empty query." };
      const limit = Math.min(20, Math.max(1, Number(args.limit) || 5));
      const hits = recall.search(query, limit);
      if (!hits.length) return { ok: true, output: `No matches for "${query}" in evicted context.` };
      return {
        ok: true,
        output: hits.map((h) => `${h.ref} [${h.kind}] ${new Date(h.at).toISOString()}\n  ${h.snippet}`).join("\n"),
      };
    },
  };
}
