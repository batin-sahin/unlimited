import { useCallback, useEffect, useState } from "react";
import { Play, Siren } from "lucide-react";
import type { ProfileMeta } from "../../../shared/types";
import { errorMessage, formatRemaining, shortId } from "./format";
import { AgentCard } from "./AgentCard";
import { EventFeed } from "./EventFeed";
import { useRunEvents } from "./useRunEvents";

interface RunConsoleProps {
  /** Profile preselected via "Run ▸" in the wizard's profile list. */
  initialProfileId: string | null;
  /** True while the RUN tab is visible; used to refresh the profile list. */
  active: boolean;
}

/**
 * The run console. Everything on screen comes from the event stream; the
 * only commands it sends are startRun and panic.
 */
export function RunConsole({ initialProfileId, active }: RunConsoleProps) {
  const { agents, budget, feed, verdicts, runState } = useRunEvents();
  const [profiles, setProfiles] = useState<ProfileMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string>(initialProfileId ?? "");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [armedUntil, setArmedUntil] = useState<number | null>(null);
  const [tick, setTick] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const boot = await window.unlimited.bootstrap();
      setProfiles(boot.profiles);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  // "Run ▸" from the wizard re-selects the profile each time it fires.
  useEffect(() => {
    if (initialProfileId) setSelectedId(initialProfileId);
  }, [initialProfileId]);

  // Two-step panic: keep the countdown alive while armed.
  useEffect(() => {
    if (armedUntil === null) return;
    const timer = window.setInterval(() => {
      if (Date.now() >= armedUntil) setArmedUntil(null);
      else setTick(Date.now());
    }, 250);
    return () => window.clearInterval(timer);
  }, [armedUntil]);

  const running = runState.phase === "running";
  const armed = armedUntil !== null && Date.now() < armedUntil;
  const armSecondsLeft = armed ? Math.max(1, Math.ceil((armedUntil - tick) / 1000)) : 0;
  const latestVerdict = verdicts[0] ?? null;
  const verdictLabel = latestVerdict
    ? agents.find((a) => a.id === latestVerdict.targetAgentId)?.label.trim() || shortId(latestVerdict.targetAgentId)
    : "";

  async function start() {
    if (!selectedId || running) return;
    setStarting(true);
    setError(null);
    try {
      await window.unlimited.startRun(selectedId);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setStarting(false);
    }
  }

  function onPanicClick() {
    if (armed) {
      setArmedUntil(null);
      window.unlimited
        .panic()
        .then(() => setError(null))
        .catch((err) => setError(errorMessage(err)));
    } else {
      setArmedUntil(Date.now() + 3000);
      setTick(Date.now());
    }
  }

  const windowChip = !budget
    ? { label: "NO TICKS", tone: "neutral" }
    : budget.paused
      ? { label: "PAUSED", tone: "warn" }
      : budget.windowOpen
        ? { label: "WINDOW OPEN", tone: "ok" }
        : { label: "WINDOW CLOSED", tone: "warn" };

  return (
    <main className="run-main">
      <div className="run-controls">
        <div className="run-picker">
          <label className="field-label" htmlFor="run-profile">
            Profile
          </label>
          <span className="run-select-wrap">
            <select
              id="run-profile"
              className="field run-select"
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              disabled={running}
              aria-label="Profile to run"
            >
              <option value="">— select a profile —</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {(p.name || "").trim() || "(unnamed)"} — {p.workspace || "no workspace"}
                </option>
              ))}
            </select>
          </span>
        </div>
        <div className="run-actions">
          <button
            type="button"
            className="btn primary"
            onClick={() => void start()}
            disabled={running || starting || !selectedId}
            aria-label="Start run with the selected profile"
          >
            <Play size={14} strokeWidth={1.75} aria-hidden="true" />
            {running ? "Run active" : starting ? "Starting…" : "Start run"}
          </button>
          <button
            type="button"
            className={armed ? "btn run-panic armed" : "btn danger run-panic"}
            onClick={onPanicClick}
            aria-label={armed ? `Panic armed, fires in ${armSecondsLeft} seconds — click again to panic now` : "Arm panic — click twice to panic"}
          >
            <Siren size={14} strokeWidth={1.75} aria-hidden="true" />
            {armed ? `Panic ${armSecondsLeft}` : "Panic"}
          </button>
        </div>
      </div>

      <p className="run-strip">
        <span className="run-strip-item">
          budget <strong>{budget ? formatRemaining(budget.remainingMs) : "— d —h —m —s"}</strong>
        </span>
        <span className={`run-chip chip-${windowChip.tone}`}>{windowChip.label}</span>
        <span className="run-strip-item">
          run <strong>{runState.runId ? shortId(runState.runId) : "—"}</strong>
        </span>
        <span className="run-strip-item">
          agents <strong>{agents.length}</strong>
        </span>
        <span className={`run-chip chip-${runState.phase === "running" ? "ok" : runState.phase === "ended" ? "warn" : "neutral"}`}>
          {runState.phase.toUpperCase()}
        </span>
      </p>

      {error ? (
        <p className="run-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className={`run-supervisor ${latestVerdict ? (latestVerdict.action === "kill" ? "tone-brick" : latestVerdict.action === "warn" ? "tone-amber" : "tone-ok") : ""}`}>
        <span className="run-supervisor-label">Supervisor</span>
        {latestVerdict ? (
          <span className="run-supervisor-line">
            {latestVerdict.action.toUpperCase()} — {verdictLabel} · {latestVerdict.reason || "no reason given"}
          </span>
        ) : (
          <span className="run-supervisor-line">standing by — no verdicts yet</span>
        )}
      </div>

      {runState.phase === "ended" ? (
        <div className={`run-ended reason-${runState.endReason ?? "done"}`} role="status">
          <span className="run-ended-reason">Run ended · {(runState.endReason ?? "done").toUpperCase()}</span>
          <p className="run-ended-summary">{runState.endSummary || "no wrap-up summary was reported."}</p>
        </div>
      ) : null}

      <section className="run-agents-wrap" aria-label="Agents">
        <h2 className="run-section-title">Agents</h2>
        {agents.length === 0 ? (
          <p className="run-empty">no agents yet — start a run from a saved profile</p>
        ) : (
          <div className="run-agents">
            {agents.map((a) => (
              <AgentCard key={a.id} agent={a} />
            ))}
          </div>
        )}
      </section>

      <EventFeed rows={feed} active={active} />
    </main>
  );
}
