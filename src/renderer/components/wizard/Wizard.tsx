import { useCallback, useEffect, useState } from "react";
import { Check, ChevronLeft, ChevronRight, CircleCheck, RotateCcw, Save } from "lucide-react";
import { MAX_SUB_AGENTS, type Bootstrap, type ProfileConfig, type ProfileMeta } from "../../../shared/types";
import { errorMessage } from "./draft";
import { StepDelegate } from "./StepDelegate";
import { StepProject } from "./StepProject";
import { StepReview } from "./StepReview";
import { StepSource } from "./StepSource";
import { StepSubAgents } from "./StepSubAgents";
import { StepTime } from "./StepTime";
import { ProfileList } from "./ProfileList";
import { useProfileState } from "./useProfileState";
import { checkStep } from "./validate";

const STEP_DEFS = [
  { id: "project", title: "Project", hint: "Name the run and point it at the one workspace it may touch." },
  {
    id: "source",
    title: "Source provider",
    hint: "The trusted, limit-proof provider. Worker and supervisor both run on it.",
  },
  {
    id: "subs",
    title: "Sub-agents",
    hint: `The worker pool. 1–${MAX_SUB_AGENTS} slots, each with its own provider, model and key.`,
  },
  {
    id: "delegate",
    title: "Delegate",
    hint: "Optional external CLI the crew can drive. None keeps everything built-in.",
  },
  {
    id: "time",
    title: "Time & rules",
    hint: "Wall-clock budget, daily work window, forbidden actions, spend cap.",
  },
  { id: "review", title: "Review", hint: "Read it back once, then save the profile." },
] as const;

const LAST_STEP = STEP_DEFS.length - 1;

/** Calm footer line shown while the current step passes its gate. */
const READY_NOTES = [
  "workspace set — next: the source provider",
  "source complete — next: the sub-agent pool",
  "pool complete — next: delegate (optional)",
  "delegate optional — next: time & rules",
  "time & rules set — next: review",
  "everything checks out — save when ready",
];

/**
 * The setup wizard. Step state lives here (no router); the draft lives in
 * useProfileState. Save goes through window.unlimited.saveProfile only —
 * startRun/panic are deliberately out of scope for Faz 1.
 */
