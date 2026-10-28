import type { ReactNode } from "react";
import { DELEGATE_LABELS } from "../../../shared/types";
import { formatBudget, maskKey, type WizardDraft } from "./draft";

interface StepReviewProps {
  draft: WizardDraft;
}

/** Step 6 — read-only summary of everything about to be saved. */
export function StepReview({ draft }: StepReviewProps) {
  return (
    <div className="step-body review">
      <ReviewSection title="Project">
        <ReviewRow label="Name" value={draft.name.trim() || "—"} />
        <ReviewRow label="Workspace" value={draft.workspace.trim() || "—"} />
        <ReviewRow label="Definition" value={draft.definition.trim() || "—"} multiline />
        <ReviewRow label="Goal" value={draft.goal.trim() || "—"} multiline />
        <ReviewRow label="Vision" value={draft.vision.trim() || "—"} multiline />
        <ReviewRow label="Notes" value={draft.notes.trim() || "—"} multiline />
      </ReviewSection>

      <ReviewSection title="Source provider">
        <ReviewRow label="Kind" value={draft.source.kind} />
        <ReviewRow label="Base URL" value={draft.source.baseUrl.trim() || "—"} />
        <ReviewRow label="Model" value={draft.source.model.trim() || "—"} />
        <ReviewRow label="API key" value={maskKey(draft.source.apiKey)} />
      </ReviewSection>

      <ReviewSection title={`Sub-agents (${draft.subAgents.length})`}>
        {draft.subAgents.map((s, i) => (
          <ReviewRow
            key={s.id}
            label={`Slot ${String(i + 1).padStart(2, "0")}`}
            value={`${s.label.trim() || `sub-${i + 1}`} · ${s.kind} · ${s.model.trim() || "no model"} · ${s.baseUrl.trim() || "no endpoint"} · key ${maskKey(s.apiKey)}`}
          />
        ))}
      </ReviewSection>

      <ReviewSection title="Delegate">
        {draft.delegateKind === "none" ? (
          <ReviewRow label="Delegate" value="none — built-in tools only" />
        ) : (
          <>
            <ReviewRow label="Delegate" value={DELEGATE_LABELS[draft.delegateKind]} />
            <ReviewRow label="Instructions" value={draft.delegateInstructions.trim() || "—"} multiline />
          </>
        )}
      </ReviewSection>

      <ReviewSection title="Time & rules">
        <ReviewRow
          label="Budget"
          value={formatBudget({
            days: Number.parseInt(draft.days.trim(), 10) || 0,
            hours: draft.hours.trim() === "" ? undefined : Number.parseInt(draft.hours.trim(), 10) || 0,
            minutes: draft.minutes.trim() === "" ? undefined : Number.parseInt(draft.minutes.trim(), 10) || 0,
          })}
        />
        <ReviewRow
          label="Daily window"
          value={
            draft.windowEnabled
              ? `${draft.windowStart || "09:00"} – ${draft.windowEnd || "17:00"}`
              : "off — runs around the clock"
          }
        />
        <ReviewRow
          label="Forbidden"
          value={
            draft.forbiddenText
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter((l) => l !== "")
              .map((l) => `— ${l}`)
              .join("\n") || "none"
          }
          multiline
        />
        <ReviewRow
          label="Spend cap"
          value={
            draft.spendCapUsd.trim() === ""
              ? "—"
              : `$${(Number.parseFloat(draft.spendCapUsd) || 0).toFixed(2)}`
          }
        />
      </ReviewSection>
    </div>
  );
}

function ReviewSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="review-section">
      <h3 className="review-title">{title}</h3>
      {children}
    </section>
  );
}

function ReviewRow({
  label,
  value,
  multiline,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  return (
    <div className="review-row">
      <span className="review-label">{label}</span>
      <span className={value === "—" || value === "none" ? "review-value empty" : "review-value"} data-multiline={multiline ? "true" : undefined}>
        {value}
      </span>
    </div>
  );
}
