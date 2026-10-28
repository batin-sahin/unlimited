import { execFile } from "node:child_process";
import type { DelegateHealth, DelegateKind } from "../../shared/types";

/** The headless binaries behind each delegate option. */
const BINS: Record<DelegateKind, string> = {
  opencode: "opencode",
  "claude-code": "claude",
  codex: "codex",
  kimi: "kimi",
};

/**
 * v0 health check: is the binary on PATH, and does it answer `--version`
 * within 8 seconds? The full headless round-trip lands with the adapters.
 */
export function checkDelegateHealth(kind: DelegateKind): Promise<DelegateHealth> {
  const binary = BINS[kind];
  return new Promise((resolve) => {
    execFile(binary, ["--version"], { timeout: 8000 }, (err, stdout, stderr) => {
      const installed = !(err && (err as NodeJS.ErrnoException).code === "ENOENT");
      const text = (stdout || stderr || "").toString().split("\n")[0].trim().slice(0, 80);
      const responds = installed && !err;
      resolve({
        kind,
        binary,
        installed,
        responds,
        version: responds ? text : "",
        checkedAt: Date.now(),
        error: !installed ? `${binary}: not found on PATH` : err ? `${binary}: ${err.message}`.slice(0, 120) : "",
      });
    });
  });
}
