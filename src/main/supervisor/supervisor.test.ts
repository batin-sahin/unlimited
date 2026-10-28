/**
 * Unit tests for the supervisor's deterministic workspace bounds.
 * Run via node --test; the resolve shim below lets the codebase-mandated .js
 * specifiers resolve to their .ts sources under native type stripping.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

// ---- runtime shim for `node --test` on TypeScript sources (same as recall.test.ts) ----
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".js") && context.parentURL?.endsWith(".ts")) {
      try {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      } catch {
        /* no .ts twin — use the original specifier */
      }
    }
    return nextResolve(specifier, context);
  },
});

const { pathViolation } = await import("./workspace-bounds.js");

const WS = path.resolve("/Users/example/project");

describe("pathViolation", () => {
  test("terminal cwd equal to the workspace is allowed", () => {
    assert.equal(pathViolation("terminal", { cwd: WS }, WS), null);
  });

  test("relative terminal cwd inside the workspace is allowed", () => {
    assert.equal(pathViolation("terminal", { cwd: "src/main" }, WS), null);
  });

  test("terminal cwd under the system temp area is allowed", () => {
    assert.equal(pathViolation("terminal", { cwd: path.join(os.tmpdir(), "unlimited-test") }, WS), null);
  });

  test("terminal cwd outside the workspace and temp is flagged", () => {
    assert.match(
      pathViolation("terminal", { cwd: path.resolve("/Users/example/other") }, WS) ?? "",
      /^Terminal cwd outside the workspace:/,
    );
  });

  test("file writes inside the workspace are allowed", () => {
    assert.equal(pathViolation("write_file", { path: "src/agent.ts" }, WS), null);
    assert.equal(pathViolation("edit_file", { path: path.join(WS, "src/agent.ts") }, WS), null);
  });

  test("file writes outside the workspace are flagged", () => {
    assert.match(
      pathViolation("write_file", { path: "/Users/example/.ssh/authorized_keys" }, WS) ?? "",
      /^Path outside the workspace:/,
    );
  });

  test("a sibling with the workspace prefix does not count as inside", () => {
    assert.match(
      pathViolation("edit_file", { path: `${WS}-evil/file.ts` }, WS) ?? "",
      /^Path outside the workspace:/,
    );
  });

  test("tools without a path argument are not checked", () => {
    assert.equal(pathViolation("read_file", { path: "/etc/passwd" }, WS), null);
    assert.equal(pathViolation("terminal", {}, WS), null);
  });
});
