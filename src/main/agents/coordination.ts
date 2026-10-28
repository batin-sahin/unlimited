import { MAX_COORDINATORS, type ProfileConfig, type RunEvent } from "../../shared/types.js";
import { AgentRunner } from "./runner.js";
import { dispatchTool, type SubSession } from "./dispatch.js";
import { ledgerTool, recallTool } from "../compaction/tools.js";
import { formatRemaining } from "../budget.js";
import type { EngineLike } from "../compaction/engine.js";
import { READ_ONLY_TOOL_NAMES } from "./tools/index.js";
import type { ToolContext, ToolDef } from "./tools/types.js";

/**
 * spawn_coordinator — the worker's relief valve: when the work outgrows it,
 * the worker spawns up to MAX_COORDINATORS coordinator helpers. Coordinators
 * organize and review: read-only tools + dispatch_task, never write/terminal.
 */
export function spawnCoordinatorTool(
  profile: ProfileConfig,
  runId: string,
  emit: (event: RunEvent) => void,
  runners: Map<string, AgentRunner>,
  makeEngine: (agentId: string) => EngineLike,
  sessions: Map<string, SubSession>,
  budgetRemainingMs: () => number,
): ToolDef {
  let spawned = 0;

  return {
    name: "spawn_coordinator",
    description:
      "Spawn a coordinator helper (max 2) to help you coordinate: it decomposes work, dispatches to sub-agents, and reviews results. Coordinators read and organize; they never write files or run commands. Give it a focused mission.",
    parameters: {
      type: "object",
      properties: {
        mission: { type: "string", description: "What this coordinator owns and how its reports should look." },
      },
      required: ["mission"],
    },
    risky: true,
    execute: async (args, ctx: ToolContext) => {
      if (spawned >= MAX_COORDINATORS) {
        return { ok: false, output: `Coordinator limit reached (${MAX_COORDINATORS}). Integrate their reports and keep dispatching.` };
      }
      const mission = String(args.mission || "").trim();
      if (!mission) return { ok: false, output: "spawn_coordinator needs a mission." };

      spawned++;
      const coordId = `coord-${spawned}`;

      emit({ type: "agent-started", agentId: coordId, role: "coordinator", label: `Coordinator ${spawned}`, model: profile.source.model, at: Date.now() });

      const engine = makeEngine(coordId);
      // Same session map as the worker: a coordinator continues the
      // sub-agent the worker already opened instead of spawning a twin.
      const dispatch = dispatchTool(profile, runId, emit, runners, makeEngine, sessions);
      const coordinator = new AgentRunner({
        agentId: coordId,
        role: "coordinator",
        label: `Coordinator ${spawned}`,
        provider: profile.source,
        runId,
        workspace: ctx.workspace,
        baseSystem: coordinatorSystem(profile, mission),
        hooks: {
          emit,
          beforeTurn: (runner, turn) => engine.beforeTurn(runner, turn),
          onToolOutput: (agentId, tool, output) => engine.recallStore.append(agentId, `tool-output:${tool}`, output),
        },
        extraTools: [
          dispatch,
          ledgerTool(engine.ledgerStore),
          recallTool(engine.recallStore),
        ],
        allowedTools: [...READ_ONLY_TOOL_NAMES],
        timeLine: () => ({
          remaining: formatRemaining(budgetRemainingMs()),
          pausedNote: "",
        }),
        deadlineLocal: "parent-managed",
        maxTurns: 80,
      });
      runners.set(coordId, coordinator);

      const report = await coordinator.run(`Your mission: ${mission}\n\nStart by reading what state exists (ledger of the worker is not visible to you — inspect the workspace), then decompose and dispatch.`);
      return { ok: !coordinator.isKilled, output: report };
    },
  };
}

function coordinatorSystem(profile: ProfileConfig, mission: string): string {
  const forbidden = profile.forbidden.map((l) => `- ${l}`).join("\n") || "- (none listed)";
  return `You are a COORDINATOR of an Unlimited run, spawned by the worker agent. You organize and review; you never write files and never run commands.

Your mission: ${mission}

# PROJECT
Workspace: ${profile.workspace}
Goal of the whole project:
${profile.goal}

# HARD RULES
${forbidden}
- You must not write files or run commands — your tools are read-only plus dispatch_task.
- Dispatch focused tasks to sub-agents, review their reports, re-dispatch what is incomplete.
- End with a compact report to the worker: what was dispatched, what came back, what is still open.`;
}

// Coordinator pool state lives in the closure above; nothing else exports.
