import type { ToolDef } from "./types.js";

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
