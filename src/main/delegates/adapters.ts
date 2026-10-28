/**
 * Delegate CLI adapters — one headless prompt per external agent CLI.
 *
 * Every adapter spawns its binary (resolved by name; keep in sync with the
 * BINS map in ./health.ts) with `cwd = opts.workspace` and never throws:
 * missing binary, timeout, abort and non-zero exits all resolve with whatever
 * output was collected.
 *
 * Verified headless invocations (researched 2026-10-28) — see the comment
 * above each case in `adapterFor` for sources and deliberate omissions.
 */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import type { DelegateKind } from "../../shared/types.js";
import type { DelegateOutcome, DelegateRun } from "./types.js";

export interface DelegateAdapter {
  kind: DelegateKind;
  /** Run one headless prompt. Streams output via opts.onOutput, resolves with final text. */
  run(opts: DelegateRun): Promise<DelegateOutcome>;
}

// ---- Timing policy ----

/** Default wall-clock budget for one delegation: 10 minutes. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** Hard ceiling no run may exceed: 30 minutes. */
const HARD_CAP_MS = 30 * 60_000;
/** SIGTERM, then this grace period, then SIGKILL. */
const KILL_GRACE_MS = 5_000;

// ---- Retention policy ----

/** First N chars of combined output kept verbatim. */
const RETAIN_HEAD = 90_000;
/** Last N chars of combined output kept verbatim once the head is full. */
const RETAIN_TAIL = 10_000;

/** Prefix marking stderr lines in the collected text. */
const STDERR_PREFIX = "[stderr] ";

/** The headless binary behind each delegate kind (mirrors health.ts BINS). */
const BINS: Record<DelegateKind, string> = {
  opencode: "opencode",
  "claude-code": "claude",
  codex: "codex",
  kimi: "kimi",
};

/**
 * Verified non-interactive invocation per CLI. The prompt is always passed as
 * a spawn argument (never through a shell), so no quoting/injection issues.
 */
function invocationFor(kind: DelegateKind, prompt: string): { command: string; args: string[] } {
  const command = BINS[kind];
  switch (kind) {
    case "opencode":
      return { command, args: ["run", prompt] };
    case "claude-code":
      return { command, args: ["-p", prompt, "--output-format", "text"] };
    case "codex":
      return { command, args: ["exec", "--skip-git-repo-check", prompt] };
    case "kimi":
      return { command, args: ["-p", prompt] };
  }
}

/**
 * Rolling buffer that keeps the first RETAIN_HEAD chars and the last
 * RETAIN_TAIL chars of the combined output, eliding the middle once the
 * total passes 100k chars.
 */
interface CappedBuffer {
  push(chunk: string): void;
  text(): string;
}

function createCappedBuffer(): CappedBuffer {
  let head = "";
  let tail = "";
  let total = 0;
  return {
    push(chunk: string): void {
      if (!chunk) return;
      total += chunk.length;
      if (head.length < RETAIN_HEAD) {
        head += chunk.slice(0, RETAIN_HEAD - head.length);
      }
      // `total > head.length` iff part of the stream overflowed the head
      // window; that overflow competes for the tail window.
      if (total > head.length) {
        tail = (tail + chunk).slice(-RETAIN_TAIL);
      }
    },
    text(): string {
      const elided = total - head.length - tail.length;
      if (elided <= 0) return head + tail;
      return `${head}\n[… ${elided} chars of delegate output elided …]\n${tail}`;
    },
  };
}

/**
 * SIGTERM the child, then SIGKILL after the grace period. The escalation
 * timer is unref'd so a dead child never keeps the process alive.
 */
function terminate(child: ReturnType<typeof spawn>): void {
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
  killTimer.unref();
}

/**
 * Shared headless runner. Resolution contract (never rejects):
 * - success/failure: exitCode from the `close` event, text = combined output;
 * - timeout: SIGTERM → 5s → SIGKILL, `timedOut: true`, partial text;
 * - abort (opts.signal): same kill sequence, `timedOut: false`, exitCode null;
 * - spawn ENOENT: explanatory text, exitCode null.
 */
function runHeadless(kind: DelegateKind, opts: DelegateRun): Promise<DelegateOutcome> {
  return new Promise<DelegateOutcome>((resolve) => {
    const { command, args } = invocationFor(kind, opts.prompt);
    // DelegateRun carries no timeout field (locked contract), so every run
    // gets the default; the hard cap still bounds anything future callers pass.
    const timeoutMs = Math.min(DEFAULT_TIMEOUT_MS, HARD_CAP_MS);

    const buffer = createCappedBuffer();
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    // Incomplete trailing stderr line; the "[stderr] " marker is applied to
    // whole lines even though chunks arrive in arbitrary slices.
    let stderrPending = "";

    let settled = false;
    let aborted = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;

    const child = spawn(command, args, {
      cwd: opts.workspace,
      // stdin closed so no CLI ever blocks waiting for interactive input.
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const onAbort = (): void => {
      if (settled) return;
      aborted = true;
      terminate(child);
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });

    const finish = (outcome: DelegateOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };

    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      terminate(child);
    }, timeoutMs);

    // Handle a signal that fired before/while the child was starting.
    if (opts.signal.aborted) onAbort();

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = stdoutDecoder.write(chunk);
      if (!text) return;
      buffer.push(text);
      opts.onOutput?.(text);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = stderrDecoder.write(chunk);
      if (!text) return;
      stderrPending += text;
      const lines = stderrPending.split("\n");
      stderrPending = lines.pop() ?? ""; // last piece may be an incomplete line
      if (lines.length > 0) {
        const marked = STDERR_PREFIX + lines.join(`\n${STDERR_PREFIX}`) + "\n";
        buffer.push(marked);
        opts.onOutput?.(marked);
      }
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        finish({
          text: `(delegate CLI not installed: ${command})`,
          exitCode: null,
          timedOut: false,
        });
        return;
      }
      // Other spawn failures (permissions, bad cwd, …) — resolve, never throw.
      finish({
        text: `(delegate CLI failed to start: ${command}: ${err.message})`,
        exitCode: null,
        timedOut: false,
      });
    });

    child.on("close", (code) => {
      // Flush any trailing stderr line that never saw a newline.
      if (stderrPending) {
        const marked = `${STDERR_PREFIX}${stderrPending}\n`;
        stderrPending = "";
        buffer.push(marked);
        opts.onOutput?.(marked);
      }
      if (aborted) {
        // Abort resolves with partial text, not a timeout, and no exit code.
        finish({ text: buffer.text(), exitCode: null, timedOut: false });
        return;
      }
      finish({ text: buffer.text(), exitCode: code, timedOut });
    });
  });
}

