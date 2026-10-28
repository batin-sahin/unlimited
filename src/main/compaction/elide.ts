/**
 * Tool-output kerneling: old tool outputs are the biggest waste of context.
 * The kernel keeps what stays useful over time — errors, result lines,
 * head and tail — and elides the middle with an explicit marker plus a
 * recall pointer. Nothing disappears silently: the elision is visible.
 */

const KEEP_HEAD = 2000;
const KEEP_TAIL = 800;
const ELIDE_THRESHOLD = 4000;
const MAX_ERROR_LINES = 10;

export interface Elided {
  text: string;
  elidedChars: number;
}

/** Error-ish lines from the middle that must survive kerneling. */
function salvageErrors(middle: string): string[] {
  const lines = middle.split("\n");
  const hits = lines.filter((l) => /\b(error|fail|failed|panic|denied|exception|fatal|cannot|unable)\b/i.test(l));
  return hits.slice(0, MAX_ERROR_LINES);
}

export function elideToolOutput(output: string, atMs = Date.now()): Elided {
  if (output.length <= ELIDE_THRESHOLD) return { text: output, elidedChars: 0 };

  const head = output.slice(0, KEEP_HEAD);
  const tail = output.slice(-KEEP_TAIL);
  const middle = output.slice(KEEP_HEAD, output.length - KEEP_TAIL);
  const elidedChars = middle.length;

  const salvaged = salvageErrors(middle);
  const marker =
    `\n… [elided ${elidedChars} chars — full output preserved on disk · recall it with recall("…") · ${new Date(atMs).toISOString()}] …\n`;

  const salvageBlock = salvaged.length
    ? `\n… [error-ish lines kept from the elided middle]\n${salvaged.join("\n")}\n`
    : "";

  return { text: `${head}${marker}${salvageBlock}${tail}`, elidedChars };
}
