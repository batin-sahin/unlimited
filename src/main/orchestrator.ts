import type { AgentRole, ProfileConfig, RunEvent, RunEndReason } from "../shared/types.js";
import { budgetMs } from "../shared/types.js";
import { BudgetClock, formatRemaining } from "./budget.js";
import { Journal } from "./journal.js";
import { loadProfile } from "./profiles.js";
import { startPowerBlock, stopPowerBlock } from "./power.js";
import { AgentRunner } from "./agents/runner.js";
import { workerSystem, WRAP_UP_TASK } from "./agents/prompts.js";
import { readJournal } from "./journal-reader.js";
import { buildResumePlan, type ResumePlan } from "./resume/plan.js";
import { Supervisor } from "./supervisor/supervisor.js";
import { dispatchTool } from "./agents/dispatch.js";
import { spawnCoordinatorTool } from "./agents/coordination.js";
import { askDelegateTool } from "./delegates/tool.js";
import { checkDelegateHealth } from "./delegates/health.js";
import { CompactionEngine, type EngineLike } from "./compaction/engine.js";
import { ledgerTool, recallTool } from "./compaction/tools.js";
import "./agents/tools/files.js";
import "./agents/tools/terminal.js";

interface ActiveRun {
  runId: string;
  journal: Journal;
  budget: BudgetClock;
  worker: AgentRunner;
  recallStores: { close(): void }[];
  stopped: boolean;
}

function deadlineLocal(budget: BudgetClock): string {
  return new Date(Date.now() + budget.remainingMs()).toLocaleString();
}

/**
 * Owns the active run: worker loop, budget clock, journal, power block.
 * Supervisor verdicts (Faz 2.5), coordinator spawning, and delegate
 * adapters land on this spine.
 */
export class RunManager {
  private active: ActiveRun | null = null;

  constructor(private emitEvent: (event: RunEvent) => void) {}

  async startRun(profileId: string): Promise<{ runId: string }> {
    if (this.active) throw new Error("A run is already active. Panic or wait for it to end.");
    const profile = loadProfile(profileId);
    if (!profile) throw new Error(`Profile not found: ${profileId}`);
    this.validate(profile);
    return this.startRunInternal(profile, Math.random().toString(36).slice(2, 10), null);
  }

  /**
   * Resume an interrupted run: same runId, so the journal appends and the
   * per-agent ledger + cold store continue exactly where they stopped.
   * The budget carries on from the last journaled tick — crashing never
   * resets the clock.
   */
  async resumeRun(priorRunId: string): Promise<{ runId: string }> {
    if (this.active) throw new Error("A run is already active. Panic or wait for it to end.");
    const read = readJournal(priorRunId);
    const plan = buildResumePlan(read.events);
    if (!plan?.profileId) throw new Error(`Run ${priorRunId} has nothing to resume.`);
    if (plan.budgetRemainingMs <= 0) throw new Error(`Run ${priorRunId} has no budget left — start a fresh run instead.`);
    const profile = loadProfile(plan.profileId);
    if (!profile) throw new Error(`Profile "${plan.profileId}" (from the prior run) not found.`);
    return this.startRunInternal(profile, priorRunId, plan);
  }

