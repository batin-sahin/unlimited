/**
 * Unlimited — locked contracts (Faz 0).
 * Main, preload, and renderer all import from here.
 * Changing a shape here is a breaking event: every consumer must be checked.
 */

// ---- Hard limits (user-set policy) ----

/** Maximum sub-agents in the pool. */
export const MAX_SUB_AGENTS = 25;
/** Worker may spawn at most this many coordinator sub-agents. */
export const MAX_COORDINATORS = 2;
/** Warn once per violation class; repeat means kill. */
export const SUPERVISOR_WARN_LIMIT = 1;

// ---- Provider configuration ----

export type ProviderKind = "openai" | "anthropic" | "google";

export interface ProviderConfig {
  kind: ProviderKind;
  /** OpenAI-compatible / Anthropic / Google endpoint. */
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface SubAgentConfig extends ProviderConfig {
  id: string;
  label: string;
}

// ---- Delegate (optional external CLI the agents drive) ----

export type DelegateKind = "opencode" | "claude-code" | "codex" | "kimi";

export const DELEGATE_LABELS: Record<DelegateKind, string> = {
  opencode: "OpenCode CLI",
  "claude-code": "Claude Code",
  codex: "Codex CLI",
  kimi: "Kimi Code CLI",
};

export interface DelegateConfig {
  kind: DelegateKind;
  /** What the worker should tell the delegated CLI. */
  instructions: string;
}

export interface DelegateHealth {
  kind: DelegateKind;
  binary: string;
  /** Binary found on PATH. */
  installed: boolean;
  /** Answered a trivial headless round-trip in time. */
  responds: boolean;
  version: string;
  checkedAt: number;
  error: string;
}

// ---- Time policy ----

export interface TimeBudget {
  /** Required. Whole days of work. */
  days: number;
  hours?: number;
  minutes?: number;
}

export interface DailyWindow {
  enabled: boolean;
  /** "HH:mm" local time, inclusive. */
  start: string;
  /** "HH:mm" local time, exclusive. */
  end: string;
}

/** Wall-clock budget only ticks while the run is unpaused (window open). */
export function budgetMs(b: TimeBudget): number {
  return ((b.days * 24 + (b.hours ?? 0)) * 60 + (b.minutes ?? 0)) * 60_000;
}

// ---- Profile (the wizard's output) ----

export interface ProfileConfig {
  id: string;
  name: string;
  /** Absolute target project directory. */
  workspace: string;
  definition: string;
  goal: string;
  vision: string;
  notes: string;
  /** The trusted, limit-proof provider. Worker AND supervisor run on it. */
  source: ProviderConfig;
  /** 1..MAX_SUB_AGENTS slots, each with its own provider/model/key. */
  subAgents: SubAgentConfig[];
  delegate: DelegateConfig | null;
  budget: TimeBudget;
  window: DailyWindow;
  /** Things that must never be done or touched, one per entry. */
  forbidden: string[];
  spendCapUsd?: number;
}

export interface ProfileMeta {
  id: string;
  name: string;
  workspace: string;
  updatedAt: number;
}

// ---- Run model ----

export type AgentRole = "worker" | "supervisor" | "coordinator" | "sub";

export type AgentStatus = "idle" | "running" | "paused" | "warned" | "killed" | "done";

export type PressureZone = "ok" | "warn" | "compact" | "emergency";

export interface PressureSnapshot {
  /** Tokens held by the pinned layer (goal, rules, ledger, warnings). */
  pinned: number;
  /** Tokens in the hot (verbatim recent) layer. */
  hot: number;
  /** Context window limit for this agent. */
  limit: number;
  /** Cumulative tokens moved to the cold (on-disk, recallable) layer. */
  coldMoved: number;
  zone: PressureZone;
}

export interface AgentView {
  id: string;
  role: AgentRole;
  label: string;
  model: string;
  status: AgentStatus;
  pressure?: PressureSnapshot;
}

export type VerdictAction = "ok" | "warn" | "kill";

export interface SupervisorVerdict {
  targetAgentId: string;
  action: VerdictAction;
  reason: string;
  at: number;
}

export type RunEndReason = "deadline" | "panic" | "error" | "done";

export type RunEvent =
  | { type: "run-started"; runId: string; profileId: string; at: number }
  | { type: "run-ended"; runId: string; reason: RunEndReason; summary: string; at: number }
  | { type: "agent-started"; agentId: string; role: AgentRole; label: string; model: string; at: number }
  | { type: "agent-status"; agentId: string; status: AgentStatus; note: string; at: number }
  | { type: "agent-text"; agentId: string; text: string; at: number }
  | { type: "tool-call"; agentId: string; callId: string; tool: string; args: Record<string, unknown>; summary: string; at: number }
  | {
      type: "tool-result";
      agentId: string;
      callId: string;
      ok: boolean;
      outputHead: string;
      outputTail: string;
      elidedTokens: number;
      at: number;
    }
  | { type: "supervisor-verdict"; verdict: SupervisorVerdict; at: number }
  | {
      type: "compaction";
      agentId: string;
      beforeTokens: number;
      afterTokens: number;
      episodesSummarized: number;
      outputsElided: number;
      coldMoved: number;
      at: number;
    }
  | { type: "budget-tick"; runId: string; remainingMs: number; windowOpen: boolean; paused: boolean; at: number }
  | { type: "delegate-health"; health: DelegateHealth; at: number };

export interface Bootstrap {
  version: string;
  profiles: ProfileMeta[];
}

/** Rendered on `window.unlimited` by the preload. */
export interface UnlimitedApi {
  bootstrap(): Promise<Bootstrap>;
  saveProfile(profile: ProfileConfig): Promise<void>;
  loadProfile(id: string): Promise<ProfileConfig | null>;
  deleteProfile(id: string): Promise<void>;
  pickDirectory(): Promise<string | null>;
  checkDelegate(kind: DelegateKind): Promise<DelegateHealth>;
  /** Wired to the orchestrator in Faz 2; rejects until then. */
  startRun(profileId: string): Promise<{ runId: string }>;
  panic(): Promise<void>;
  onEvent(cb: (event: RunEvent) => void): () => void;
}
