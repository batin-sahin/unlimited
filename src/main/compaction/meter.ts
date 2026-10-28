/**
 * Token accounting for the compaction engine.
 * Pure functions only — no I/O, no Electron. Estimates feed *relative*
 * pressure (zones and thresholds), which tolerates error far better than
 * exactness would require: what matters is a stable, monotone-in-length
 * measure, not tokenizer-grade precision.
 */
import type { ChatMessage } from "../providers/types.js";

/**
 * Rough token estimate: text length divided by 4, rounded up, minimum 1.
 * Honest caveat: real tokenizers vary by model and content (code runs ~3
 * chars/token, prose 5+), so expect ~±20% error against true counts. The
 * engine only needs consistent relative pressure to pick zones and fire
 * compaction — a stable over-estimate is safer than an exact under-estimate.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Fixed per-tool-call overhead (id, name field, role framing) in tokens. */
export const TOOL_CALL_OVERHEAD_TOKENS = 8;

/** Total hot-layer tokens across a transcript: every message's content, plus each assistant tool call's arguments and name overhead — tool call args are context too. */
export function meterMessages(messages: ChatMessage[]): number {
  let tokens = 0;
  for (const message of messages) {
    tokens += estimateTokens(message.content);
    if (message.role === "assistant" && message.toolCalls) {
      for (const call of message.toolCalls) {
        tokens += estimateTokens(call.name) + estimateTokens(call.arguments) + TOOL_CALL_OVERHEAD_TOKENS;
      }
    }
  }
  return tokens;
}

/** Meter one turn: `pinned` is the system block, `hot` the transcript; `total` is what the provider will actually see. */
export function meterTurn(
  messages: ChatMessage[],
  system: string,
): { total: number; hot: number; pinned: number } {
  const pinned = estimateTokens(system);
  const hot = meterMessages(messages);
  return { total: pinned + hot, hot, pinned };
}
