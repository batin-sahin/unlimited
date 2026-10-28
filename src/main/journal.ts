import fs from "node:fs";
import path from "node:path";
import type { RunEvent } from "../shared/types.js";
import { unlimitedHome } from "./profiles.js";

/**
 * Append-only run journal: one JSONL file per run under
 * ~/.unlimited/runs/<runId>.jsonl. This is the crash-recovery source of
 * truth (Faz 5 resume reads it back) and the cold layer's frame store.
 */
export class Journal {
  private stream: fs.WriteStream;

  constructor(readonly runId: string) {
    const dir = path.join(unlimitedHome(), "runs");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.stream = fs.createWriteStream(path.join(dir, `${runId}.jsonl`), {
      flags: "a",
      mode: 0o600,
    });
  }

  append(event: RunEvent): void {
    this.stream.write(`${JSON.stringify(event)}\n`);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}
