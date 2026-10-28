import type { WizardDraft } from "./draft";
import { CheckboxField, NumberField, TextAreaField } from "./fields";
import { parseDecimal, parseWhole } from "./draft";

interface StepTimeProps {
  draft: WizardDraft;
  update: (patch: Partial<WizardDraft>) => void;
}

/** Step 5 — wall-clock budget, daily window, forbidden list, spend cap. */
export function StepTime({ draft, update }: StepTimeProps) {
  const days = parseWhole(draft.days);
  const hours = draft.hours.trim() === "" ? 0 : parseWhole(draft.hours);
  const minutes = draft.minutes.trim() === "" ? 0 : parseWhole(draft.minutes);
  const budgetKnown = days !== null && hours !== null && minutes !== null;
  const cap = parseDecimal(draft.spendCapUsd);

  return (
    <div className="step-body">
      <p className="step-lead">
        The wall-clock budget only ticks while the run is unpaused and the daily window is open.
      </p>

      <div className="field-block">
        <span className="field-label" id="budget-label">
          Budget
        </span>
        <div className="step-grid three" role="group" aria-labelledby="budget-label">
          <NumberField
            label="Days"
            required
            min={0}
            value={draft.days}
            placeholder="3"
            onChange={(daysValue) => update({ days: daysValue })}
            error={
              draft.days.trim() !== "" && days === null ? "days must be a whole number" : undefined
            }
            note="required — whole days of work"
          />
          <NumberField
            label="Hours"
            min={0}
            max={23}
            value={draft.hours}
            placeholder="0–23"
            onChange={(hoursValue) => update({ hours: hoursValue })}
            error={hours === null ? "0–23" : undefined}
            note="optional"
          />
          <NumberField
            label="Minutes"
            min={0}
            max={59}
            value={draft.minutes}
            placeholder="0–59"
            onChange={(minutesValue) => update({ minutes: minutesValue })}
            error={minutes === null ? "0–59" : undefined}
            note="optional"
          />
        </div>
        {budgetKnown && days * 24 * 60 + hours * 60 + minutes <= 0 ? (
          <p className="field-error">budget must be greater than zero</p>
        ) : null}
      </div>

      <div className="field-block">
        <CheckboxField
          label="Daily window — the run only works inside these hours"
          checked={draft.windowEnabled}
          onChange={(windowEnabled) => update({ windowEnabled })}
        />
        <div className={draft.windowEnabled ? "step-grid window on" : "step-grid window"}>
          <label className="field-block" htmlFor="window-start">
            <span className="field-label">Start (inclusive)</span>
            <input
              id="window-start"
              className="field field-mono"
              type="time"
              value={draft.windowStart}
              disabled={!draft.windowEnabled}
              onChange={(e) => update({ windowStart: e.target.value })}
            />
          </label>
          <label className="field-block" htmlFor="window-end">
            <span className="field-label">End (exclusive)</span>
            <input
              id="window-end"
              className="field field-mono"
              type="time"
              value={draft.windowEnd}
              disabled={!draft.windowEnabled}
              onChange={(e) => update({ windowEnd: e.target.value })}
            />
          </label>
        </div>
      </div>

      <TextAreaField
        label="Forbidden — one rule per line"
        note="Things that must never be done or touched. Each line is one rule."
        value={draft.forbiddenText}
        placeholder={"never push to main\nnever delete the migrations directory"}
        onChange={(forbiddenText) => update({ forbiddenText })}
        rows={4}
      />

      <NumberField
        label="Spend cap (USD)"
        min={0}
        step={0.01}
        value={draft.spendCapUsd}
        placeholder="e.g. 25.00"
        onChange={(spendCapUsd) => update({ spendCapUsd })}
        error={
          draft.spendCapUsd.trim() !== "" && cap === null ? "spend cap must be a number" : undefined
        }
        note="optional — hard ceiling on API spend for the whole run"
      />
    </div>
  );
}
