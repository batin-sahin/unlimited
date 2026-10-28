import { useState } from "react";
import { Wizard } from "./components/wizard/Wizard";
import { RunConsole } from "./components/run/RunConsole";

type Mode = "setup" | "run";

/**
 * Faz 1/2 renderer shell: SETUP (the wizard) and RUN (the live console).
 * Both stay mounted — the run console keeps its event subscription while
 * the user is in Setup, so flipping back never loses a live run.
 */
export function App() {
  const [mode, setMode] = useState<Mode>("setup");
  const [runProfileId, setRunProfileId] = useState<string | null>(null);

  function runProfile(profileId: string) {
    setRunProfileId(profileId);
    setMode("run");
  }

  return (
    <div className="app">
      <header className="brand-block">
        <div className="brand-mark" aria-hidden="true" />
        <h1 className="brand-name">UNLIMITED</h1>
        <div className="mode-tabs" role="tablist" aria-label="Console mode">
          <button
            type="button"
            role="tab"
            className={mode === "setup" ? "mode-tab active" : "mode-tab"}
            aria-selected={mode === "setup"}
            aria-controls="pane-setup"
            onClick={() => setMode("setup")}
          >
            Setup
          </button>
          <button
            type="button"
            role="tab"
            className={mode === "run" ? "mode-tab active" : "mode-tab"}
            aria-selected={mode === "run"}
            aria-controls="pane-run"
            onClick={() => setMode("run")}
          >
            Run
          </button>
        </div>
        <p className="brand-sub">weeks-long agent runs · worker + supervisor · forgets nothing</p>
      </header>
      <div id="pane-setup" role="tabpanel" aria-label="Setup" className={mode === "setup" ? "mode-pane" : "mode-pane mode-hidden"}>
        <Wizard onRunProfile={runProfile} />
      </div>
      <div id="pane-run" role="tabpanel" aria-label="Run" className={mode === "run" ? "mode-pane" : "mode-pane mode-hidden"}>
        <RunConsole initialProfileId={runProfileId} active={mode === "run"} />
      </div>
    </div>
  );
}
