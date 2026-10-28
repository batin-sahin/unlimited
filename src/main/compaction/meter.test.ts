/**
 * Unit tests for the compaction engine's pure core (meter + policy).
 * Run via `npm test` (node --test, TS type stripping).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ChatMessage } from "../providers/types.js";
// Node runs these tests via native type stripping, so value imports must use
// the real .ts specifier; the repo's Bundler-style resolution forbids that at
// typecheck time. The @ts-ignore covers exactly that specifier-rule error —
// anything genuinely broken here also fails `npm test` loudly.
// @ts-ignore -- .ts specifier (see note above)
import { estimateTokens, meterMessages, meterTurn, TOOL_CALL_OVERHEAD_TOKENS } from "./meter.ts";
// @ts-ignore -- .ts specifier (see note above)
import { COMPACT_COOLDOWN_TURNS, emergencyPlan, PRESSURE, shouldCompact, WINDOW_DEFAULT, zoneFor } from "./policy.ts";

function msg(role: ChatMessage["role"], content: string): ChatMessage {
  return { role, content };
}

describe("estimateTokens", () => {
  test("empty string is 0", () => {
    assert.equal(estimateTokens(""), 0);
  });

  test("single character gets the minimum of 1", () => {
    assert.equal(estimateTokens("a"), 1);
  });

  test("exactly 4 characters is 1 token", () => {
    assert.equal(estimateTokens("abcd"), 1);
  });

  test("5 characters round up to 2 (ceil, never underestimate)", () => {
    assert.equal(estimateTokens("abcde"), 2);
  });

  test("4000 characters is 1000 tokens", () => {
    assert.equal(estimateTokens("x".repeat(4000)), 1000);
  });

  test("monotone in length: growing text never shrinks the estimate", () => {
    let prev = 0;
    for (const len of [1, 2, 3, 7, 8, 9, 100, 4096, 100_000]) {
      const now = estimateTokens("x".repeat(len));
      assert.ok(now >= prev, `estimate at len=${len} (${now}) < previous (${prev})`);
      prev = now;
    }
  });
});

describe("meterMessages", () => {
  test("empty transcript is 0", () => {
    assert.equal(meterMessages([]), 0);
  });

  test("plain messages sum their content estimates", () => {
    const messages = [msg("user", "x".repeat(40)), msg("assistant", "y".repeat(8))];
    assert.equal(meterMessages(messages), 10 + 2);
  });

  test("assistant toolCalls count arguments, name, and per-call overhead", () => {
    const message: ChatMessage = {
      role: "assistant",
      content: "abcd", // 1
      toolCalls: [
        {
          id: "call_1",
          name: "read_file", // 9 chars → 3
          arguments: '{"path":"src/index.ts"}', // 23 chars → 6
        },
      ],
    };
    assert.equal(meterMessages([message]), 1 + 3 + 6 + TOOL_CALL_OVERHEAD_TOKENS);
  });

  test("tool calls with empty arguments still cost name + overhead", () => {
    const message: ChatMessage = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_2", name: "glob", arguments: "" }],
    };
    assert.equal(meterMessages([message]), 1 + TOOL_CALL_OVERHEAD_TOKENS);
  });

  test("multiple tool calls accumulate", () => {
    const withCalls: ChatMessage = {
      role: "assistant",
      content: "abcd", // 1
      toolCalls: [
        { id: "c1", name: "read_file", arguments: '{"path":"src/index.ts"}' }, // 3 + 6
        { id: "c2", name: "glob", arguments: "" }, // 1 + 0
      ],
    };
    const withoutCalls: ChatMessage = { role: "assistant", content: "abcd" };
    const perCall = TOOL_CALL_OVERHEAD_TOKENS;
    assert.equal(meterMessages([withCalls]), meterMessages([withoutCalls]) + (3 + 6 + perCall) + (1 + 0 + perCall));
  });

  test("tool-role message content is counted like any other", () => {
    const message = msg("tool", "z".repeat(400));
    assert.equal(meterMessages([message]), 100);
  });
});

describe("meterTurn", () => {
  test("pinned is exactly estimateTokens(system)", () => {
    const system = "s".repeat(400);
    const meter = meterTurn([], system);
    assert.equal(meter.pinned, estimateTokens(system));
    assert.equal(meter.pinned, 100);
  });

  test("hot is exactly meterMessages(messages)", () => {
    const messages = [msg("user", "x".repeat(40)), msg("assistant", "y".repeat(8))];
    const meter = meterTurn(messages, "system");
    assert.equal(meter.hot, meterMessages(messages));
  });

  test("total is pinned + hot", () => {
    const messages = [msg("user", "x".repeat(40))];
    const meter = meterTurn(messages, "s".repeat(400));
    assert.equal(meter.total, meter.pinned + meter.hot);
    assert.equal(meter.total, 110);
  });

  test("empty everything is 0", () => {
    assert.deepEqual(meterTurn([], ""), { total: 0, hot: 0, pinned: 0 });
  });
});

describe("constants", () => {
  test("WINDOW_DEFAULT is 128k", () => {
    assert.equal(WINDOW_DEFAULT, 128_000);
  });

  test("PRESSURE thresholds are 0.6 / 0.75 / 0.85", () => {
    assert.deepEqual({ ...PRESSURE }, { warn: 0.6, compact: 0.75, emergency: 0.85 });
  });

  test("cooldown is 3 turns", () => {
    assert.equal(COMPACT_COOLDOWN_TURNS, 3);
  });
});

describe("zoneFor", () => {
  const LIMIT = 100_000;

  test("0 used is ok", () => {
    assert.equal(zoneFor(0, LIMIT), "ok");
  });

  test("just under 0.6 is ok", () => {
    assert.equal(zoneFor(59_999, LIMIT), "ok");
  });

  test("exactly 0.6 is warn", () => {
    assert.equal(zoneFor(60_000, LIMIT), "warn");
  });

  test("just under 0.75 is warn", () => {
    assert.equal(zoneFor(74_999, LIMIT), "warn");
  });

  test("exactly 0.75 is compact", () => {
    assert.equal(zoneFor(75_000, LIMIT), "compact");
  });

  test("just under 0.85 is compact", () => {
    assert.equal(zoneFor(84_999, LIMIT), "compact");
  });

  test("exactly 0.85 is emergency", () => {
    assert.equal(zoneFor(85_000, LIMIT), "emergency");
  });

  test("full and overfull windows are emergency", () => {
    assert.equal(zoneFor(LIMIT, LIMIT), "emergency");
    assert.equal(zoneFor(130_000, LIMIT), "emergency");
  });

  test("negative used clamps to ok, never underflows", () => {
    assert.equal(zoneFor(-5_000, LIMIT), "ok");
  });

  test("non-positive limit is emergency regardless of used", () => {
    assert.equal(zoneFor(0, 0), "emergency");
    assert.equal(zoneFor(10, 0), "emergency");
    assert.equal(zoneFor(10, -1), "emergency");
  });

  test("same ratio in a smaller window lands in the same zone", () => {
    assert.equal(zoneFor(7_500, 10_000), "compact");
    assert.equal(zoneFor(96_000, WINDOW_DEFAULT), "compact");
  });
});

describe("shouldCompact", () => {
  const LIMIT = 100_000;

  test("ok zone never compacts, no matter how long since last", () => {
    assert.equal(shouldCompact(50_000, LIMIT, 999), false);
  });

  test("warn zone never compacts", () => {
    assert.equal(shouldCompact(65_000, LIMIT, 0), false);
    assert.equal(shouldCompact(65_000, LIMIT, 999), false);
  });

  test("compact zone: blocked by cooldown at 0, 1, 2 turns", () => {
    assert.equal(shouldCompact(75_000, LIMIT, 0), false);
    assert.equal(shouldCompact(75_000, LIMIT, 1), false);
    assert.equal(shouldCompact(75_000, LIMIT, 2), false);
  });

  test("compact zone: fires exactly at the 3-turn cooldown boundary", () => {
    assert.equal(shouldCompact(75_000, LIMIT, 3), true);
    assert.equal(shouldCompact(75_000, LIMIT, 4), true);
    assert.equal(shouldCompact(75_000, LIMIT, 100), true);
  });

  test("negative turnsSinceLast is clamped to 0 (still blocked)", () => {
    assert.equal(shouldCompact(75_000, LIMIT, -1), false);
  });

  test("emergency zone compacts even immediately after a previous compaction", () => {
    assert.equal(shouldCompact(90_000, LIMIT, 0), true);
    assert.equal(shouldCompact(90_000, LIMIT, 2), true);
  });

  test("emergency via non-positive limit compacts immediately", () => {
    assert.equal(shouldCompact(10, 0, 0), true);
  });

  test("no compaction in a fresh, empty window", () => {
    assert.equal(shouldCompact(0, WINDOW_DEFAULT, 0), false);
  });
});

describe("emergencyPlan", () => {
  const LIMIT = 100_000;

  test("normal pressure: keep 4 episodes, elide outputs", () => {
    assert.deepEqual(emergencyPlan(50_000, LIMIT), { keepLastEpisodes: 4, elideOutputs: true });
  });

  test("compact zone (below emergency) still uses the normal plan", () => {
    assert.deepEqual(emergencyPlan(80_000, LIMIT), { keepLastEpisodes: 4, elideOutputs: true });
  });

  test("exactly at the emergency threshold switches to the aggressive plan", () => {
    assert.deepEqual(emergencyPlan(85_000, LIMIT), { keepLastEpisodes: 1, elideOutputs: true });
  });

  test("deep emergency keeps only 1 episode", () => {
    assert.deepEqual(emergencyPlan(95_000, LIMIT), { keepLastEpisodes: 1, elideOutputs: true });
  });

  test("overfull window gets the aggressive plan", () => {
    assert.deepEqual(emergencyPlan(200_000, LIMIT), { keepLastEpisodes: 1, elideOutputs: true });
  });

  test("non-positive limit (emergency) gets the aggressive plan", () => {
    assert.deepEqual(emergencyPlan(10, 0), { keepLastEpisodes: 1, elideOutputs: true });
  });

  test("plan values are always clamped to sane bounds", () => {
    for (const used of [0, 60_000, 75_000, 85_000, LIMIT, 1_000_000]) {
      const plan = emergencyPlan(used, LIMIT);
      assert.ok(plan.keepLastEpisodes >= 1 && plan.keepLastEpisodes <= 8, `unclamped at used=${used}`);
      assert.equal(plan.elideOutputs, true);
    }
  });
});
