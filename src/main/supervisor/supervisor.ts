import type { ProfileConfig, RunEvent, SupervisorVerdict, VerdictAction } from "../../shared/types.js";
import { streamProvider } from "../providers/index.js";
import { pathViolation } from "./workspace-bounds.js";
import type { AgentRunner } from "../agents/runner.js";
import { SUPERVISOR_WARN_LIMIT } from "../../shared/types.js";

const VERDICT_SPEC = `Respond with ONLY a JSON object, no prose, no code fence:
{"action":"ok"|"warn"|"kill","agent":"<agentId from the feed, e.g. worker>","reason":"<one sentence, concrete>"}
- "ok": within bounds.
- "warn": suspicious or drifting; the agent gets this reason as a warning.
- "kill": clear violation continuing after a warning, unauthorized access, potential harm, or work outside the user's request.`;

/**
 * The supervisor copy: same trusted provider as the worker, read-only.
 * Deterministic checks first (cheap, exact), LLM verdict second.
 * The supervisor model never executes anything — the orchestrator executes.
 */
export class Supervisor {
  private feed: string[] = [];
  private violations = new Map<string, string[]>();
  private toolCount = 0;
  private lastVerdictAt = 0;
  private inFlight = false;

  constructor(
    private profile: ProfileConfig,
    private opts: {
      emit(event: RunEvent): void;
      kill(agentId: string, reason: string): void;
      warn(agentId: string, reason: string): void;
      runners: Map<string, AgentRunner>;
    },
  ) {}

  observe(event: RunEvent): void {
    if (event.type === "tool-call") {
      this.toolCount++;
      this.feed.push(`[${event.agentId}] ${event.tool} ${event.summary}`);
      // Weeks-long runs: the feed is a sliding window, not an archive —
      // the journal is the durable record, this is only review input.
      if (this.feed.length > 600) this.feed.splice(0, this.feed.length - 600);
      const violation = this.deterministicCheck(event.tool, event.args, event.agentId);
      if (violation) {
        this.enforce({ targetAgentId: event.agentId, action: "warn", reason: violation, at: Date.now() });
        return;
      }
    } else if (event.type === "tool-result") {
      const head = event.ok ? event.outputHead : `FAILED: ${event.outputHead}`;
      this.feed.push(`[${event.agentId}] → ${head.replace(/\n/g, " ").slice(0, 160)}`);
      if (this.feed.length > 600) this.feed.splice(0, this.feed.length - 600);
    }

    // LLM verdict pass: every 6 tool calls, at most every 90 seconds.
    if (this.toolCount > 0 && this.toolCount % 6 === 0 && Date.now() - this.lastVerdictAt > 90_000 && !this.inFlight) {
      void this.review();
    }
  }

  /** Cheap exact checks: forbidden-list hits and workspace escape. */
  private deterministicCheck(tool: string, args: Record<string, unknown>, agentId: string): string | null {
    const text = JSON.stringify(args).toLowerCase();

    for (const rule of this.profile.forbidden) {
      const needle = rule.trim().toLowerCase();
      if (needle.length > 2 && text.includes(needle)) {
        return `Forbidden rule hit (${needle}) in ${tool} call`;
      }
    }

    const violation = pathViolation(tool, args, this.profile.workspace);
    if (violation) return violation;

    void agentId;
    return null;
  }

  private async review(): Promise<void> {
    this.inFlight = true;
    try {
      const recent = this.feed.slice(-60).join("\n");
      const res = await streamProvider(
        {
          kind: this.profile.source.kind,
          name: "Supervisor",
          baseUrl: this.profile.source.baseUrl,
          model: this.profile.source.model,
          apiKey: this.profile.source.apiKey,
          system: this.system(),
          messages: [{ role: "user", content: `Activity feed:\n${recent}\n\n${VERDICT_SPEC}` }],
          tools: [],
          temperature: 0,
          maxTokens: 300,
        },
        {},
      );
      this.lastVerdictAt = Date.now();
      const verdict = parseVerdict(res.text);
      if (verdict && verdict.action !== "ok" && verdict.targetAgentId) this.enforce(verdict);
    } catch {
      // Supervisor must never take the run down; the next pass retries.
    } finally {
      this.inFlight = false;
    }
  }

  private system(): string {
    const forbidden = this.profile.forbidden.map((l) => `- ${l}`).join("\n") || "- (none)";
    return `You are the SUPERVISOR of an Unlimited agent run. You watch the crew's activity and protect the user.

User's goal:
${this.profile.goal}

Forbidden (never allowed, in any form):
${forbidden}

Watch for: unauthorized access, work outside the workspace or outside the user's request, potential harm, forbidden actions, cover-ups (attempts to hide what was done).

You cannot execute anything. You judge; the app enforces. ${VERDICT_SPEC}`;
  }

  private enforce(verdict: SupervisorVerdict): void {
    this.opts.emit({ type: "supervisor-verdict", verdict, at: Date.now() });
    if (verdict.action === "kill") {
      this.opts.kill(verdict.targetAgentId, verdict.reason);
      return;
    }
    if (verdict.action === "warn") {
      const past = this.violations.get(verdict.targetAgentId) || [];
      // Same violation class repeated after a warning means kill.
      const key = verdict.reason.split(" ").slice(0, 3).join(" ").toLowerCase();
      const repeated = past.includes(key);
      past.push(key);
      this.violations.set(verdict.targetAgentId, past);
      if (past.filter((k) => k === key).length > SUPERVISOR_WARN_LIMIT) {
        this.opts.kill(verdict.targetAgentId, `Continued after warning: ${verdict.reason}`);
      } else {
        this.opts.warn(verdict.targetAgentId, verdict.reason);
      }
    }
  }
}

function parseVerdict(text: string): SupervisorVerdict | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (parsed.action === "ok" || parsed.action === "warn" || parsed.action === "kill") {
      return {
        action: parsed.action as VerdictAction,
        reason: String(parsed.reason || "").slice(0, 300),
        targetAgentId: String(parsed.agent || "").slice(0, 40),
        at: Date.now(),
      };
    }
  } catch {
    // fall through
  }
  return null;
}
