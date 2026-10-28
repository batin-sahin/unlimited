/**
 * Pressure thresholds and compaction decisions for the compaction engine.
 * Pure and deterministic — no I/O, no Electron, no clocks.
 */
import type { PressureZone } from "../../shared/types.js";

/** Context window assumed when a model's real limit is unknown. */
export const WINDOW_DEFAULT = 128_000;

/** Zone thresholds as fractions of the context window (used / limit). */
export const PRESSURE = { warn: 0.6, compact: 0.75, emergency: 0.85 } as const;

/** Turns to wait after a compaction before the next one may fire (hysteresis anti-thrash). */
export const COMPACT_COOLDOWN_TURNS = 3;

/** Map used/limit to a pressure zone; boundaries are inclusive (`>=`). A non-positive limit is maximal emergency. */
export function zoneFor(used: number, limit: number): PressureZone {
  if (!(limit > 0)) return "emergency";
  const ratio = Math.max(0, used) / limit;
  if (ratio >= PRESSURE.emergency) return "emergency";
  if (ratio >= PRESSURE.compact) return "compact";
  if (ratio >= PRESSURE.warn) return "warn";
  return "ok";
}

/** Compact when at or above the compact zone, but never twice within COMPACT_COOLDOWN_TURNS turns unless the zone is emergency (which always compacts). */
export function shouldCompact(used: number, limit: number, turnsSinceLast: number): boolean {
  const zone = zoneFor(used, limit);
  if (zone === "emergency") return true;
  if (zone !== "compact") return false;
  return Math.max(0, turnsSinceLast) >= COMPACT_COOLDOWN_TURNS;
}

/** How hard the engine should squeeze at the current pressure: the normal plan keeps 4 recent episodes, the emergency plan keeps 1; outputs are always elided to the cold layer. */
export function emergencyPlan(used: number, limit: number): { keepLastEpisodes: number; elideOutputs: boolean } {
  const emergency = zoneFor(used, limit) === "emergency";
  return {
    keepLastEpisodes: Math.min(8, Math.max(1, emergency ? 1 : 4)),
    elideOutputs: true,
  };
}
