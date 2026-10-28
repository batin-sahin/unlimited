/**
 * Unit tests for the turn watchdog (pure timing, fake timers).
 * Run via node --test; the resolve shim below lets the codebase-mandated .js
 * specifiers resolve to their .ts sources under native type stripping.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, test, type TestContext } from "node:test";

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

const { TurnWatchdog, TURN_WATCHDOG_MS } = await import("./watchdog.js");

type Watchdog = InstanceType<typeof TurnWatchdog>;

interface Harness {
  wd: Watchdog;
  calls: number[];
}

/** Watchdog with a counting callback; auto-disposed with the test. */
function harness(t: TestContext, timeoutMs: number): Harness {
  const calls: number[] = [];
  const wd = new TurnWatchdog({ timeoutMs, onTimeout: () => calls.push(1) });
  t.after(() => wd.dispose());
  return { wd, calls };
}

function fakeTimers(t: TestContext): void {
  t.mock.timers.enable({ apis: ["setTimeout"] });
}

describe("TURN_WATCHDOG_MS", () => {
  test("six minutes of silence is the default deadline", () => {
    assert.equal(TURN_WATCHDOG_MS, 360_000);
  });
});

describe("TurnWatchdog", () => {
  test("fires exactly once after total silence", (t) => {
    fakeTimers(t);
    const { wd, calls } = harness(t, 1_000);
    wd.arm();
    t.mock.timers.tick(999);
    assert.equal(calls.length, 0);
    t.mock.timers.tick(1);
    assert.equal(calls.length, 1);
    t.mock.timers.tick(60_000); // long past the deadline: still exactly one
    assert.equal(calls.length, 1);
  });

  test("feed() defers the deadline from the moment of the last chunk", (t) => {
    fakeTimers(t);
    const { wd, calls } = harness(t, 1_000);
    wd.arm();
    t.mock.timers.tick(600);
    wd.feed();
    t.mock.timers.tick(600); // 600ms since feed — short of 1000ms
    assert.equal(calls.length, 0);
    t.mock.timers.tick(399);
    assert.equal(calls.length, 0);
    t.mock.timers.tick(1);
    assert.equal(calls.length, 1);
  });

  test("a stream of chunks keeps the watchdog fed indefinitely", (t) => {
    fakeTimers(t);
    const { wd, calls } = harness(t, 1_000);
    wd.arm();
    for (let i = 0; i < 20; i += 1) {
      t.mock.timers.tick(300);
      wd.feed(); // chunks every 300ms — never 1000ms of silence
    }
    assert.equal(calls.length, 0);
    t.mock.timers.tick(1_000); // silence finally
    assert.equal(calls.length, 1);
  });

  test("disarm() cancels the pending fire; later feed() is a no-op", (t) => {
    fakeTimers(t);
    const { wd, calls } = harness(t, 1_000);
    wd.arm();
    t.mock.timers.tick(500);
    wd.disarm();
    t.mock.timers.tick(60_000);
    assert.equal(calls.length, 0);
    wd.feed(); // must not resurrect the timer
    t.mock.timers.tick(60_000);
    assert.equal(calls.length, 0);
  });

  test("re-arm after a fire works and latches separately", (t) => {
    fakeTimers(t);
    const { wd, calls } = harness(t, 1_000);
    wd.arm();
    t.mock.timers.tick(1_000);
    assert.equal(calls.length, 1);
    wd.feed(); // fired watchdog is inert until re-armed
    t.mock.timers.tick(60_000);
    assert.equal(calls.length, 1);
    wd.arm();
    t.mock.timers.tick(999);
    assert.equal(calls.length, 1);
    t.mock.timers.tick(1);
    assert.equal(calls.length, 2);
  });

  test("arming twice without waiting replaces the timer (no double fire)", (t) => {
    fakeTimers(t);
    const { wd, calls } = harness(t, 1_000);
    wd.arm();
    wd.arm(); // restart: the first pending timer must be replaced
    t.mock.timers.tick(1_000);
    assert.equal(calls.length, 1);
  });

  test("dispose() cancels the timer and leaks nothing; the instance can still be re-armed", (t) => {
    fakeTimers(t);
    const { wd, calls } = harness(t, 1_000);
    wd.arm();
    t.mock.timers.tick(300);
    wd.dispose();
    wd.dispose(); // idempotent
    t.mock.timers.tick(60_000);
    assert.equal(calls.length, 0);
    wd.arm();
    t.mock.timers.tick(1_000);
    assert.equal(calls.length, 1);
  });

  test("a non-positive timeoutMs is clamped to a sane minimum instead of firing instantly or never", (t) => {
    fakeTimers(t);
    const { wd, calls } = harness(t, 0);
    wd.arm();
    t.mock.timers.tick(0);
    assert.equal(calls.length, 0);
    t.mock.timers.tick(1);
    assert.equal(calls.length, 1);
  });

  test("constructing and disposing without arming leaves no timer behind", (t) => {
    fakeTimers(t);
    const { wd, calls } = harness(t, 1_000);
    wd.dispose();
    t.mock.timers.tick(60_000);
    assert.equal(calls.length, 0);
  });
});
