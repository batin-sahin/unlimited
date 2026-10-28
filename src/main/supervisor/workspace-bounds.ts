import os from "node:os";
import path from "node:path";

/** True when `target` is `root` or lives beneath it (sibling prefixes do not count). */
function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Terminal commands may run in the system temp area; file writes may not. */
function isTemp(target: string): boolean {
  const roots = ["/tmp", os.tmpdir()];
  return roots.some((root) => isWithin(path.resolve(root), target));
}

/**
 * Deterministic workspace bounds: file tools must stay inside the workspace,
 * terminal cwd may also be the temp area. Returns the warning reason, or null.
 */
export function pathViolation(
  tool: string,
  args: Record<string, unknown>,
  workspace: string,
): string | null {
  if (!["write_file", "edit_file", "terminal"].includes(tool)) return null;
  const pathish = String(args.path || args.cwd || "");
  if (!pathish) return null;

  const root = path.resolve(workspace);
  const resolved = path.resolve(root, pathish);
  if (isWithin(root, resolved)) return null;
  if (tool === "terminal" && isTemp(resolved)) return null;

  return tool === "terminal"
    ? `Terminal cwd outside the workspace: ${pathish}`
    : `Path outside the workspace: ${pathish}`;
}
