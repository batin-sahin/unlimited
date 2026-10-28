import {
  MAX_SUB_AGENTS,
  type DelegateKind,
  type ProfileConfig,
  type ProviderConfig,
  type ProviderKind,
  type SubAgentConfig,
  type TimeBudget,
} from "../../../shared/types";

/**
 * The wizard edits a string-shaped draft so every control can be a plain
 * controlled input, then `draftToProfile` produces the locked ProfileConfig.
 * Numeric contract fields (days/hours/minutes/spendCapUsd) live here as
 * strings and are parsed once, at the boundary.
 */

export interface WizardDraft {
  id: string;
  name: string;
  workspace: string;
  definition: string;
  goal: string;
  vision: string;
  notes: string;
  source: ProviderConfig;
  subAgents: SubAgentConfig[];
  /** "none" means no delegate — the profile gets `delegate: null`. */
  delegateKind: DelegateKind | "none";
  delegateInstructions: string;
  days: string;
  hours: string;
  minutes: string;
  windowEnabled: boolean;
  windowStart: string;
  windowEnd: string;
  /** One forbidden rule per line; split on save. */
  forbiddenText: string;
  spendCapUsd: string;
}

export const DEFAULT_BASE_URL: Record<ProviderKind, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  // Google client builds {base}/models/<model>:streamGenerateContent?alt=sse,
  // so the v1beta path must be part of the base URL.
  google: "https://generativelanguage.googleapis.com/v1beta",
};

export const DEFAULT_PROVIDER_KIND: ProviderKind = "openai";
export const DEFAULT_WINDOW_START = "09:00";
export const DEFAULT_WINDOW_END = "17:00";

export function emptyProvider(): ProviderConfig {
  return {
    kind: DEFAULT_PROVIDER_KIND,
    baseUrl: DEFAULT_BASE_URL[DEFAULT_PROVIDER_KIND],
    model: "",
    apiKey: "",
  };
}

export function emptySubAgent(): SubAgentConfig {
  return { ...emptyProvider(), id: crypto.randomUUID(), label: "" };
}

export function emptyDraft(): WizardDraft {
  return {
    id: crypto.randomUUID(),
    name: "",
    workspace: "",
    definition: "",
    goal: "",
    vision: "",
    notes: "",
    source: emptyProvider(),
    subAgents: [emptySubAgent()],
    delegateKind: "none",
    delegateInstructions: "",
    days: "",
    hours: "",
    minutes: "",
    windowEnabled: false,
    windowStart: DEFAULT_WINDOW_START,
    windowEnd: DEFAULT_WINDOW_END,
    forbiddenText: "",
    spendCapUsd: "",
  };
}

/**
 * Switching kind keeps a customized baseUrl but swaps in the new kind's
 * default when the field is empty or still holds the previous default.
 */
export function withProviderKind(provider: ProviderConfig, kind: ProviderKind): ProviderConfig {
  if (provider.kind === kind) return provider;
  const onDefault = provider.baseUrl.trim() === "" || provider.baseUrl === DEFAULT_BASE_URL[provider.kind];
  return { ...provider, kind, baseUrl: onDefault ? DEFAULT_BASE_URL[kind] : provider.baseUrl };
}

/** Tolerant normalization for profiles loaded off disk (Faz 0 files). */
function normalizeProvider(p: Partial<ProviderConfig> | undefined): ProviderConfig {
  const base = emptyProvider();
  if (!p || typeof p !== "object") return base;
  const kind: ProviderKind = p.kind === "anthropic" || p.kind === "google" ? p.kind : "openai";
  return {
    kind,
    baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : DEFAULT_BASE_URL[kind],
    model: typeof p.model === "string" ? p.model : "",
    apiKey: typeof p.apiKey === "string" ? p.apiKey : "",
  };
}

function normalizeSubAgent(s: Partial<SubAgentConfig> | undefined, index: number): SubAgentConfig {
  const provider = normalizeProvider(s);
  return {
    ...provider,
    id: typeof s?.id === "string" && s.id ? s.id : crypto.randomUUID(),
    label: typeof s?.label === "string" ? s.label : `sub-${index + 1}`,
  };
}

