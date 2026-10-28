import type { ProfileConfig, RunEvent } from "../../shared/types.js";
import { AgentRunner } from "./runner.js";
import type { ToolContext, ToolDef } from "./tools/types.js";

/**
 * dispatch_task — the worker's coordination power: hand a clearly scoped
 * task to one configured sub-agent (its own provider/model/key). The child
 * runs the same tool registry minus coordination powers, in the same
 * workspace, and its report comes back as the tool result.
 */
export function dispatchTool(
  profile: ProfileConfig,
  runId: string,
  emit: (event: RunEvent) => void,
  runners: Map<string, AgentRunner>,
): ToolDef {
  return {
    name: "dispatch_task",
    description:
      "Delegate a clearly scoped task to a sub-agent. It works in the same workspace with its own provider and returns a report. Use focused tasks; demand compact reports.",
    parameters: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description: `Sub-agent label or slot id. Available: ${profile.subAgents.map((s, i) => `${s.label || s.id} (slot ${i + 1})`).join(", ")}`,
        },
        task: { type: "string", description: "The complete, self-contained task for the sub-agent." },
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

      const childId = `sub-${sub.id}`;
      const existing = runners.get(childId);
      if (existing?.isKilled) {
        return { ok: false, output: `Sub-agent ${sub.label || sub.id} was killed by supervision and cannot run again.` };
      }

      emit({
        type: "agent-started",
        agentId: childId,
        role: "sub",
        label: sub.label || sub.id,
        model: sub.model,
        at: Date.now(),
      });

      const child = new AgentRunner({
        agentId: childId,
        role: "sub",
        label: sub.label || sub.id,
        provider: { kind: sub.kind, baseUrl: sub.baseUrl, model: sub.model, apiKey: sub.apiKey },
        runId,
        workspace: ctx.workspace,
        baseSystem: subAgentSystem(profile),
        hooks: { emit },
        timeLine: () => ({ remaining: "plenty (parent budget)", pausedNote: "" }),
        deadlineLocal: "parent-managed",
        maxTurns: 60,
      });
      runners.set(childId, child);

      const report = await child.run(String(args.task || "(no task given)"));
      return { ok: !child.isKilled, output: report };
    },
  };
}

export function subAgentSystem(profile: ProfileConfig): string {
  const forbidden = profile.forbidden.map((l) => `- ${l}`).join("\n") || "- (none listed)";
  return `You are a SUB-AGENT of an Unlimited run. You were spawned by the worker agent to execute one scoped task.

# PROJECT
Workspace (work only inside it): ${profile.workspace}
Goal of the whole project:
${profile.goal}

# HARD RULES — never violate
${forbidden}

# STYLE
- Execute the task given to you with your tools; verify what you did.
- End with a compact report: what you did, what you verified, what you could not do and why.
- You are one task deep: do not delegate further.`;
}
