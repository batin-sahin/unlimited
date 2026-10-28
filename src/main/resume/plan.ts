/**
 * Resume planning (Faz 5) — reconstruct-what-you-can, reorient-don't-replay.
 *
 * The resumed run does NOT replay tool outputs or old transcript turns: every
 * evicted byte lives in the cold layer behind recall, and each agent's durable
 * state lives in its pinned ledger file (runs/<runId>/ledger-<agentId>.json).
 * The plan is deliberately thin — who was on the crew, what state each agent
 * was in when the run died, how much wall-clock budget remains, and a tiny
 * tail of the worker's last words so the resumed worker knows what was
 * happening when everything stopped. Pure over the event array: no fs, no
 * Electron, no clocks.
 *
 * Journals are written by our own journal.ts, but they are read back after a
 * crash and the per-line type guard upstream is deliberately minimal, so every
 * field is coerced defensively here: malformed values fall back to contract
 * defaults instead of poisoning the plan.
 */
import type { AgentRole, AgentStatus, RunEvent } from "../../shared/types.js";

/** Everything the orchestrator needs to relaunch a crashed run without replaying history. */
export interface ResumePlan {
  profileId: string;
  priorRunId: string;
  /** remainingMs of the last budget-tick (0 when the journal has none). */
  budgetRemainingMs: number;
  /** windowOpen of the last budget-tick; null when the journal has no budget-tick (unknown). */
  windowOpen: boolean | null;
  agents: {
    agentId: string;
    role: AgentRole;
    label: string;
    model: string;
    lastStatus: AgentStatus;
    statusNote: string;
  }[];
  supervisorVerdicts: number;
  compactions: number;
  coldMovedTokens: number;
  /** Last ≤3 worker utterances (assistant) plus the worker's final status note (user) — the "what was happening when the run stopped" context. */
  workerTail: { role: "user" | "assistant"; text: string }[];
}

const AGENT_ROLES: readonly AgentRole[] = ["worker", "supervisor", "coordinator", "sub"];
const AGENT_STATUSES: readonly AgentStatus[] = ["idle", "running", "paused", "warned", "killed", "done"];

/** Build a resume plan from a run journal's events; null when there is nothing to resume from (empty input or no run-started identity). */
export function buildResumePlan(events: RunEvent[]): ResumePlan | null {
  // The most recent run-started defines the identity (a journal should hold
  // exactly one; if a file somehow holds several, the last one is live).
  let started: { runId: string; profileId: string } | null = null;
  for (const event of events) {
    if (event.type === "run-started") {
      started = {
        runId: typeof event.runId === "string" ? event.runId : "",
        profileId: typeof event.profileId === "string" ? event.profileId : "",
      };
    }
  }
  if (!started) return null;

  interface AgentSeed {
    agentId: string;
    role: AgentRole;
    label: string;
    model: string;
    lastStatus: AgentStatus;
    statusNote: string;
  }
  const order: string[] = []; // first-appearance order → deterministic agents array
  const byId = new Map<string, AgentSeed>();
  let budgetRemainingMs = 0;
  let windowOpen: boolean | null = null;
  let supervisorVerdicts = 0;
  let compactions = 0;
  let coldMovedTokens = 0;

  for (const event of events) {
    switch (event.type) {
      case "agent-started": {
        if (typeof event.agentId !== "string" || event.agentId.length === 0) break;
        const role = AGENT_ROLES.includes(event.role) ? event.role : "sub";
        const existing = byId.get(event.agentId);
        if (existing) {
          // Restarted agent: refresh the identity, keep its status history
          // (a later agent-status event still wins).
          existing.role = role;
          existing.label = typeof event.label === "string" ? event.label : "";
          existing.model = typeof event.model === "string" ? event.model : "";
        } else {
          order.push(event.agentId);
          byId.set(event.agentId, {
            agentId: event.agentId,
            role,
            label: typeof event.label === "string" ? event.label : "",
            model: typeof event.model === "string" ? event.model : "",
            lastStatus: "running", // default: an agent that started was running
            statusNote: "",
          });
        }
        break;
      }
      case "agent-status": {
        const seed = typeof event.agentId === "string" ? byId.get(event.agentId) : undefined;
        if (seed) {
          if (AGENT_STATUSES.includes(event.status)) seed.lastStatus = event.status;
          seed.statusNote = typeof event.note === "string" ? event.note : "";
        }
        break;
      }
      case "budget-tick":
        if (typeof event.remainingMs === "number" && Number.isFinite(event.remainingMs)) {
          budgetRemainingMs = event.remainingMs;
        }
        if (typeof event.windowOpen === "boolean") windowOpen = event.windowOpen;
        break;
      case "supervisor-verdict":
        supervisorVerdicts += 1;
        break;
      case "compaction":
        compactions += 1;
        if (typeof event.coldMoved === "number" && Number.isFinite(event.coldMoved)) {
          coldMovedTokens += event.coldMoved;
        }
        break;
      default:
        break;
    }
  }

  const workerIds = new Set(
    [...byId.values()].filter((agent) => agent.role === "worker").map((agent) => agent.agentId),
  );
  const workerTexts: string[] = [];
  for (const event of events) {
    if (event.type === "agent-text" && workerIds.has(event.agentId) && typeof event.text === "string") {
      workerTexts.push(event.text);
    }
  }
  const worker = order.map((id) => byId.get(id)).find((agent) => agent?.role === "worker");
  const workerTail: ResumePlan["workerTail"] = workerTexts.slice(-3).map((text) => ({ role: "assistant", text }));
  if (worker && worker.statusNote.trim().length > 0) {
    workerTail.push({ role: "user", text: worker.statusNote });
  }

  return {
    profileId: started.profileId,
    priorRunId: started.runId,
    budgetRemainingMs,
    windowOpen,
    agents: order
      .map((id) => byId.get(id))
      .filter((agent): agent is AgentSeed => agent !== undefined)
      .map((agent) => ({
        agentId: agent.agentId,
        role: agent.role,
        label: agent.label,
        model: agent.model,
        lastStatus: agent.lastStatus,
        statusNote: agent.statusNote,
      })),
    supervisorVerdicts,
    compactions,
    coldMovedTokens,
    workerTail,
  };
}
