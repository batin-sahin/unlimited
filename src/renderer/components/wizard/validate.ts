import { MAX_SUB_AGENTS } from "../../../shared/types";
import { parseDecimal, parseWhole, type WizardDraft } from "./draft";

/**
 * Per-step gate checks for the wizard footer, plus field-level problem maps
 * for live inline validation. All checks are pure functions of the draft.
 */

export interface StepCheck {
  ok: boolean;
  /** Human-readable, lower-case fragments joined by the footer. */
  problems: string[];
}

const PASS: StepCheck = { ok: true, problems: [] };

function fail(problems: string[]): StepCheck {
  return { ok: false, problems };
}

export function providerFieldProblems(p: { baseUrl: string; model: string; apiKey: string }): {
  baseUrl: string[];
  model: string[];
  apiKey: string[];
} {
  return {
    baseUrl: p.baseUrl.trim() ? [] : ["required"],
    model: p.model.trim() ? [] : ["required"],
    apiKey: p.apiKey.trim() ? [] : ["required"],
  };
}

export function checkProject(d: WizardDraft): StepCheck {
  const problems: string[] = [];
  if (!d.name.trim()) problems.push("name is required");
  if (!d.workspace.trim()) problems.push("workspace is required");
  return problems.length > 0 ? fail(problems) : PASS;
}

export function checkSource(d: WizardDraft): StepCheck {
  const problems = providerFieldProblems(d.source);
  const flat = [...problems.baseUrl, ...problems.model, ...problems.apiKey].map((p) => `source ${p}`);
  return flat.length > 0 ? fail(flat) : PASS;
}

export function checkSubAgents(d: WizardDraft): StepCheck {
  const problems: string[] = [];
  if (d.subAgents.length < 1) problems.push("at least one sub-agent is required");
  if (d.subAgents.length > MAX_SUB_AGENTS) problems.push(`at most ${MAX_SUB_AGENTS} sub-agents`);
  d.subAgents.forEach((s, i) => {
    const who = s.label.trim() || `slot ${i + 1}`;
    const fields = providerFieldProblems(s);
    for (const p of fields.baseUrl) problems.push(`${who}: base URL ${p}`);
    for (const p of fields.model) problems.push(`${who}: model ${p}`);
    for (const p of fields.apiKey) problems.push(`${who}: API key ${p}`);
  });
  return problems.length > 0 ? fail(problems) : PASS;
}

export function checkDelegate(_d: WizardDraft): StepCheck {
  // The step is optional by definition; the delegate is either complete or off.
  return PASS;
}

const TIME_RE = /^\d{2}:\d{2}$/;

export function checkTime(d: WizardDraft): StepCheck {
  const problems: string[] = [];
  const days = parseWhole(d.days);
  if (days === null) {
    problems.push("budget days must be a whole number");
  } else {
    const hours = d.hours.trim() === "" ? 0 : parseWhole(d.hours);
    const minutes = d.minutes.trim() === "" ? 0 : parseWhole(d.minutes);
    if (hours === null) problems.push("budget hours must be a whole number");
    else if (hours > 23) problems.push("budget hours must be 0–23");
    if (minutes === null) problems.push("budget minutes must be a whole number");
    else if (minutes > 59) problems.push("budget minutes must be 0–59");
    if (hours !== null && minutes !== null && days * 24 * 60 + hours * 60 + minutes <= 0) {
      problems.push("budget must be greater than zero");
    }
  }
  if (d.windowEnabled) {
    if (!TIME_RE.test(d.windowStart.trim())) problems.push("window start must be HH:mm");
    if (!TIME_RE.test(d.windowEnd.trim())) problems.push("window end must be HH:mm");
  }
  if (d.spendCapUsd.trim() !== "" && parseDecimal(d.spendCapUsd) === null) {
    problems.push("spend cap must be a number");
  }
  return problems.length > 0 ? fail(problems) : PASS;
}

export function checkReview(d: WizardDraft): StepCheck {
  const problems: string[] = [];
  for (const check of [checkProject(d), checkSource(d), checkSubAgents(d), checkTime(d)]) {
    problems.push(...check.problems);
  }
  return problems.length > 0 ? fail(problems) : PASS;
}

export function checkStep(step: number, d: WizardDraft): StepCheck {
  switch (step) {
    case 0:
      return checkProject(d);
    case 1:
      return checkSource(d);
    case 2:
      return checkSubAgents(d);
    case 3:
      return checkDelegate(d);
    case 4:
      return checkTime(d);
    default:
      return checkReview(d);
  }
}