export function Wizard() {
  const state = useProfileState();
  const [step, setStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);
  const [saved, setSaved] = useState<ProfileConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [profiles, setProfiles] = useState<ProfileMeta[]>([]);
  const [version, setVersion] = useState("");
  const [bootError, setBootError] = useState("");
  const [busyProfileId, setBusyProfileId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const boot: Bootstrap = await window.unlimited.bootstrap();
      setProfiles(boot.profiles);
      setVersion(boot.version);
      setBootError("");
    } catch (err) {
      setBootError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function jumpTo(index: number) {
    if (index > maxStep) return;
    setStep(index);
    setSaveError("");
  }

  function next() {
    const checkNow = checkStep(step, state.draft);
    if (!checkNow.ok) return;
    const nextStep = Math.min(step + 1, LAST_STEP);
    setSaveError("");
    setStep(nextStep);
    setMaxStep((m) => Math.max(m, nextStep));
  }

  function back() {
    setSaveError("");
    setStep((s) => Math.max(s - 1, 0));
  }

  async function save() {
    const check = checkStep(LAST_STEP, state.draft);
    if (!check.ok) return;
    setSaving(true);
    setSaveError("");
    try {
      const profile = state.toProfile();
      await window.unlimited.saveProfile(profile);
      setSaved(profile);
      await refresh();
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function saveAnother() {
    state.resetDraft();
    setSaved(null);
    setStep(0);
    setMaxStep(0);
    setSaveError("");
  }

  async function loadProfileById(id: string) {
    setBusyProfileId(id);
    setSaveError("");
    try {
      const profile = await window.unlimited.loadProfile(id);
      if (profile) {
        state.loadProfile(profile);
        setSaved(null);
        setStep(0);
        setMaxStep(LAST_STEP); // a loaded profile may be edited from any step
      } else {
        setSaveError(`profile ${id} could not be loaded`);
      }
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setBusyProfileId(null);
    }
  }

  async function deleteProfileById(id: string) {
    const meta = profiles.find((p) => p.id === id);
    if (!window.confirm(`Delete profile “${meta?.name || id}”? This cannot be undone.`)) return;
    setBusyProfileId(id);
    try {
      await window.unlimited.deleteProfile(id);
      await refresh();
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setBusyProfileId(null);
    }
  }

  const check = checkStep(step, state.draft);
  const isReview = step === LAST_STEP;
  return (
    <main className="wizard-main">
      <aside className="wizard-side">
        <nav className="wizard-rail" aria-label="Wizard steps">
          {STEP_DEFS.map((s, i) => {
            const reachable = i <= maxStep;
            const active = i === step && !saved;
            return (
              <button
                key={s.id}
                type="button"
                className={active ? "rail-step active" : "rail-step"}
                onClick={() => jumpTo(i)}
                disabled={!reachable}
                aria-current={active ? "step" : undefined}
              >
                <span className="rail-num">{String(i + 1).padStart(2, "0")}</span>
                <span className="rail-title">{s.title}</span>
                {i < step && !saved ? (
                  <Check size={12} strokeWidth={2} className="rail-check" aria-hidden="true" />
                ) : null}
              </button>
            );
          })}
        </nav>

        <ProfileList
          profiles={profiles}
          busyId={busyProfileId}
          onLoad={(id) => void loadProfileById(id)}
          onDelete={(id) => void deleteProfileById(id)}
        />

        {bootError ? (
          <p className="boot-error" role="alert">
            {bootError}
          </p>
        ) : null}
        <p className="side-foot">{version ? `v${version}` : "…"} · profiles under ~/.unlimited</p>
      </aside>

      <section className="wizard-stage">
        <div className="stage-inner">
          {saved ? (
            <div className="card success-panel" role="status">
              <span className="success-mark">
                <CircleCheck size={22} strokeWidth={1.75} aria-hidden="true" />
              </span>
              <h2 className="success-title">Profile saved</h2>
              <p className="mono-line ok">{saved.name || "(unnamed)"} · {saved.workspace || "no workspace"}</p>
              <p className="success-note">
                {saved.subAgents.length} sub-agent{saved.subAgents.length === 1 ? "" : "s"} in the pool ·
                budget {saved.budget.days}d{saved.budget.hours ? ` ${saved.budget.hours}h` : ""}
                {saved.budget.minutes ? ` ${saved.budget.minutes}m` : ""} · on disk, ready for a run.
              </p>
              <button type="button" className="btn primary" onClick={saveAnother}>
                <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />
                Save another
              </button>
            </div>
          ) : (
            <>
              <header className="stage-head">
                <p className="stage-kicker">
                  STEP {step + 1} / {STEP_DEFS.length}
                  {isReview ? " · FINAL" : ""}
                </p>
                <h2 className="stage-title">{STEP_DEFS[step].title}</h2>
                <p className="stage-hint">{STEP_DEFS[step].hint}</p>
              </header>

              <div className="card step-card">
                {step === 0 ? (
                  <StepProject draft={state.draft} update={state.update} />
                ) : step === 1 ? (
                  <StepSource draft={state.draft} updateSource={state.updateSource} />
                ) : step === 2 ? (
                  <StepSubAgents
                    draft={state.draft}
                    addSubAgent={state.addSubAgent}
                    removeSubAgent={state.removeSubAgent}
                    updateSubAgent={state.updateSubAgent}
                  />
                ) : step === 3 ? (
                  <StepDelegate draft={state.draft} update={state.update} />
                ) : step === 4 ? (
                  <StepTime draft={state.draft} update={state.update} />
                ) : (
                  <StepReview draft={state.draft} />
                )}
              </div>

              <footer className="step-actions">
                <p className="step-problems" aria-live="polite">
                  {check.ok ? READY_NOTES[step] : check.problems.join(" · ")}
                </p>
                <div className="action-cluster">
                  {step > 0 ? (
                    <button type="button" className="btn" onClick={back}>
                      <ChevronLeft size={14} strokeWidth={1.75} aria-hidden="true" />
                      Back
                    </button>
                  ) : null}
                  {isReview ? (
                    <button
                      type="button"
                      className="btn primary"
                      onClick={() => void save()}
                      disabled={saving || !check.ok}
                    >
                      <Save size={14} strokeWidth={1.75} aria-hidden="true" />
                      {saving ? "Saving…" : "Save profile"}
                    </button>
                  ) : (
                    <button type="button" className="btn primary" onClick={next} disabled={!check.ok}>
                      Next
                      <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </footer>

              {saveError ? (
                <p className="boot-error" role="alert">
                  {saveError}
                </p>
              ) : null}
            </>
          )}
        </div>
      </section>
    </main>
  );
}