export function draftFromProfile(p: ProfileConfig): WizardDraft {
  const subAgents = Array.isArray(p.subAgents)
    ? p.subAgents.map((s, i) => normalizeSubAgent(s as Partial<SubAgentConfig>, i))
    : [];
  return {
    id: p.id,
    name: p.name ?? "",
    workspace: p.workspace ?? "",
    definition: p.definition ?? "",
    goal: p.goal ?? "",
    vision: p.vision ?? "",
    notes: p.notes ?? "",
    source: normalizeProvider(p.source),
    subAgents: subAgents.length > 0 ? subAgents : [emptySubAgent()],
    delegateKind: p.delegate ? p.delegate.kind : "none",
    delegateInstructions: p.delegate?.instructions ?? "",
    days: p.budget?.days === undefined ? "" : String(p.budget.days),
    hours: p.budget?.hours === undefined ? "" : String(p.budget.hours),
    minutes: p.budget?.minutes === undefined ? "" : String(p.budget.minutes),
    windowEnabled: p.window?.enabled ?? false,
    windowStart: p.window?.start || DEFAULT_WINDOW_START,
    windowEnd: p.window?.end || DEFAULT_WINDOW_END,
    forbiddenText: Array.isArray(p.forbidden) ? p.forbidden.join("\n") : "",
    spendCapUsd: p.spendCapUsd === undefined ? "" : String(p.spendCapUsd),
  };
}

export function draftToProfile(d: WizardDraft): ProfileConfig {
  const cap = d.spendCapUsd.trim();
  const budget: TimeBudget = {
    days: parseWhole(d.days) ?? 0,
  };
  if (d.hours.trim() !== "") budget.hours = parseWhole(d.hours) ?? 0;
  if (d.minutes.trim() !== "") budget.minutes = parseWhole(d.minutes) ?? 0;

  return {
    id: d.id,
    name: d.name.trim(),
    workspace: d.workspace.trim(),
    definition: d.definition.trim(),
    goal: d.goal.trim(),
    vision: d.vision.trim(),
    notes: d.notes.trim(),
    source: trimProvider(d.source),
    subAgents: d.subAgents.map((s, i) => ({
      id: s.id,
      label: s.label.trim() || `sub-${i + 1}`,
      ...trimProvider(s),
    })),
    delegate:
      d.delegateKind === "none"
        ? null
        : { kind: d.delegateKind, instructions: d.delegateInstructions.trim() },
    budget,
    window: {
      enabled: d.windowEnabled,
      start: d.windowStart.trim() || DEFAULT_WINDOW_START,
      end: d.windowEnd.trim() || DEFAULT_WINDOW_END,
    },
    forbidden: splitLines(d.forbiddenText),
    spendCapUsd: cap === "" ? undefined : Number(cap),
  };
}

function trimProvider(p: ProviderConfig): ProviderConfig {
  return { kind: p.kind, baseUrl: p.baseUrl.trim(), model: p.model.trim(), apiKey: p.apiKey.trim() };
}

export function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Non-negative integer, or null when the string is not one. */
export function parseWhole(value: string): number | null {
  const t = value.trim();
  return /^\d+$/.test(t) ? Number.parseInt(t, 10) : null;
}

/** Non-negative decimal, or null when the string is not one. */
export function parseDecimal(value: string): number | null {
  const t = value.trim();
  return /^\d+(\.\d+)?$/.test(t) ? Number.parseFloat(t) : null;
}

/** IPC and storage errors arrive as unknown; render them as one line. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

export function formatBudget(b: TimeBudget): string {
  const parts: string[] = [];
  if (b.days > 0) parts.push(`${b.days}d`);
  if (b.hours) parts.push(`${b.hours}h`);
  if (b.minutes) parts.push(`${b.minutes}m`);
  return parts.length > 0 ? parts.join(" ") : "0m";
}

export function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Never renders a live key: dots plus, when long enough, the last 4 chars. */
export function maskKey(key: string): string {
  if (!key) return "—";
  if (key.length <= 8) return "•".repeat(key.length);
  return `••••••••${key.slice(-4)}`;
}

export const MAX_SUB_AGENT_SLOTS = MAX_SUB_AGENTS;
