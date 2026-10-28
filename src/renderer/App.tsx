import { Wizard } from "./components/wizard/Wizard";

/**
 * Faz 1 — the setup wizard owns the renderer. The brand frame stays here;
 * everything else lives under components/wizard.
 */
export function App() {
  return (
    <div className="app">
      <header className="brand-block">
        <div className="brand-mark" aria-hidden="true" />
        <h1 className="brand-name">UNLIMITED</h1>
        <p className="brand-sub">weeks-long agent runs · worker + supervisor · forgets nothing</p>
      </header>
      <Wizard />
    </div>
  );
}
