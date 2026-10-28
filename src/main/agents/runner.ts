import type { AgentRole, ProviderConfig, RunEvent } from "../../shared/types.js";
import type { ChatMessage, ProviderStreamHandlers, ProviderStreamResult } from "../providers/types.js";
import { streamProvider } from "../providers/index.js";
import { CONTINUE_NUDGE, turnHeader } from "./prompts.js";
import { TurnWatchdog, TURN_WATCHDOG_MS } from "./watchdog.js";
import { allTools, getTool } from "./tools/index.js";
import type { ToolContext, ToolDef } from "./tools/types.js";

const REPORT_DONE_SPEC = {
  name: "report_done",
  description:
    "End the run. Call this only when the work is complete or truly blocked — always after writing your final summary.",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string", description: "Final state summary: done, in progress, remaining, warnings." },
    },
    required: ["summary"],
  },
};

export interface RunnerHooks {
  emit(event: RunEvent): void;
  /** Compaction seam — the engine rewrites messages before each turn. */
  beforeTurn?(runner: AgentRunner, turn: number): Promise<void>;
  /** Full tool outputs stream to the cold store for later recall. */
  onToolOutput?(agentId: string, tool: string, output: string): void;
}

export interface RunnerOptions {
  agentId: string;
  role: AgentRole;
  label: string;
  provider: ProviderConfig;
  runId: string;
  workspace: string;
  /** Pinned system block; the runner appends fresh turn headers. */
  baseSystem: string;
  /** Extra tool names to offer beyond the registry (report_done is always added). */
  extraToolSpecs?: { name: string; description: string; parameters: Record<string, unknown> }[];
  /** Per-run executable tools (dispatch_task, ask_delegate) — offered AND executed. */
  extraTools?: ToolDef[];
  /** When set, only these registry tool names are offered/executable. */
  allowedTools?: string[];
  maxTurns?: number;
  hooks: RunnerHooks;
  /** Fresh remaining-time line for every turn. */
  timeLine: () => { remaining: string; pausedNote: string };
  deadlineLocal: string;
}

interface QueuedText {
  text: string;
  timer: NodeJS.Timeout | null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

/**
 * One autonomous agent loop: turn taking, tool execution, retry with
 * backoff, kill-ability, and the report_done exit. Provider-agnostic.
 */
export class AgentRunner {
  messages: ChatMessage[] = [];
  usage = { input: 0, output: 0 };
  private controller = new AbortController();
  private turn = 0;
  private running = false;
  private killed = false;
  private killReason = "";
  private done = false;
  private finalSummary = "";
  private textQueue: QueuedText = { text: "", timer: null };

  constructor(private opts: RunnerOptions) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get systemBlock(): string {
    return this.opts.baseSystem;
  }

  get isKilled(): boolean {
    return this.killed;
  }

  /** True while a run() invocation is inside its loop. */
  get isBusy(): boolean {
    return this.running;
  }

  /** Messages held in this agent's live context (session size). */
  get messageCount(): number {
    return this.messages.length;
  }

  /** Tokens spent by this agent so far, input + output. */
  get spentTokens(): number {
    return this.usage.input + this.usage.output;
  }

  get finishReason(): string {
    return this.done ? this.finalSummary : this.killed ? `killed: ${this.killReason}` : "max-turns";
  }

  /** Orchestrator/supervisor entry: inject a message into the loop. */
  push(role: ChatMessage["role"], content: string): void {
    this.messages.push({ role, content });
  }

  kill(reason: string): void {
    if (this.killed || this.done) return;
    this.killed = true;
    this.killReason = reason;
    this.controller.abort();
    this.flushText();
  }

  /**
   * Run the loop until done/killed/budget. Resolves with the final summary.
   * A runner is a SESSION, not a single shot: calling run() again continues
   * the same conversation, so follow-up briefs land in a context that
   * already knows the work. A fresh context costs a whole re-read of the
   * project; continuation is what keeps a long run cheap.
   */
  async run(task: string): Promise<string> {
    if (this.killed) return `KILLED: ${this.killReason}`;
    if (this.running) throw new Error(`agent ${this.opts.agentId} is already running`);
    this.running = true;
    // A previous report_done ended that dispatch, not the session.
    this.done = false;
    this.finalSummary = "";
    try {
      return await this.loop(task);
    } finally {
      this.running = false;
    }
  }

