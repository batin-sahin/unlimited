import type { ProfileConfig, ProviderConfig, RunEvent } from "../../shared/types.js";
import type { ChatMessage } from "../providers/types.js";
import { streamProvider } from "../providers/index.js";
import { Ledger } from "./ledger.js";
import { Recall } from "./recall.js";
import { estimateTokens, meterTurn } from "./meter.js";
import { WINDOW_DEFAULT, shouldCompact, emergencyPlan, zoneFor } from "./policy.js";
import { elideToolOutput } from "./elide.js";
import { formatRemaining } from "../budget.js";

/** What runners/orchestrator use of the engine — keeps wiring honest. */
export interface EngineLike {
  beforeTurn(runner: { messages: ChatMessage[]; systemBlock: string }, turn: number): Promise<void>;
  recallStore: Recall;
  ledgerStore: Ledger;
}

/**
 * The compaction engine. Layers:
 *   PINNED  — system block + ledger: re-injected every turn, never evicted.
 *   HOT     — recent episodes verbatim (tool outputs kernelled in place).
 *   COLD    — everything evicted, fully on disk, searchable via recall.
 * Compaction runs BETWEEN turns only. Every pass prints an honest event row.
 */
export class CompactionEngine {
  private ledger: Ledger;
  private recall: Recall;
  private lastCompactTurn = 0;
  private coldMovedTotal = 0;

  constructor(
    private opts: {
      profile: ProfileConfig;
      source: ProviderConfig;
      runId: string;
      agentId: string;
      budgetRemainingMs: () => number;
      hooks: { emit(event: RunEvent): void };
    },
  ) {
    this.ledger = new Ledger(opts.runId, opts.agentId);
    this.recall = new Recall(opts.runId);
  }

  /** Runner seam: called before every turn. */
  async beforeTurn(runner: { messages: ChatMessage[]; systemBlock: string }, turn: number): Promise<void> {
    const metered = meterTurn(runner.messages, runner.systemBlock);
    const limit = WINDOW_DEFAULT;
    const zone = zoneFor(metered.total, limit);

    this.opts.hooks.emit({
      type: "pressure",
      agentId: this.opts.agentId,
      pressure: { pinned: metered.pinned, hot: metered.hot, limit, coldMoved: this.coldMovedTotal, zone },
      at: Date.now(),
    });

    if (!shouldCompact(metered.total, limit, turn - this.lastCompactTurn)) return;

    const plan = emergencyPlan(metered.total, limit);
    const cut = this.cutIndex(runner.messages, plan.keepLastEpisodes);
    if (cut <= 0) return; // nothing safely evictable yet

    const evicted = runner.messages.slice(0, cut);
    const kept = runner.messages.slice(cut);

    // 1. Cold store: everything evicted, full fidelity.
    for (const m of evicted) {
      const kind = m.role === "tool" ? `tool-output:${m.toolName || "unknown"}` : m.role;
      if (m.content) this.recall.append(this.opts.agentId, kind, m.content);
      if (m.toolCalls) {
        for (const call of m.toolCalls) {
          this.recall.append(this.opts.agentId, "tool-call", `${call.name} ${call.arguments}`);
        }
      }
    }

    // 2. Summarize + fold into the ledger.
    const summary = await this.summarize(evicted);
    const result = summary
      ? { summary, beforeTokens: metered.total }
      : { summary: "(summarizer unavailable — episodes moved to cold storage whole)", beforeTokens: metered.total };

    // 3. Rewrite context: one honest compaction header + hot tail.
    const header =
      `[COMPACTED CONTEXT — ${result.beforeTokens} tokens were above; nothing was silently dropped.\n` +
      `Work so far:\n${result.summary}\n\n` +
      `${this.ledger.render()}\n` +
      `Evicted details live on disk: recall("your query") brings them back verbatim.]`;

    // Kernel any large tool outputs that remain in the hot tail.
    if (plan.elideOutputs) {
      for (const m of kept) {
        if (m.role === "tool" && m.content.length > 6000) {
          const elided = elideToolOutput(m.content);
          m.content = elided.text;
        }
      }
    }

    runner.messages.splice(0, cut, { role: "user", content: header });
    this.lastCompactTurn = turn;

    const after = meterTurn(runner.messages, runner.systemBlock);
    const coldThisPass = evicted.reduce((n, m) => n + estimateTokens(m.content), 0);
    this.coldMovedTotal += coldThisPass;
    this.opts.hooks.emit({
      type: "compaction",
      agentId: this.opts.agentId,
      beforeTokens: metered.total,
      afterTokens: after.total,
      episodesSummarized: countEpisodes(evicted),
      outputsElided: kept.filter((m) => m.role === "tool" && m.content.length > 6000).length,
      coldMoved: coldThisPass,
      at: Date.now(),
    });
  }

