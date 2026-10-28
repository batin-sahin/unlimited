import type { DelegateKind } from "../../shared/types.js";

/** One headless delegation: run a prompt through an external CLI. */
export interface DelegateRun {
  prompt: string;
  workspace: string;
  signal: AbortSignal;
  /** Streaming output pieces (tool-visible feed). */
  onOutput?: (piece: string) => void;
}

export interface DelegateOutcome {
  text: string;
  exitCode: number | null;
  timedOut: boolean;
}
