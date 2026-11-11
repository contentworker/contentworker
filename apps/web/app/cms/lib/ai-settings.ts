import {
  AI_CAPABILITIES,
  AI_GUIDANCE_MAX_CHARS,
  type AiCapability,
  type AiCapabilitySetting,
  type AiSettings,
  normalizeAiGuidance,
} from '@contentworker/domain';
import { useClient } from './client-context';
import { useScopedQuery } from './queries';

/** The query key every reader of the space's AI settings shares, so a save refreshes them all. */
export const AI_SETTINGS_KEY = ['ai-settings'] as const;

/** Where an administrator turns a capability back on: what a hidden action's reason says. */
export const TURN_ON_HINT = 'A space administrator can turn it on in Settings → AI.';

/**
 * Whether the space has `capability` on, for showing what it powers. True until the settings have
 * loaded, and when they can't be read: hiding a button is a courtesy, the API is what refuses (409
 * `ai_capability_disabled`), so a slow or failed read never takes an action away.
 */
export function useAiCapability(
  capability: AiCapability,
  /** False where there is no space to read them from yet (setting up the first one). */
  enabled = true,
): boolean {
  const { client } = useClient();
  const settings = useScopedQuery(AI_SETTINGS_KEY, () => client.getAiSettings(), {
    silent: true,
    staleTime: 60_000,
    enabled,
  });
  return settings.data?.capabilities[capability].enabled ?? true;
}

/** One capability as the AI page edits it: the guidance as typed, before it is normalized. */
export interface AiCapabilityDraft {
  readonly enabled: boolean;
  readonly tier: AiCapabilitySetting['tier'];
  readonly guidance: string;
}

export type AiSettingsDraft = Readonly<Record<AiCapability, AiCapabilityDraft>>;

/** The form for `settings`: each capability as stored, its guidance as text. */
export function draftOf(settings: AiSettings): AiSettingsDraft {
  return Object.fromEntries(
    AI_CAPABILITIES.map((c) => {
      const s = settings.capabilities[c];
      return [c, { enabled: s.enabled, tier: s.tier, guidance: s.guidance ?? '' }];
    }),
  ) as Record<AiCapability, AiCapabilityDraft>;
}

/** A capability as the API will keep it, so "changed" means what saving would change. */
const keptOf = (d: AiCapabilityDraft): AiCapabilitySetting => ({
  enabled: d.enabled,
  tier: d.tier,
  guidance: normalizeAiGuidance(d.guidance),
});

/** The capabilities whose draft differs from `settings`, as a set sends them. */
export function changedCapabilities(
  settings: AiSettings,
  draft: AiSettingsDraft,
): Partial<Record<AiCapability, AiCapabilitySetting>> {
  const out: Partial<Record<AiCapability, AiCapabilitySetting>> = {};
  for (const c of AI_CAPABILITIES) {
    const kept = keptOf(draft[c]);
    const stored = settings.capabilities[c];
    if (
      kept.enabled !== stored.enabled ||
      kept.tier !== stored.tier ||
      kept.guidance !== stored.guidance
    ) {
      out[c] = kept;
    }
  }
  return out;
}

/** How long a guidance counts, as the API counts it (normalized), and whether it is over. */
export function guidanceLength(text: string): { readonly chars: number; readonly over: boolean } {
  const chars = normalizeAiGuidance(text)?.length ?? 0;
  return { chars, over: chars > AI_GUIDANCE_MAX_CHARS };
}
