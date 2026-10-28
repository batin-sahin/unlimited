import { useState } from "react";
import { FolderOpen } from "lucide-react";
import type { WizardDraft } from "./draft";
import { TextAreaField, TextField } from "./fields";

interface StepProjectProps {
  draft: WizardDraft;
  update: (patch: Partial<WizardDraft>) => void;
}

export function StepProject({ draft, update }: StepProjectProps) {
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [picking, setPicking] = useState(false);
  const blur = (key: string) => setTouched((t) => ({ ...t, [key]: true }));

  async function chooseWorkspace() {
    setPicking(true);
    try {
      const dir = await window.unlimited.pickDirectory();
      if (dir) update({ workspace: dir });
    } finally {
      setPicking(false);
    }
  }

  return (
    <div className="step-body">
      <div className="step-grid">
        <TextField
          label="Name"
          required
          value={draft.name}
          placeholder="e.g. rebuild the importer"
          onChange={(name) => update({ name })}
          onBlur={() => blur("name")}
          error={touched.name && !draft.name.trim() ? "name is required" : undefined}
        />
        <div className="field-block">
          <label className="field-label" htmlFor="wizard-workspace">
            Workspace <span className="field-req">*</span>
          </label>
          <div className="field-row">
            <input
              id="wizard-workspace"
              className="field field-mono"
              type="text"
              value={draft.workspace}
              readOnly
              placeholder="/absolute/path/to/project"
              aria-invalid={touched.workspace && !draft.workspace.trim() ? true : undefined}
              onBlur={() => blur("workspace")}
            />
            <button type="button" className="btn" onClick={() => void chooseWorkspace()} disabled={picking}>
              <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
              {picking ? "Choosing…" : "Choose…"}
            </button>
          </div>
          {touched.workspace && !draft.workspace.trim() ? (
            <p className="field-error">workspace is required — pick the project directory</p>
          ) : (
            <p className="field-note">the only directory the crew may touch</p>
          )}
        </div>
      </div>

      <TextAreaField
        label="Definition"
        value={draft.definition}
        placeholder="What is this project? Scope, stack, constraints."
        onChange={(definition) => update({ definition })}
        rows={4}
      />
      <TextAreaField
        label="Goal"
        value={draft.goal}
        placeholder="What does done look like? Measurable, single sentence."
        onChange={(goal) => update({ goal })}
        rows={3}
      />
      <TextAreaField
        label="Vision"
        value={draft.vision}
        placeholder="Where this should land eventually; the pinned north star."
        onChange={(vision) => update({ vision })}
        rows={3}
      />
      <TextAreaField
        label="Notes"
        value={draft.notes}
        placeholder="Anything else the crew should know from minute zero."
        onChange={(notes) => update({ notes })}
        rows={3}
      />
    </div>
  );
}