  /**
   * Fold the summarizer's incremental ledger JSON into the persisted state.
   * New items append (chronological); `doing` replaces when non-empty.
   * Never trusts model-shaped input.
   */
  private foldLedger(inc: unknown): void {
    if (!inc || typeof inc !== "object") return;
    const state = this.ledger.load();
    const r = inc as Record<string, unknown>;
    if (typeof r.doing === "string" && r.doing.trim()) state.doing = r.doing.trim().slice(0, 300);
    const pushText = (v: unknown, into: string[]): void => {
      const s = String(v ?? "").trim().slice(0, 300);
      if (s) into.push(s);
    };
    if (Array.isArray(r.done)) for (const v of r.done) pushText(v, state.done);
    if (Array.isArray(r.gotchas)) for (const v of r.gotchas) pushText(v, state.gotchas);
    if (Array.isArray(r.decisions)) {
      for (const d of r.decisions) {
        if (d && typeof d === "object") {
          const what = String((d as any).what ?? "").trim().slice(0, 200);
          const why = String((d as any).why ?? "").trim().slice(0, 200);
          if (what || why) state.decisions.push({ what, why });
        }
      }
    }
    if (Array.isArray(r.files)) {
      for (const f of r.files) {
        if (f && typeof f === "object") {
          const p = String((f as any).path ?? "").trim().slice(0, 200);
          const note = String((f as any).note ?? "").trim().slice(0, 200);
          if (p) state.files.push({ path: p, note });
        }
      }
    }
    state.updatedAt = Date.now();
    this.ledger.save(state);
  }

  /** Episode boundary = user message (task, nudge, or compaction header). */
  private cutIndex(messages: ChatMessage[], keepEpisodes: number): number {
    let seen = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        seen++;
        if (seen > keepEpisodes) return i;
      }
    }
    return 0; // fewer episodes than the keep count — nothing to evict
  }

  /** Ask the trusted source provider for a summary + ledger fold. One retry, then give up quietly. */
  private async summarize(evicted: ChatMessage[]): Promise<string | null> {
    const ledgerState = this.ledger.load();
    const transcript = evicted
      .map((m) => {
        const body = m.content.length > 400 ? `${m.content.slice(0, 200)}…${m.content.slice(-150)}` : m.content;
        return `${m.role}: ${body}`;
      })
      .join("\n");

    const prompt = `You compact the context of a long-running agent. Below is the evicted transcript.
Update the ledger (structured state) and write a dense summary of work so far.

Current ledger:
${this.ledger.render(ledgerState)}

Evicted transcript:
${transcript}

Remaining budget: ${formatRemaining(this.opts.budgetRemainingMs())}.

Respond with ONLY JSON:
{"summary":"<8 lines max: what was accomplished, in what order, key results>","ledger":{"doing":"<current focus>","done":["<item>"],"decisions":[{"what":"...","why":"..."}],"files":[{"path":"...","note":"..."}],"gotchas":["..."]}}
Every array is incremental — include only NEW or CHANGED items.`;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await streamProvider(
          {
            kind: this.opts.source.kind,
            name: "Compaction",
            baseUrl: this.opts.source.baseUrl,
            model: this.opts.source.model,
            apiKey: this.opts.source.apiKey,
            system:
              "You are the compaction engine of an autonomous agent. You preserve facts exactly — you never invent work. Respond with the requested JSON only.",
            messages: [{ role: "user", content: prompt }],
            tools: [],
            temperature: 0.1,
            maxTokens: 900,
          },
          {},
        );
        const parsed = extractJson(res.text);
        if (!parsed) continue;
        if (parsed.ledger) this.foldLedger(parsed.ledger);
        return String(parsed.summary || "").slice(0, 2400) || null;
      } catch {
        if (attempt === 1) return null;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    return null;
  }

  get recallStore(): Recall {
    return this.recall;
  }

  get ledgerStore(): Ledger {
    return this.ledger;
  }
}

function extractJson(text: string): any | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function countEpisodes(messages: ChatMessage[]): number {
  return messages.filter((m) => m.role === "user").length;
}
