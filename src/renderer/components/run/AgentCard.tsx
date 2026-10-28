import type { AgentRole, AgentStatus } from "../../../shared/types";
import { formatTokens, shortId } from "./format";
import type { RunAgent } from "./useRunEvents";

interface AgentCardProps {
  agent: RunAgent;
}

const ROLE_LABEL: Record<AgentRole, string> = {
  worker: "Worker",
  coordinator: "Coordinator",
  supervisor: "Supervisor",
  sub: "Sub",
};

const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: "Idle",
  running: "Running",
  paused: "Paused",
  warned: "Warned",
  killed: "Killed",
  done: "Done",
};

/** One square card per agent: role chip, label, model, status, pressure gauge. */
export function AgentCard({ agent }: AgentCardProps) {
  const p = agent.pressure;
  const pct = p && p.limit > 0 ? Math.min(100, Math.round((p.hot / p.limit) * 100)) : 0;
  return (
    <article className="run-card" aria-label={`agent ${agent.label || agent.id}`}>
      <div className="run-card-head">
        <span className={`run-role role-${agent.role}`}>{ROLE_LABEL[agent.role] ?? agent.role}</span>
        <span className={`run-status st-${agent.status}`}>{STATUS_LABEL[agent.status] ?? agent.status}</span>
      </div>
      <h3 className="run-card-label" title={agent.label}>
        {agent.label.trim() || `agent ${shortId(agent.id)}`}
      </h3>
      <p className="run-card-model" title={agent.model}>
        {agent.model.trim() || "—"}
      </p>
      {p ? (
        <div className="run-pressure">
          <div
            className="run-gauge"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-label={`context pressure ${p.zone}`}
          >
            <span className={`run-gauge-fill zone-${p.zone}`} style={{ width: `${pct}%` }} />
          </div>
          <span className="run-gauge-num">
            {formatTokens(p.hot)} / {formatTokens(p.limit)} · cold {formatTokens(p.coldMoved)}
          </span>
        </div>
      ) : (
        <p className="run-pressure-none">no pressure data yet</p>
      )}
    </article>
  );
}
