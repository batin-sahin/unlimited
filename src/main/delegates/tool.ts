import type { ProfileConfig, RunEvent } from "../../shared/types.js";
import { adapterFor } from "./adapters.js";
import type { ToolContext, ToolDef } from "../agents/tools/types.js";

/**
 * ask_delegate — when the user configured a delegate CLI, the worker drives
 * it with prompts; the CLI does the hands-on work, we integrate the answer.
 */
export function askDelegateTool(
  profile: ProfileConfig,
  _runId: string,
  emit: (event: RunEvent) => void,
): ToolDef {
  const adapter = adapterFor(profile.delegate!.kind);
  return {
    name: "ask_delegate",
    description: `Hand a prompt to the delegated external agent CLI (${profile.delegate!.kind}) and get its response. Use it for the work the user delegated to this CLI; break big work into multiple prompts.`,
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Complete, self-contained instruction for the delegated CLI." },
      },
      required: ["prompt"],
    },
    risky: true,
    execute: async (args, ctx: ToolContext) => {
      const prompt = String(args.prompt || "");
      if (!prompt) return { ok: false, output: "ask_delegate needs a non-empty prompt." };

      const delegateSystem = profile.delegate!.instructions
        ? `Standing instructions from the user for this CLI: ${profile.delegate!.instructions}\n\n`
        : "";
      const outcome = await adapter.run({
        prompt: `${delegateSystem}${prompt}`,
        workspace: ctx.workspace,
        signal: AbortSignal.timeout(30 * 60_000),
      });

      emit({
        type: "agent-status",
        agentId: `delegate-${profile.delegate!.kind}`,
        status: "running",
        note: `delegate answered (exit ${outcome.exitCode ?? "n/a"}${outcome.timedOut ? ", timed out" : ""})`,
        at: Date.now(),
      });

      const text = outcome.text.trim() || "(the CLI returned no output)";
      return {
        ok: !outcome.timedOut && (outcome.exitCode == null || outcome.exitCode === 0),
        output: text,
      };
    },
  };
}
