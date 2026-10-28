/** Tool contract for the agent runner (Faz 2). */

export interface ToolContext {
  /** Absolute workspace root; tools must never escape it. */
  workspace: string;
  runId: string;
  agentId: string;
}

export interface ToolResult {
  ok: boolean;
  /** Full output. The runner reports it, the compaction engine may elide it. */
  output: string;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the model's tool call. */
  parameters: Record<string, unknown>;
  /**
   * Risky tools get supervisor attention and are named in the forbidden-list
   * check. Writes and command execution are risky; reads are not.
   */
  risky?: boolean;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Summarize a tool call for the event feed (one line, no secrets). */
export function summarizeCall(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "terminal":
      return String(args.command || "").slice(0, 120);
    case "read_file":
      return String(args.path || "");
    case "write_file":
      return `${String(args.path || "")} (${String(args.content || "").length} bytes)`;
    case "edit_file":
      return String(args.path || "");
    case "list_dir":
      return String(args.path || ".");
    case "glob":
      return String(args.pattern || "");
    case "grep":
      return `${String(args.pattern || "")} in ${String(args.path || ".")}`;
    default:
      return JSON.stringify(args).slice(0, 120);
  }
}
