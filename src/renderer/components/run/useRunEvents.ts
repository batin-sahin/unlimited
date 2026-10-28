import { useEffect, useReducer } from "react";
import type { AgentRole, AgentStatus, PressureSnapshot, PressureZone, RunEvent } from "../../../shared/types";
import { firstLine, formatTokens, shortId, truncate } from "./format";

/**
 * Subscribes to window.unlimited.onEvent and reduces the stream into the
 * four things the console renders: agent cards, the budget header, the
 * rolling feed, and supervisor verdicts. No polling — every byte on screen
 * arrived as an event.
 */

export interface RunAgent {
  id: string;
  role: AgentRole;
  label: string;
  model: string;
  status: AgentStatus;
  pressure?: PressureSnapshot;
}

export type FeedKind = "run" | "tool" | "text" | "verdict" | "compaction" | "delegate" | "pressure";

export type FeedTone = "plain" | "ok" | "fail" | "accent" | "amber" | "brick" | "banner";

export interface FeedRow {
  id: number;
  at: number;
  kind: FeedKind;
  /** Short uppercase tag shown before the text. */
  tag: string;
  text: string;
  tone: FeedTone;
}

export interface RunVerdict {
  id: number;
  targetAgentId: string;
  action: "ok" | "warn" | "kill";
  reason: string;
  at: number;
}

export interface BudgetTick {
  remainingMs: number;
  windowOpen: boolean;
  paused: boolean;
  at: number;
}

export interface RunState {
  phase: "idle" | "running" | "ended";
  runId: string | null;
  endReason: string | null;
  endSummary: string;
}

export interface RunEvents {
  agents: RunAgent[];
  budget: BudgetTick | null;
  feed: FeedRow[];
  verdicts: RunVerdict[];
  runState: RunState;
}

const FEED_CAP = 200;
const VERDICT_CAP = 20;
const TEXT_EXCERPT = 140;

interface State {
  agentsById: Record<string, RunAgent>;
  zoneByAgent: Record<string, PressureZone>;
  budget: BudgetTick | null;
  feed: FeedRow[];
  verdicts: RunVerdict[];
  runState: RunState;
  nextId: number;
}

const initialState: State = {
  agentsById: {},
  zoneByAgent: {},
  budget: null,
  feed: [],
  verdicts: [],
  runState: { phase: "idle", runId: null, endReason: null, endSummary: "" },
  nextId: 1,
};

function pushRow(state: State, row: Omit<FeedRow, "id">): State {
  const feed = [...state.feed, { ...row, id: state.nextId }];
  return {
    ...state,
    nextId: state.nextId + 1,
    feed: feed.length > FEED_CAP ? feed.slice(feed.length - FEED_CAP) : feed,
  };
}

function labelOf(state: State, agentId: string): string {
  const agent = state.agentsById[agentId];
  return agent && agent.label.trim() ? agent.label.trim() : `agent ${shortId(agentId)}`;
}

