import { useCallback, useState } from "react";
import { MAX_SUB_AGENTS, type ProfileConfig, type ProviderConfig, type SubAgentConfig } from "../../../shared/types";
import { draftFromProfile, draftToProfile, emptyDraft, emptySubAgent, type WizardDraft } from "./draft";

/**
 * Single source of truth for the wizard's draft. Steps receive slices of it;
 * every mutation goes through these callbacks so steps stay stateless about
 * the profile itself.
 */
export interface ProfileState {
  draft: WizardDraft;
  update: (patch: Partial<WizardDraft>) => void;
  updateSource: (patch: Partial<ProviderConfig>) => void;
  addSubAgent: () => void;
  removeSubAgent: (id: string) => void;
  updateSubAgent: (id: string, patch: Partial<SubAgentConfig>) => void;
  loadProfile: (profile: ProfileConfig) => void;
  resetDraft: () => void;
  toProfile: () => ProfileConfig;
}

export function useProfileState(): ProfileState {
  const [draft, setDraft] = useState<WizardDraft>(emptyDraft);

  const update = useCallback((patch: Partial<WizardDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
  }, []);

  const updateSource = useCallback((patch: Partial<ProviderConfig>) => {
    setDraft((d) => ({ ...d, source: { ...d.source, ...patch } }));
  }, []);

  const addSubAgent = useCallback(() => {
    setDraft((d) =>
      d.subAgents.length >= MAX_SUB_AGENTS ? d : { ...d, subAgents: [...d.subAgents, emptySubAgent()] },
    );
  }, []);

  const removeSubAgent = useCallback((id: string) => {
    setDraft((d) => {
      if (d.subAgents.length <= 1) return d;
      return { ...d, subAgents: d.subAgents.filter((s) => s.id !== id) };
    });
  }, []);

  const updateSubAgent = useCallback((id: string, patch: Partial<SubAgentConfig>) => {
    setDraft((d) => ({
      ...d,
      subAgents: d.subAgents.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }));
  }, []);

  const loadProfile = useCallback((profile: ProfileConfig) => {
    setDraft(draftFromProfile(profile));
  }, []);

  const resetDraft = useCallback(() => {
    setDraft(emptyDraft());
  }, []);

  const toProfile = useCallback(() => draftToProfile(draft), [draft]);

  return {
    draft,
    update,
    updateSource,
    addSubAgent,
    removeSubAgent,
    updateSubAgent,
    loadProfile,
    resetDraft,
    toProfile,
  };
}