  private async loop(task: string): Promise<string> {
    this.messages.push({ role: "user", content: task });
    const startTurn = this.turn;
    const tools = allTools().filter((t) => !this.opts.allowedTools || this.opts.allowedTools.includes(t.name));
    const specs = [
      ...tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
      ...(this.opts.extraTools || []).map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
      ...(this.opts.extraToolSpecs || []),
      REPORT_DONE_SPEC,
    ];

    while (!this.killed && !this.done) {
      // maxTurns is a per-dispatch allowance, not a lifetime cap.
      if (this.opts.maxTurns && this.turn - startTurn >= this.opts.maxTurns) break;
      this.turn++;
      await this.opts.hooks.beforeTurn?.(this, this.turn);

      const { remaining, pausedNote } = this.opts.timeLine();
      const system = `${this.opts.baseSystem}\n\n${turnHeader(this.turn, remaining, pausedNote)}`;

      let result: ProviderStreamResult;
      try {
        result = await this.callWithRetry(
          {
            kind: this.opts.provider.kind,
            name: `${this.opts.label}/${this.opts.provider.model}`,
            baseUrl: this.opts.provider.baseUrl,
            model: this.opts.provider.model,
            apiKey: this.opts.provider.apiKey,
            system,
            messages: this.messages,
            tools: specs,
            signal: this.controller.signal,
          },
          this.handlers(),
        );
      } catch (err: any) {
        if (this.killed || this.controller.signal.aborted) break;
        throw err;
      }

      this.usage.input += result.usage.input;
      this.usage.output += result.usage.output;

      let toolCalls = result.toolCalls;
      if (toolCalls.length) {
        this.messages.push({
          role: "assistant",
          content: result.text,
          toolCalls,
        });
      } else {
        this.messages.push({ role: "assistant", content: result.text });
      }
      this.flushText();

      if (!toolCalls.length) {
        // A no-tool turn is not an exit in a days-long run: nudge and continue.
        this.messages.push({ role: "user", content: CONTINUE_NUDGE });
        continue;
      }

      for (const call of toolCalls) {
        if (this.killed || this.done) break;
        if (call.name === REPORT_DONE_SPEC.name) {
          let parsed: any = {};
          try {
            parsed = JSON.parse(call.arguments || "{}");
          } catch {
            parsed = {};
          }
          this.finalSummary = String(parsed.summary || "(no summary)");
          this.done = true;
          break;
        }

        await this.executeTool(call.id, call.name, call.arguments);
      }
    }

    this.flushText();
    return this.done ? this.finalSummary : this.killed ? `KILLED: ${this.killReason}` : "stopped: max turns";
  }
  private async executeTool(callId: string, name: string, rawArgs: string): Promise<void> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(rawArgs || "{}");
    } catch {
      // fall through with empty args; the tool reports the problem
    }

    this.opts.hooks.emit({
      type: "tool-call",
      agentId: this.opts.agentId,
      callId,
      tool: name,
      args,
      summary: summarizeSafe(name, args),
      at: Date.now(),
    });

    const tool = this.extraTool(name) ?? getTool(name);
    if (this.opts.allowedTools && !this.extraTool(name) && !this.opts.allowedTools.includes(name)) {
      this.opts.hooks.emit({
        type: "tool-result",
        agentId: this.opts.agentId,
        callId,
        ok: false,
        outputHead: `Tool ${name} is not available to this agent.`,
        outputTail: "",
        elidedTokens: 0,
        at: Date.now(),
      });
      this.messages.push({ role: "tool", toolCallId: callId, toolName: name, content: `Tool ${name} is not available to this agent.` });
      return;
    }
    const ctx: ToolContext = {
      workspace: this.opts.workspace,
      runId: this.opts.runId,
      agentId: this.opts.agentId,
    };
    let ok = false;
    let output = "";
    try {
      const result = tool ? await tool.execute(args, ctx) : { ok: false, output: `Unknown tool: ${name}` };
      ok = result.ok;
      output = result.output;
    } catch (err: any) {
      ok = false;
      output = `Tool error: ${err?.message || err}`;
    }