  private async startRunInternal(
    profile: ProfileConfig,
    runId: string,
    resume: ResumePlan | null,
  ): Promise<{ runId: string }> {
    const journal = new Journal(runId);

    startPowerBlock();
    const budget = new BudgetClock(resume ? resume.budgetRemainingMs : budgetMs(profile.budget), profile.window);

    const emitBase = (event: RunEvent) => {
      journal.append(event);
      this.emitEvent(event);
    };

    const runnerMap = new Map<string, AgentRunner>();
    const supervisor = new Supervisor(profile, {
      emit: emitBase,
      runners: runnerMap,
      kill: (agentId, reason) => {
        runnerMap.get(agentId)?.kill(reason);
        emitBase({ type: "agent-status", agentId, status: "killed", note: reason, at: Date.now() });
      },
      warn: (agentId, reason) => {
        runnerMap
          .get(agentId)
          ?.push("user", `SUPERVISOR WARNING: ${reason} — correct course immediately. A repeat ends this agent.`);
        emitBase({ type: "agent-status", agentId, status: "warned", note: reason, at: Date.now() });
      },
    });
    // Every run event feeds the supervisor; verdicts flow back through emitBase.
    const emit = (event: RunEvent) => {
      emitBase(event);
      supervisor.observe(event);
    };

    const workerEngine = this.makeEngine(profile, runId, "worker", budget, emitBase);
    const recallStores: { close(): void }[] = [workerEngine.recallStore];
    const makeEngineFor = (agentId: string): EngineLike => {
      const engine = this.makeEngine(profile, runId, agentId, budget, emitBase);
      recallStores.push(engine.recallStore);
      return engine;
    };

    const worker = new AgentRunner({
      agentId: "worker",
      role: "worker",
      label: "Worker",
      provider: profile.source,
      runId,
      workspace: profile.workspace,
      baseSystem: workerSystem(profile, deadlineLocal(budget)),
      hooks: {
        emit,
        beforeTurn: (runner, turn) => workerEngine.beforeTurn(runner, turn),
        onToolOutput: (agentId, tool, output) =>
          workerEngine.recallStore.append(agentId, `tool-output:${tool}`, output),
      },
      extraTools: [
        dispatchTool(profile, runId, emit, runnerMap, makeEngineFor),
        spawnCoordinatorTool(profile, runId, emit, runnerMap, makeEngineFor, () => budget.remainingMs()),
        ledgerTool(workerEngine.ledgerStore),
        recallTool(workerEngine.recallStore),
        ...(profile.delegate ? [askDelegateTool(profile, runId, emit)] : []),
      ],
      timeLine: () => ({
        remaining: formatRemaining(budget.remainingMs()),
        pausedNote: wrapState.initiated
          ? " · WRAP-UP: budget exhausted, finish and report"
          : budget.paused
            ? " · PAUSED (outside work window)"
            : "",
      }),
      deadlineLocal: deadlineLocal(budget),
    });
    runnerMap.set("worker", worker);

    // Delegate configured → report its health into the run feed.
    if (profile.delegate) {
      void checkDelegateHealth(profile.delegate.kind).then((health) => {
        if (this.active?.runId === runId) emit({ type: "delegate-health", health, at: Date.now() });
      });
    }

    this.active = { runId, journal, budget, worker, recallStores, stopped: false };
    emit({ type: "run-started", runId, profileId: profile.id, at: Date.now() });
    emit({
      type: "agent-started",
      agentId: "worker",
      role: "worker" as AgentRole,
      label: "Worker",
      model: profile.source.model,
      at: Date.now(),
    });
    if (resume) {
      emit({
        type: "agent-status",
        agentId: "worker",
        status: "running",
        note: `resumed — ${resume.compactions} prior compactions · ${formatRemaining(resume.budgetRemainingMs)} left`,
        at: Date.now(),
      });
    }

    let lastTickState = "";
    const wrapState = { initiated: false };
    budget.onTick((remainingMs, paused, windowOpen) => {
      if (this.active?.runId !== runId) return;
      // Renderer gets every tick (live countdown); the journal records only
      // meaningful changes (once a minute of budget, or pause/window flips) —
      // a weeks-long run must not write 86k JSONL lines per day.
      this.emitEvent({ type: "budget-tick", runId, remainingMs, windowOpen, paused, at: Date.now() });
      const state = `${Math.floor(remainingMs / 60_000)}:${paused}:${windowOpen}`;
      if (state !== lastTickState) {
        lastTickState = state;
        emit({ type: "budget-tick", runId, remainingMs, windowOpen, paused, at: Date.now() });
      }
      if (remainingMs <= 0 && !wrapState.initiated) {
        // Graceful wrap: the worker gets one final task — stop starting new
        // work, summarize, call report_done. Ten minutes later we end the run
        // regardless (report_done in that window ends it sooner).
        wrapState.initiated = true;
        budget.pause();
        worker.push("user", WRAP_UP_TASK);
        emit({ type: "agent-status", agentId: "worker", status: "running", note: "budget exhausted — wrapping up", at: Date.now() });
        const grace = setTimeout(() => {
          if (this.active?.runId === runId) void this.endRun("deadline", worker.finishReason || "Time budget exhausted.");
        }, 10 * 60_000);
        grace.unref?.();
      }
    });

    budget.start();

    void worker
      .run(resume ? this.resumeTask(profile, resume) : this.kickoff(profile))
      .then((summary) => {
        if (this.active?.runId === runId) void this.endRun("done", summary);
      })
      .catch((err) => {
        if (this.active?.runId === runId && !this.active.stopped) {
          void this.endRun("error", String(err?.message || err));
        }
      });

    return { runId };
  }

