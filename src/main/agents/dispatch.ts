import type { ProfileConfig, RunEvent } from "../../shared/types.js";
import { AgentRunner } from "./runner.js";
import { ledgerTool, recallTool } from "../compaction/tools.js";
import type { EngineLike } from "../compaction/engine.js";
import type { ToolContext, ToolDef } from "./tools/types.js";

/**
 * One sub-agent session per slot, for the whole run. The worker opens it
 * with a work order and then continues it with follow-ups: the context that
 * already read the project is the point. This also makes "a new agent per
 * tool call" structurally impossible — a second dispatch to the same slot
 * is a message in the same conversation, not a fresh spawn.
 */
export interface SubSession {
  runner: AgentRunner;
  engine: EngineLike;
  /** Dispatches sent to this session, including the one that opened it. */
  dispatches: number;
}

/**
 * dispatch_task — the worker's only way to change the workspace: hand a
 * scoped work order to one configured sub-agent (its own provider/model/key).
 * The child runs the same tool registry minus coordination powers, in the
 * same workspace, and its report comes back as the tool result.
 */
export function dispatchTool(
  profile: ProfileConfig,
  runId: string,
  emit: (event: RunEvent) => void,
  runners: Map<string, AgentRunner>,
  makeEngine: (agentId: string) => EngineLike,
  sessions: Map<string, SubSession>,
): ToolDef {
  return {
    name: "dispatch_task",
    description:
      "Hand a work order to a sub-agent. The first dispatch to a slot opens its session; every later dispatch to the same slot is a follow-up in that same context — use it to continue work already owned by that agent. A new session needs `deliverable`: what must be true when it reports back. Never dispatch a single read/list/grep you can do yourself, and never dispatch one tool call per task: one brief should cover a meaningful, verifiable step.",
    parameters: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description: `Sub-agent label or slot id. Available: ${profile.subAgents.map((s, i) => `${s.label || s.id} (slot ${i + 1})`).join(", ")}`,
        },
        task: {
          type: "string",
          description:
            "The complete, self-contained work order. May cover several related steps; state constraints, paths, and how the result will be checked.",
        },
        deliverable: {
          type: "string",
          description:
            "Required when opening a NEW session: the condition that must be true when the agent reports back (e.g. \"tests pass and the CLI exits 0\"). Ignored on follow-ups.",
        },
      },
      required: ["agent", "task"],
    },
    risky: true,
    execute: async (args, ctx: ToolContext) => {
      const wanted = String(args.agent || "").toLowerCase();
      const sub = profile.subAgents.find(
        (s, i) => s.label?.toLowerCase() === wanted || s.id.toLowerCase() === wanted || `slot ${i + 1}` === wanted,
      );
      if (!sub) {
        return { ok: false, output: `No sub-agent matching "${wanted}". Available: ${profile.subAgents.map((s) => s.label || s.id).join(", ")}` };
      }

      const task = String(args.task || "").trim();
      if (!task) return { ok: false, output: "dispatch_task needs a task." };
      const deliverable = String(args.deliverable || "").trim();
      const childId = `sub-${sub.id}`;
      const label = sub.label || sub.id;

      const existing = sessions.get(childId);
      if (existing?.runner.isKilled) {
        return { ok: false, output: `Sub-agent ${label} was killed by supervision and cannot run again.` };
      }
      if (existing?.runner.isBusy) {
        return { ok: false, output: `Sub-agent ${label} is still running its previous task; wait for its report before dispatching again.` };
      }

      let session = existing;
      let mode: "new" | "follow-up" = "follow-up";

      if (!session) {
        // The asymmetry is deliberate: continuing an agent is cheap and
        // needs no ceremony; opening one re-sends a whole project context,
        // so it must be justified by an outcome.
        if (deliverable.length < 8) {
          return {
            ok: false,
            output:
              "Starting a new sub-agent costs a fresh context. Pass `deliverable`: what must be true when it reports back. " +
              `If work for ${label} already exists, send a follow-up to that session instead (no deliverable needed).`,
          };
        }
        mode = "new";
        emit({
          type: "agent-started",
          agentId: childId,
          role: "sub",
          label,
          model: sub.model,
          at: Date.now(),
        });

        const engine = makeEngine(childId);
        const child = new AgentRunner({
          agentId: childId,
          role: "sub",
          label,
          provider: { kind: sub.kind, baseUrl: sub.baseUrl, model: sub.model, apiKey: sub.apiKey },
          runId,
          workspace: ctx.workspace,
          baseSystem: subAgentSystem(profile),
          hooks: {
            emit,
            beforeTurn: (runner, turn) => engine.beforeTurn(runner, turn),
            onToolOutput: (agentId, tool, output) => engine.recallStore.append(agentId, `tool-output:${tool}`, output),
          },
          extraTools: [ledgerTool(engine.ledgerStore), recallTool(engine.recallStore)],
          timeLine: () => ({ remaining: "plenty (parent budget)", pausedNote: "" }),
          deadlineLocal: "parent-managed",
          maxTurns: 60,
        });
        session = { runner: child, engine, dispatches: 0 };
        sessions.set(childId, session);
        runners.set(childId, child);
      } else {
        emit({
          type: "agent-status",
          agentId: childId,
          status: "running",
          note: `follow-up #${session.dispatches + 1} · ${session.runner.messageCount} messages kept`,
          at: Date.now(),
        });
      }

      session.dispatches++;
      const brief =
        mode === "new" && deliverable
          ? `${task}\n\nDeliverable (must be true when you report back): ${deliverable}`
          : task;
      const msgsBefore = session.runner.messageCount;
      const tokensBefore = session.runner.spentTokens;

      const report = await session.runner.run(brief);

      const spent = session.runner.spentTokens - tokensBefore;
      if (!session.runner.isKilled) {
        emit({
          type: "agent-status",
          agentId: childId,
          status: "done",
          note: `reported back · ${session.dispatches} dispatch${session.dispatches === 1 ? "" : "es"} · +${spent} tok`,
          at: Date.now(),
        });
      }

      const receipt =
        mode === "new"
          ? `[${label} · session opened · ${msgsBefore} messages of prior context · +${spent} tok]`
          : `[${label} · follow-up #${session.dispatches} · ${msgsBefore} messages of prior context · +${spent} tok]`;
      return { ok: !session.runner.isKilled, output: `${receipt}\n${report}` };
    },
  };
}

export function subAgentSystem(profile: ProfileConfig): string {
  const forbidden = profile.forbidden.map((l) => `- ${l}`).join("\n") || "- (none listed)";
  return `You are a SUB-AGENT of an Unlimited run: the hands of the crew. The worker plans and verifies; you execute.

# PROJECT
Workspace (work only inside it): ${profile.workspace}
Goal of the whole project:
${profile.goal}

# HARD RULES — never violate
${forbidden}

# SESSION
- You may receive follow-up messages from the worker in this same conversation. Your context persists: build on what you already did instead of re-reading the project.
- You are one dispatch deep: do not delegate further.
- If a follow-up contradicts earlier work, say so plainly before changing it.

# STYLE
- Execute the work order with your tools; verify what you did.
- End each dispatch with a compact report: what you did, what you verified, what you could not do and why.
- Do not invent completed work.`;
}
