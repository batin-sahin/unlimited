import { useState } from "react";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import { DELEGATE_LABELS, type DelegateHealth, type DelegateKind } from "../../../shared/types";
import { errorMessage, formatClock, type WizardDraft } from "./draft";
import { ChoiceGroup, TextAreaField, type ChoiceOption } from "./fields";

interface StepDelegateProps {
  draft: WizardDraft;
  update: (patch: Partial<WizardDraft>) => void;
}

type DelegateChoice = DelegateKind | "none";

const CHOICES: readonly ChoiceOption<DelegateChoice>[] = [
  { value: "none", label: "None (use built-in tools)" },
  { value: "opencode", label: DELEGATE_LABELS.opencode, hint: "opencode" },
  { value: "claude-code", label: DELEGATE_LABELS["claude-code"], hint: "claude" },
  { value: "codex", label: DELEGATE_LABELS.codex, hint: "codex" },
  { value: "kimi", label: DELEGATE_LABELS.kimi, hint: "kimi" },
];

/** Step 4 — optional external CLI the crew can drive. Default is none. */
export function StepDelegate({ draft, update }: StepDelegateProps) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ kind: DelegateKind; health: DelegateHealth } | null>(null);

  const kind = draft.delegateKind;

  function pick(next: DelegateChoice) {
    update({ delegateKind: next });
    // A stale health result for another CLI would be misleading.
    setResult(null);
  }

  async function check(kindToCheck: DelegateKind) {
    setChecking(true);
    try {
      const health = await window.unlimited.checkDelegate(kindToCheck);
      setResult({ kind: kindToCheck, health });
    } catch (err) {
      setResult({
        kind: kindToCheck,
        health: {
          kind: kindToCheck,
          binary: kindToCheck,
          installed: false,
          responds: false,
          version: "",
          checkedAt: Date.now(),
          error: errorMessage(err),
        },
      });
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="step-body">
      <p className="step-lead">
        Optional. The crew can hand work to an external CLI instead of doing everything with its own
        tools. Leave it on None to stay fully built-in.
      </p>

      <ChoiceGroup
        label="Delegate"
        name="delegate-kind"
        columns={2}
        value={kind}
        options={CHOICES}
        onChange={pick}
      />

      {kind !== "none" ? (
        <div className="delegate-panel">
          <TextAreaField
            label="Instructions"
            note="What the crew should tell this CLI when it delegates work."
            value={draft.delegateInstructions}
            placeholder="How to invoke it, what it may touch, when to report back…"
            onChange={(delegateInstructions) => update({ delegateInstructions })}
            rows={4}
          />
          <div className="delegate-check">
            <button type="button" className="btn" onClick={() => void check(kind)} disabled={checking}>
              {checking ? <LoaderCircle size={14} strokeWidth={1.75} aria-hidden="true" /> : null}
              {checking ? "Checking…" : "Check availability"}
            </button>
          </div>
          {result && result.kind === kind ? <HealthLine health={result.health} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function HealthLine({ health }: { health: DelegateHealth }) {
  const status = health.installed
    ? health.responds
      ? "ok"
      : "err"
    : "warn";
  const detail = !health.installed
    ? `${health.binary}: not found on PATH`
    : health.responds
      ? `${health.binary}: installed · responds${health.version ? ` · ${health.version}` : ""}`
      : `${health.error || `${health.binary}: no response`}`;

  return (
    <div className="delegate-health">
      <p className={`mono-line ${status}`} aria-live="polite">
        {detail} · checked {formatClock(health.checkedAt)}
      </p>
      {!health.installed ? (
        <p className="warn-line" role="status">
          <TriangleAlert size={13} strokeWidth={1.75} aria-hidden="true" />
          {health.binary} is not installed — the crew cannot delegate to it until it is on PATH.
        </p>
      ) : null}
      {health.installed && !health.responds ? (
        <p className="warn-line" role="status">
          <TriangleAlert size={13} strokeWidth={1.75} aria-hidden="true" />
          {health.binary} was found but did not answer — the run may stall on it.
        </p>
      ) : null}
    </div>
  );
}
