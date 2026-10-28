/**
 * Terminal tool: run shell commands inside the workspace.
 * The cwd is confined to the workspace (symlinks included); output is
 * head/tail capped so a chatty command can never blow up the context.
 * The tool catches its own errors and reports ToolResult, never throws.
 */
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { registerTool } from "./index.js";
import type { ToolContext, ToolDef, ToolResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MIN_TIMEOUT_MS = 1_000;
const KILL_GRACE_MS = 5_000; // SIGTERM → SIGKILL
const OUT_CAP = 20_000;
const OUT_HEAD = 15_000;
const OUT_TAIL = 5_000;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when a workspace-relative path climbs above the root. */
function escapesRel(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

const terminalTool: ToolDef = {
  name: "terminal",
  description:
    "Run a shell command (bash -lc) inside the workspace. Use it for builds, tests, git, package managers, and environment inspection; prefer the file tools for reading and editing files. Relative cwd resolves against the workspace. stdout and stderr are interleaved (stderr lines prefixed err|); output is capped. The exit code is appended as [exit N] when nonzero.",
  risky: true,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute." },
      cwd: {
        type: "string",
        description: "Working directory, absolute or relative to the workspace (default: workspace root).",
      },
      timeoutMs: {
        type: "number",
        description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}). On timeout the process gets SIGTERM, then SIGKILL.`,
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command) return { ok: false, output: "Error: empty command." };

    const cwdInput = typeof args.cwd === "string" ? args.cwd.trim() : "";
    const cwd = cwdInput ? path.resolve(ctx.workspace, cwdInput) : ctx.workspace;
    if (escapesRel(path.relative(ctx.workspace, cwd))) {
      return { ok: false, output: `Error: cwd escapes the workspace: ${cwdInput}` };
    }
    try {
      const cwdReal = await fsp.realpath(cwd);
      if (escapesRel(path.relative(await fsp.realpath(ctx.workspace), cwdReal))) {
        return { ok: false, output: `Error: cwd escapes the workspace through a symlink: ${cwdInput}` };
      }
      if (!(await fsp.stat(cwdReal)).isDirectory()) {
        return { ok: false, output: `Error: cwd is not a directory: ${cwdInput}` };
      }
    } catch {
      return { ok: false, output: `Error: cwd does not exist: ${cwdInput || "."}` };
    }

    const requested = Number(args.timeoutMs);
    const timeoutMs =
      Number.isFinite(requested) && requested > 0
        ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(requested)))
        : DEFAULT_TIMEOUT_MS;

    return await new Promise<ToolResult>((resolve) => {
      const env = { ...process.env, TERM: "dumb", CI: process.env.CI || "1" };
      const isWin = process.platform === "win32";
      const child = isWin
        ? spawn(process.env.COMSPEC || "cmd.exe", ["/d", "/s", "/c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
        : spawn("bash", ["-lc", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });

      let buf = "";
      let head: string | null = null; // frozen first OUT_HEAD chars once output overflows
      let tail = "";
      let exited = false;
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;

      // Interleave stdout/stderr in arrival order, marking stderr lines.
      const push = (chunk: string, isErr: boolean) => {
        const text = isErr
          ? chunk
              .split("\n")
              .map((line) => (line ? `err| ${line}` : line))
              .join("\n")
          : chunk;
        if (head === null) {
          buf += text;
          if (buf.length > OUT_CAP) {
            head = buf.slice(0, OUT_HEAD);
            tail = buf.slice(-OUT_TAIL);
            buf = "";
          }
        } else {
          tail = (tail + text).slice(-OUT_TAIL);
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => push(chunk.toString("utf8"), false));
      child.stderr?.on("data", (chunk: Buffer) => push(chunk.toString("utf8"), true));

      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(killTimer);
      };
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      }, timeoutMs);

      child.on("error", (err) => {
        if (exited) return;
        exited = true;
        cleanup();
        resolve({ ok: false, output: `Error: failed to start command: ${errMsg(err)}` });
      });

      child.on("close", (code, signal) => {
        if (exited) return;
        exited = true;
        cleanup();
        const raw = (head === null ? buf : `${head}\n... (output truncated) ...\n${tail}`).replace(/\n+$/, "");
        let output = raw.length > 0 ? raw : "(no output)";
        if (timedOut) {
          output += `\n[timed out after ${Math.round(timeoutMs / 1000)}s]`;
        } else if (code !== 0) {
          output += code === null ? `\n[signal ${signal}]` : `\n[exit ${code}]`;
        }
        resolve({ ok: !timedOut && code === 0, output });
      });
    });
  },
};

// ---- registration (module scope) ----

registerTool(terminalTool);