    this.opts.hooks.emit({
      type: "tool-result",
      agentId: this.opts.agentId,
      callId,
      ok,
      outputHead: output.slice(0, 2000),
      outputTail: output.length > 2500 ? output.slice(-500) : "",
      elidedTokens: 0,
      at: Date.now(),
    });
    // Full output lands in the cold store before any elision — the promise
    // in the elision marker is kept here.
    this.opts.hooks.onToolOutput?.(this.opts.agentId, name, output);
    this.messages.push({ role: "tool", toolCallId: callId, toolName: name, content: output });
  }

  /** Per-run tools (dispatch_task, ask_delegate) win over the global registry. */
  private extraTool(name: string): ToolDef | undefined {
    return this.opts.extraTools?.find((t) => t.name === name);
  }

  /**
   * 429/5xx/network backoff. Honors Retry-After; gives up after 8 tries.
   * A per-attempt watchdog aborts silent provider connections (a stalled
   * stream is a dead link, not a thinking model) and the loop retries.
   */
  private async callWithRetry(
    req: Parameters<typeof streamProvider>[0],
    handlers: ProviderStreamHandlers,
  ): Promise<ProviderStreamResult> {
    let attempt = 0;
    for (;;) {
      let watchdogFired = false;
      // Attempt-scoped abort: the watchdog (or the runner's kill) cancels
      // just this attempt; the run itself survives and retries.
      const attemptController = new AbortController();
      const onRunnerAbort = () => attemptController.abort();
      this.controller.signal.addEventListener("abort", onRunnerAbort, { once: true });
      const watchdog = new TurnWatchdog({
        timeoutMs: TURN_WATCHDOG_MS,
        onTimeout: () => {
          watchdogFired = true;
          attemptController.abort();
        },
      });
      const fed: ProviderStreamHandlers = {
        onText: (piece) => {
          watchdog.feed();
          handlers.onText?.(piece);
        },
        onReasoning: (piece) => {
          watchdog.feed();
          handlers.onReasoning?.(piece);
        },
      };
      try {
        return await streamProvider({ ...req, signal: attemptController.signal }, fed);
      } catch (err: any) {
        if (this.controller.signal.aborted) throw err;
        const message = String(err?.message || err);
        const status = Number(/\s(\d{3}):\s/.exec(message)?.[1] || 0);
        const retryable =
          watchdogFired ||
          status === 429 ||
          status === 408 ||
          (status >= 500 && status < 600) ||
          /fetch failed|network|ECONN|ETIMEDOUT|socket|rate limit/i.test(message);
        if (!retryable || attempt >= 8) throw err;
        const retryAfter = Number(/retry-after:\s*(\d+)/i.exec(message)?.[1] || 0);
        const delay = retryAfter
          ? Math.min(retryAfter * 1000, 120_000)
          : Math.min(1000 * 2 ** attempt + Math.random() * 1000, 120_000);
        await sleep(delay, this.controller.signal);
        attempt++;
      } finally {
        // Runs whether the attempt succeeded, failed, or was watchdog-killed.
        watchdog.dispose();
        this.controller.signal.removeEventListener("abort", onRunnerAbort);
      }
    }
  }

  /** Coalesced streaming: batch text deltas into ~300ms feed events. */
  private handlers(): ProviderStreamHandlers {
    return {
      onText: (piece) => {
        this.textQueue.text += piece;
        if (!this.textQueue.timer) {
          this.textQueue.timer = setTimeout(() => this.flushText(), 300);
          this.textQueue.timer.unref?.();
        }
      },
    };
  }

  private flushText(): void {
    if (this.textQueue.timer) {
      clearTimeout(this.textQueue.timer);
      this.textQueue.timer = null;
    }
    if (this.textQueue.text) {
      this.opts.hooks.emit({ type: "agent-text", agentId: this.opts.agentId, text: this.textQueue.text, at: Date.now() });
      this.textQueue.text = "";
    }
  }
}

function summarizeSafe(tool: string, args: Record<string, unknown>): string {
  if (tool === "terminal") return String(args.command || "").slice(0, 120);
  if (tool === "read_file") return String(args.path || "");
  if (tool === "write_file") return `${String(args.path || "")} (${String(args.content || "").length} bytes)`;
  return JSON.stringify(args).slice(0, 120);
}
