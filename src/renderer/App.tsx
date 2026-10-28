import { useEffect, useState } from "react";
import type { Bootstrap } from "../shared/types";

/**
 * Faz 0 boot surface. Faz 1 replaces this with the setup wizard
 * (sub-agent-owned). Keep it working: it is the smoke-test subject.
 */
export function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void window.unlimited
      .bootstrap()
      .then(setBoot)
      .catch((err) => setError(err?.message || String(err)));
  }, []);

  return (
    <div className="app">
      <header className="brand-block">
        <div className="brand-mark" aria-hidden="true" />
        <h1 className="brand-name">UNLIMITED</h1>
        <p className="brand-sub">weeks-long agent runs · worker + supervisor · forgets nothing</p>
      </header>
      <main className="boot-main">
        {error ? (
          <div className="boot-error" role="alert">
            {error}
          </div>
        ) : (
          <div className="boot-note">
            <span className="boot-version">{boot ? `v${boot.version}` : "booting…"}</span>
            <span>{boot ? `${boot.profiles.length} profile(s) on disk` : "…"}</span>
            <span>setup wizard lands with Faz 1</span>
          </div>
        )}
      </main>
    </div>
  );
}