  panic(): void {
    if (!this.active) return;
    this.active.worker.kill("panic: user requested full stop");
    void this.endRun("panic", "Panic stop by user.");
  }

  async shutdown(): Promise<void> {
    if (this.active) {
      this.active.worker.kill("app shutdown");
      await this.endRun("error", "App shutdown.");
    }
  }

  private async endRun(reason: RunEndReason, summary: string): Promise<void> {
    const run = this.active;
    if (!run || run.stopped) return;
    run.stopped = true;
    run.budget.stop();
    run.worker.kill(reason === "done" ? "" : reason);
    stopPowerBlock();
    this.emitEvent({ type: "run-ended", runId: run.runId, reason, summary: summary.slice(0, 2000), at: Date.now() });
    await run.journal.close();
    for (const store of run.recallStores) {
      try {
        store.close();
      } catch {
        /* closing is best effort; JSONL is already durable */
      }
    }
    this.active = null;
  }

  private kickoff(profile: ProfileConfig): string {
    return `Begin the run. First, restate your understanding of the goal in 3-5 lines and lay out the work plan. Then start executing with your tools. Workspace: ${profile.workspace}`;
  }

  /** The resumed worker's first message: a compact re-orientation brief. */
  private resumeTask(profile: ProfileConfig, plan: ResumePlan): string {
    const tail = plan.workerTail.map((t) => `- [${t.role}] ${t.text}`).join("\n");
    const agents = plan.agents.map((a) => `${a.label} (${a.role}, ${a.lastStatus})`).join(", ") || "none";
    return `RESUME: this run was interrupted (app restart or crash). Where things stood:
- Remaining budget: ${formatRemaining(plan.budgetRemainingMs)}
- Agents last known as: ${agents}
- Prior compactions: ${plan.compactions} (${plan.coldMovedTokens} tokens in cold storage)
- Last activity:
${tail || "- (no text recorded)"}

Your durable ledger from this run loads automatically, and everything evicted earlier is recallable. Re-orient by reading the workspace first — do not redo finished work — then continue toward the goal. Workspace: ${profile.workspace}`;
  }

  /** One compaction engine per agent; engines are cheap, all state is on disk. */
  private makeEngine(
    profile: ProfileConfig,
    runId: string,
    agentId: string,
    budget: BudgetClock,
    emitBase: (event: RunEvent) => void,
  ): EngineLike {
    return new CompactionEngine({
      profile,
      source: profile.source,
      runId,
      agentId,
      budgetRemainingMs: () => budget.remainingMs(),
      hooks: { emit: emitBase },
    });
  }

  private validate(profile: ProfileConfig): void {
    if (!profile.source?.apiKey) throw new Error("Source provider has no API key.");
    if (!profile.source?.model) throw new Error("Source provider has no model.");
    if (!profile.workspace) throw new Error("No workspace directory set.");
    if (!profile.subAgents?.length) throw new Error("At least one sub-agent is required.");
    if (profile.subAgents.length > 25) throw new Error("Sub-agent limit is 25.");
    if (budgetMs(profile.budget) <= 0) throw new Error("Time budget must be positive.");
  }
}
