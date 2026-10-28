import type { ToolDef } from "./types.js";

/**
 * Inspection-only tool set. Orchestrators (worker, coordinators) plan and
 * verify with these; the hands that write files and run commands are the
 * sub-agents, so the orchestrator's context stays a plan instead of a
 * growing pile of code and command output.
 */
export const READ_ONLY_TOOL_NAMES = ["read_file", "list_dir", "glob", "grep"] as const;

/** Registry order is the order tools are offered to models. */
const registry: ToolDef[] = [];

export function registerTool(tool: ToolDef): void {
  if (registry.some((t) => t.name === tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
  registry.push(tool);
}

export function allTools(): ToolDef[] {
  return [...registry];
}

export function getTool(name: string): ToolDef | undefined {
  return registry.find((t) => t.name === name);
}
