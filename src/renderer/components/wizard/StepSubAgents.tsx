import { useEffect, useState } from "react";
import { ChevronRight, Plus, Trash2 } from "lucide-react";
import { MAX_SUB_AGENTS, type CatalogMeta, type SubAgentConfig } from "../../../shared/types";
import type { WizardDraft } from "./draft";
import { ProviderFields } from "./ProviderFields";
import { providerFieldProblems } from "./validate";

interface StepSubAgentsProps {
  draft: WizardDraft;
  /** models.dev catalog from bootstrap; null while it is still loading. */
  catalog: CatalogMeta | null;
  addSubAgent: () => void;
  removeSubAgent: (id: string) => void;
  updateSubAgent: (id: string, patch: Partial<SubAgentConfig>) => void;
}

type SlotErrors = { baseUrl?: string; model?: string; apiKey?: string };

function isFilled(s: SubAgentConfig): boolean {
  return s.label.trim() !== "" && s.baseUrl.trim() !== "" && s.model.trim() !== "" && s.apiKey.trim() !== "";
}

/**
 * Step 3 — the sub-agent pool. One slot to start, up to MAX_SUB_AGENTS.
 * Progressive disclosure: a fully-filled slot collapses to a one-line
 * summary (label + model); click the summary to re-edit it.
 */
export function StepSubAgents({ draft, catalog, addSubAgent, removeSubAgent, updateSubAgent }: StepSubAgentsProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  // Newly seen slots start collapsed when already filled (e.g. a loaded
  // profile), expanded otherwise. Tracked slots keep their user choice.
  useEffect(() => {
    const untracked = draft.subAgents.filter((s) => !(s.id in collapsed));
    if (untracked.length === 0) return;
    setCollapsed((prev) => {
      const next = { ...prev };
      for (const s of untracked) next[s.id] = isFilled(s);
      return next;
    });
    // `collapsed` is intentionally read once per subAgents change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.subAgents]);

  const full = draft.subAgents.length >= MAX_SUB_AGENTS;
  const blur = (slotId: string, field: string) => setTouched((t) => ({ ...t, [`${slotId}:${field}`]: true }));

  /** Leaving an expanded slot collapses it back to its summary once complete. */
  function leaveSlot(slot: SubAgentConfig) {
    if (isFilled(slot)) setCollapsed((c) => ({ ...c, [slot.id]: true }));
  }

  function slotErrors(slot: SubAgentConfig): SlotErrors {
    const problems = providerFieldProblems(slot);
    const pick = (field: "baseUrl" | "model" | "apiKey") =>
      touched[`${slot.id}:${field}`] && problems[field].length > 0 ? problems[field].join(", ") : undefined;
    return { baseUrl: pick("baseUrl"), model: pick("model"), apiKey: pick("apiKey") };
  }

  return (
    <div className="step-body">
      <p className="step-lead">
        Each slot is an independent provider + model + key. The worker spawns them; the supervisor
        watches every one. Pool limit is {MAX_SUB_AGENTS}.
      </p>

      <div className="slot-list">
        {draft.subAgents.map((slot, index) => {
          const isCollapsed = collapsed[slot.id] === true;
          if (isCollapsed) {
            return (
              <div key={slot.id} className="slot-card">
                <button
                  type="button"
                  className="slot-head"
                  onClick={() => setCollapsed((c) => ({ ...c, [slot.id]: false }))}
                  aria-expanded={false}
                >
                  <span className="slot-caret">
                    <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />
                  </span>
                  <span className="slot-index">{String(index + 1).padStart(2, "0")}</span>
                  <span className="slot-name">{slot.label.trim() || `sub-${index + 1}`}</span>
                  <span className="slot-summary">
                    {slot.model.trim() || "no model"} · {slot.kind}
                  </span>
                  <span className="slot-done" aria-hidden="true">
                    ready
                  </span>
                </button>
              </div>
            );
          }
          const errors = slotErrors(slot);
          return (
            <div
              key={slot.id}
              className="slot-card open"
              onBlur={(e) => {
                // Collapse only when focus leaves the whole slot, not when
                // the user tabs or clicks between the slot's own fields.
                const next = e.relatedTarget as Node | null;
                if (!next || !e.currentTarget.contains(next)) leaveSlot(slot);
              }}
            >
              <div className="slot-topline">
                <span className="slot-index">{String(index + 1).padStart(2, "0")}</span>
                <span className="slot-name">{slot.label.trim() || `sub-${index + 1}`}</span>
                {draft.subAgents.length > 1 ? (
                  <button
                    type="button"
                    className="btn danger tiny slot-remove"
                    onClick={() => removeSubAgent(slot.id)}
                  >
                    <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
                    Remove
                  </button>
                ) : null}
              </div>
              <div className="slot-body">
                <div className="field-block">
                  <label className="field-label" htmlFor={`slot-${slot.id}-label`}>
                    Label
                  </label>
                  <input
                    id={`slot-${slot.id}-label`}
                    className="field"
                    type="text"
                    value={slot.label}
                    placeholder={`sub-${index + 1}`}
                    onChange={(e) => updateSubAgent(slot.id, { label: e.target.value })}
                  />
                </div>
                <ProviderFields
                  idPrefix={`slot-${slot.id}`}
                  value={slot}
                  onChange={(next) => updateSubAgent(slot.id, next)}
                  catalog={catalog}
                  onFieldBlur={(field) => blur(slot.id, field)}
                  errors={errors}
                  compactKeyNote
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="slot-footer">
        <button type="button" className="btn" onClick={addSubAgent} disabled={full}>
          <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
          Add sub-agent
        </button>
        <span className="mono-count" aria-live="polite">
          {draft.subAgents.length} / {MAX_SUB_AGENTS}
        </span>
      </div>
      {full ? <p className="field-note">pool is full — {MAX_SUB_AGENTS} is the maximum</p> : null}
    </div>
  );
}