/**
 * Adapter registry.
 *
 * Verified headless invocations, one comment block per delegate kind.
 * Permission/auto-approve flags are deliberately NOT passed anywhere: a
 * delegate that silently runs with blanket approvals is an orchestrator
 * hazard. If unattended write access is wanted, add it explicitly per kind
 * (flags named in each comment below) at the orchestrator layer.
 */
export function adapterFor(kind: DelegateKind): DelegateAdapter {
  switch (kind) {
    case "opencode":
      return {
        kind,
        // Verified: `opencode run "<prompt>"` — OpenCode's non-interactive
        // mode; "Sends a message and prints the reply without opening the
        // interactive interface", plain-text reply on stdout.
        //   https://opencode.ai/docs/cli ("run — Run opencode in non-interactive
        //   mode by passing a prompt directly")
        //   https://opencode.ai/v2/docs/cli/commands ("run: Sends a message and
        //   prints the reply without opening the interactive interface")
        // cwd: no CLI flag needed for `run`; the spawn cwd (opts.workspace)
        // selects the project, matching how `opencode <path>` behaves.
        // Not passed: `--auto` ("auto-approve permissions that are not
        // explicitly denied") — left to the orchestrator layer.
        run: (opts) => runHeadless(kind, opts),
      };

    case "claude-code":
      return {
        kind,
        // Verified: `claude -p "<prompt>" --output-format text` — Claude Code
        // print (headless) mode; exits 0 on success, non-zero on failure.
        //   https://code.claude.com/docs/en/headless ("Add the `-p` (or
        //   `--print`) flag to any claude command to run it non-interactively";
        //   "--output-format … text (default): plain text output" — passed
        //   explicitly here so user settings can't flip it to json/stream-json)
        // cwd: the spawn cwd (opts.workspace) is the session's working
        // directory; print mode has no separate cwd flag.
        // Not passed: `--allowedTools` / `--permission-mode` / `--bare`. In
        // print mode, tool calls that would prompt are denied rather than
        // hanging, which is the safe unattended default.
        run: (opts) => runHeadless(kind, opts),
      };

    case "codex":
      return {
        kind,
        // Verified: `codex exec --skip-git-repo-check "<prompt>"` — Codex
        // non-interactive mode; final agent message on stdout, progress on
        // stderr.
        //   https://developers.openai.com/codex/non-interactive-mode
        //   ("Non-interactive mode lets you run Codex from scripts … You
        //   invoke it with `codex exec`"; "Pass a task prompt as a single
        //   argument"; "Codex requires commands to run inside a Git repository
        //   … Override this check with `codex exec --skip-git-repo-check`")
        // `--skip-git-repo-check` is included because a profile's workspace is
        // an arbitrary user-picked directory and may not be a git repo.
        // cwd: the spawn cwd (opts.workspace) selects the workspace.
        // Not passed: `--sandbox workspace-write` (exec defaults to a
        // read-only sandbox; `--full-auto` is no longer supported) — writing
        // is a policy decision for the orchestrator layer, not the adapter.
        run: (opts) => runHeadless(kind, opts),
      };

    case "kimi":
      return {
        kind,
        // Verified: `kimi -p "<prompt>"` — Kimi Code CLI single-instruction
        // (non-interactive) invocation.
        //   https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html
        //   ("To run a single instruction without entering the interactive
        //   UI, use `-p`: kimi -p \"Take a look at this project's directory
        //   structure\"")
        // Corroborated by MoonshotAI/kimi-cli Discussion #932 (non-interactive
        // `--print` mode; `--output-format text` is the default) and headless
        // walkthroughs using `kimi -w <dir> -p "<prompt>"` with `--quiet`.
        // cwd: the spawn cwd (opts.workspace) is used instead of the `-w`
        // work-dir flag; plain-text output is the `-p` default, so no extra
        // output-format flag is passed.
        // Optional flags seen in the wild (`--quiet`, `--final-message-only`,
        // `--output-format stream-json`) are intentionally omitted until their
        // semantics are pinned against a pinned kimi version.
        run: (opts) => runHeadless(kind, opts),
      };
  }
}
