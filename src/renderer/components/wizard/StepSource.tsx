import { useState } from "react";
import type { WizardDraft } from "./draft";
import { ProviderFields } from "./ProviderFields";
import { providerFieldProblems } from "./validate";

interface StepSourceProps {
  draft: WizardDraft;
  updateSource: (patch: Partial<WizardDraft["source"]>) => void;
}

/**
 * Step 2 — the trusted "limit-proof" provider. Worker AND supervisor run on
 * it, so every field is required and validated live.
 */
export function StepSource({ draft, updateSource }: StepSourceProps) {
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const blur = (key: string) => setTouched((t) => ({ ...t, [key]: true }));
  const problems = providerFieldProblems(draft.source);
  const errorFor = (key: "baseUrl" | "model" | "apiKey") =>
    touched[key] && problems[key].length > 0 ? problems[key].join(", ") : undefined;

  return (
    <div className="step-body">
      <p className="step-lead">
        Worker and supervisor both run on this provider. It must hold the line under a weeks-long
        run, so every field is required.
      </p>
      <ProviderFields
        idPrefix="source"
        value={draft.source}
        onChange={updateSource}
        onFieldBlur={(field) => blur(field)}
        errors={{
          baseUrl: errorFor("baseUrl"),
          model: errorFor("model"),
          apiKey: errorFor("apiKey"),
        }}
      />
      <div className="field-block">
        <span className="field-label" aria-hidden="true">
          Live check
        </span>
        <p className="mono-line" aria-live="polite">
          {problems.baseUrl.length + problems.model.length + problems.apiKey.length === 0
            ? "source provider complete — kind, endpoint, model and key set"
            : `missing: ${[...problems.baseUrl, ...problems.model, ...problems.apiKey].join(" · ")}`}
        </p>
      </div>
    </div>
  );
}