function reduceEvent(state: State, event: RunEvent): State {
  switch (event.type) {
    case "run-started": {
      // Same runId → duplicate delivery, ignore. New runId → full reset.
      if (state.runState.runId === event.runId) return state;
      const fresh: State = {
        ...initialState,
        nextId: state.nextId,
        runState: { phase: "running", runId: event.runId, endReason: null, endSummary: "" },
      };
      return pushRow(fresh, {
        at: event.at,
        kind: "run",
        tag: "RUN",
        text: `run started · profile ${shortId(event.profileId)}`,
        tone: "banner",
      });
    }
    case "run-ended": {
      // A late end for a run we already replaced must not clobber the live one.
      if (state.runState.runId && event.runId !== state.runState.runId) return state;
      const tone: FeedTone = event.reason === "panic" || event.reason === "error" ? "brick" : event.reason === "done" ? "accent" : "amber";
      return pushRow(
        {
          ...state,
          runState: { phase: "ended", runId: event.runId, endReason: event.reason, endSummary: event.summary },
        },
        {
          at: event.at,
          kind: "run",
          tag: "RUN",
          text: `run ended (${event.reason}) — ${event.summary || "no summary"}`,
          tone,
        },
      );
    }
    case "agent-started": {
      return {
        ...state,
        agentsById: {
          ...state.agentsById,
          [event.agentId]: {
            id: event.agentId,
            role: event.role,
            label: event.label,
            model: event.model,
            status: "running",
          },
        },
      };
    }
    case "agent-status": {
      const agent = state.agentsById[event.agentId];
      if (!agent) return state;
      return {
        ...state,
        agentsById: { ...state.agentsById, [event.agentId]: { ...agent, status: event.status } },
      };
    }
    case "agent-text": {
      return pushRow(state, {
        at: event.at,
        kind: "text",
        tag: "TEXT",
        text: `${labelOf(state, event.agentId)}: ${truncate(event.text, TEXT_EXCERPT)}`,
        tone: "plain",
      });
    }
    case "tool-call": {
      const summary = event.summary.trim();
      return pushRow(state, {
        at: event.at,
        kind: "tool",
        tag: "TOOL",
        text: `[${labelOf(state, event.agentId)}] ${event.tool}${summary ? ` · ${truncate(summary, 110)}` : ""}`,
        tone: "plain",
      });
    }
    case "tool-result": {
      const mark = event.ok ? "✓" : "✗";
      const head = firstLine(event.outputHead) || "(no output)";
      return pushRow(state, {
        at: event.at,
        kind: "tool",
        tag: "RESULT",
        text: `[${labelOf(state, event.agentId)}] ${mark} ${head}`,
        tone: event.ok ? "ok" : "fail",
      });
    }
    case "supervisor-verdict": {
      const v = event.verdict;
      const tone: FeedTone = v.action === "kill" ? "brick" : v.action === "warn" ? "amber" : "accent";
      return pushRow(
        {
          ...state,
          verdicts: [{ id: state.nextId, ...v }, ...state.verdicts].slice(0, VERDICT_CAP),
          nextId: state.nextId + 1,
        },
        {
          at: event.at,
          kind: "verdict",
          tag: v.action.toUpperCase(),
          text: `supervisor: ${v.action} ${labelOf(state, v.targetAgentId)} — ${v.reason || "no reason given"}`,
          tone,
        },
      );
    }
    case "pressure": {
      const p = event.pressure;
      const agent = state.agentsById[event.agentId];
      const prevZone = state.zoneByAgent[event.agentId];
      let next: State = {
        ...state,
        zoneByAgent: { ...state.zoneByAgent, [event.agentId]: p.zone },
        agentsById: agent
          ? { ...state.agentsById, [event.agentId]: { ...agent, pressure: p } }
          : state.agentsById,
      };
      // Feed only shows zone *changes*, not every snapshot.
      if (prevZone === p.zone) return next;
      const tone: FeedTone = p.zone === "emergency" ? "brick" : p.zone === "ok" ? "plain" : "amber";
      next = pushRow(next, {
        at: event.at,
        kind: "pressure",
        tag: "PRESSURE",
        text: `${labelOf(state, event.agentId)} context ${p.zone} · hot ${formatTokens(p.hot)} of ${formatTokens(p.limit)}`,
        tone,
      });
      return next;
    }
    case "compaction": {
      const outputs = event.outputsElided > 0 ? ` · ${event.outputsElided} outputs` : "";
      return pushRow(state, {
        at: event.at,
        kind: "compaction",
        tag: "COMPACT",
        text: `${labelOf(state, event.agentId)} ${formatTokens(event.beforeTokens)} → ${formatTokens(event.afterTokens)} · ${event.episodesSummarized} episodes${outputs} · ${formatTokens(event.coldMoved)} tok → cold`,
        tone: "accent",
      });
    }
    case "budget-tick": {
      return {
        ...state,
        budget: {
          remainingMs: event.remainingMs,
          windowOpen: event.windowOpen,
          paused: event.paused,
          at: event.at,
        },
      };
    }
    case "delegate-health": {
      const h = event.health;
      const tone: FeedTone = h.installed && h.responds ? "ok" : "amber";
      const detail = !h.installed
        ? h.error || `${h.binary}: not found on PATH`
        : h.responds
          ? `installed · responds${h.version ? ` · ${h.version}` : ""}`
          : h.error || "installed · no response";
      return pushRow(state, {
        at: event.at,
        kind: "delegate",
        tag: "DELEGATE",
        text: `${h.kind} · ${detail}`,
        tone,
      });
    }
    default:
      return state;
  }
}

function reducer(state: State, event: RunEvent): State {
  try {
    return reduceEvent(state, event);
  } catch {
    // A malformed event must never take the console down.
    return state;
  }
}

export function useRunEvents(): RunEvents {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    const unsubscribe = window.unlimited.onEvent((event) => dispatch(event));
    return unsubscribe;
  }, []);

  return {
    agents: Object.values(state.agentsById),
    budget: state.budget,
    feed: state.feed,
    verdicts: state.verdicts,
    runState: state.runState,
  };
}
