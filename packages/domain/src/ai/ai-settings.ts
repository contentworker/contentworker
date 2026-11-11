/**
 * A space's AI settings: per capability, whether it is on, the model tier it runs on, and the
 * guidance its administrators add to the built-in prompt. One document per space (not per
 * environment: it governs what people and agents may ask of the models, not content), versioned,
 * each set a compare-and-set on its version.
 *
 * Capabilities are a short, stable list an administrator can read: each names a kind of work, not a
 * surface, so turning one off stops it everywhere it runs (the admin, REST, MCP, Coworker, a
 * workflow node). A space never configured reads as every capability on, at its call sites' own
 * tiers, with no guidance: what the space did before settings existed.
 */

import { DomainError, ValidationError } from '../errors';

/** The model tiers a capability can be pinned to (the AI port's `ModelTier`). */
export const MODEL_TIERS = ['flagship', 'balanced', 'fast'] as const;
export type AiModelTier = (typeof MODEL_TIERS)[number];

export const isAiModelTier = (value: unknown): value is AiModelTier =>
  typeof value === 'string' && (MODEL_TIERS as readonly string[]).includes(value);

/** Cheapest first: what a cap compares tiers by. */
const TIER_RANK: Readonly<Record<AiModelTier, number>> = { fast: 0, balanced: 1, flagship: 2 };

/**
 * `tier` held to the deployment's cap (AI_MAX_TIER): the cap when `tier` is above it, else `tier`.
 * No cap (undefined) is the same as `flagship`: nothing is above it.
 */
export function capModelTier(tier: AiModelTier, max: AiModelTier | undefined): AiModelTier {
  return max !== undefined && TIER_RANK[tier] > TIER_RANK[max] ? max : tier;
}

/** Whether `tier` is above the cap, so a call asking for it runs on the cap instead. */
export const isAboveTierCap = (tier: AiModelTier, max: AiModelTier | undefined): boolean =>
  capModelTier(tier, max) !== tier;

/** The AI capabilities a space can turn on or off, tune and guide, in the order the admin lists. */
export const AI_CAPABILITIES = [
  'drafting',
  'layout',
  'assistant',
  'field-assist',
  'translation',
  'media',
  'search',
  'agents',
  'workflows',
] as const;
export type AiCapability = (typeof AI_CAPABILITIES)[number];

export const isAiCapability = (value: unknown): value is AiCapability =>
  typeof value === 'string' && (AI_CAPABILITIES as readonly string[]).includes(value);

/**
 * What each capability is called and covers, as an administrator reads it (the admin's AI page,
 * the API reference, the refusal a disabled one answers with). `guided`: whether its guidance
 * reaches a prompt at all (embeddings have none).
 */
export const AI_CAPABILITY_INFO: Readonly<
  Record<
    AiCapability,
    { readonly label: string; readonly covers: string; readonly guided: boolean }
  >
> = {
  drafting: {
    label: 'Drafting',
    covers: 'Drafting an entry from a brief, and turning canvas prose into an entry.',
    guided: true,
  },
  layout: {
    label: 'Page layouts',
    covers: 'Composing blocks for a page from a brief, in the canvas, the API and Coworker.',
    guided: true,
  },
  assistant: {
    label: 'Coworker',
    covers: 'The assistant in the admin: its conversations and the changes it proposes.',
    guided: true,
  },
  'field-assist': {
    label: 'Writing help',
    covers:
      'Filling a field, summarizing an entry or the changes between its versions, suggesting tags, and running AI actions.',
    guided: true,
  },
  translation: {
    label: 'Translation',
    covers: 'Translating an entry into another locale, from the editor, the API or a workflow.',
    guided: true,
  },
  media: {
    label: 'Media',
    covers: 'Alt text and tags for assets, on upload and on request.',
    guided: true,
  },
  search: {
    label: 'Semantic search',
    covers:
      'Embedding entries and assets for search, reading the text of uploaded documents and recordings, semantic and related-entry search, and duplicate checks.',
    guided: false,
  },
  agents: {
    label: 'Agents',
    covers:
      'Background agents: enrichment on publish, scheduled agents, entry audits, and promotion reviews.',
    guided: true,
  },
  workflows: {
    label: 'Workflows',
    covers:
      'The workflow copilot, and the AI steps in workflow runs (classify, route, assess, enrich).',
    guided: true,
  },
};

/** Longest guidance one capability keeps, in characters. */
export const AI_GUIDANCE_MAX_CHARS = 2000;

/** One capability's settings. */
export interface AiCapabilitySetting {
  /** Off: the capability refuses (on request) or is skipped (in the background). */
  readonly enabled: boolean;
  /** The tier its calls run on; null: each call site's own default. */
  readonly tier: AiModelTier | null;
  /** Plain text added to its built-in prompt as quoted guidance; null: none. */
  readonly guidance: string | null;
}

/** A space's AI settings. */
export interface AiSettings {
  /** 0 before the first set, then one more for each set that changed something. */
  readonly version: number;
  /** Every capability, in {@link AI_CAPABILITIES} order. */
  readonly capabilities: Readonly<Record<AiCapability, AiCapabilitySetting>>;
  readonly updatedAt: string | null;
  /** Who set it, as the audit trail names them. */
  readonly updatedBy: string | null;
}

/** One capability as the surfaces report it: as set, and the tier it actually runs on. */
export interface AiCapabilityView extends AiCapabilitySetting {
  /**
   * `tier` held to the deployment's cap; null when `tier` is (each call site's own default, which
   * the cap holds the same way).
   */
  readonly effectiveTier: AiModelTier | null;
}

/**
 * The settings as REST, MCP and the admin read them: as stored, with the deployment's tier cap
 * and what it makes of each capability's tier. A tier above the cap is kept as set (lowering the
 * cap never rewrites a space's settings, and raising it again restores them) and reported here.
 */
export interface AiSettingsView extends Omit<AiSettings, 'capabilities'> {
  /** The most capable tier this deployment runs (AI_MAX_TIER); `flagship` is no cap. */
  readonly maxTier: AiModelTier;
  readonly capabilities: Readonly<Record<AiCapability, AiCapabilityView>>;
}

export function aiSettingsView(
  settings: AiSettings,
  maxTier: AiModelTier | undefined,
): AiSettingsView {
  const capabilities = Object.fromEntries(
    AI_CAPABILITIES.map((c) => {
      const s = settings.capabilities[c];
      return [c, { ...s, effectiveTier: s.tier === null ? null : capModelTier(s.tier, maxTier) }];
    }),
  ) as Record<AiCapability, AiCapabilityView>;
  return { ...settings, maxTier: maxTier ?? 'flagship', capabilities };
}

export const DEFAULT_AI_CAPABILITY_SETTING: AiCapabilitySetting = {
  enabled: true,
  tier: null,
  guidance: null,
};

/** A capability map with every capability at its default. */
const defaultCapabilities = (): Record<AiCapability, AiCapabilitySetting> =>
  Object.fromEntries(AI_CAPABILITIES.map((c) => [c, DEFAULT_AI_CAPABILITY_SETTING])) as Record<
    AiCapability,
    AiCapabilitySetting
  >;

/** The settings of a space no one has configured: everything on, as before settings existed. */
export const DEFAULT_AI_SETTINGS: AiSettings = {
  version: 0,
  capabilities: defaultCapabilities(),
  updatedAt: null,
  updatedBy: null,
};

/**
 * A stored capability map read back: each known capability as stored, or at its default when the
 * document predates it (a capability added later is on until someone turns it off), and anything
 * the document names that isn't a capability (any more) left out.
 */
export function aiCapabilitiesFrom(
  stored: Readonly<Record<string, Partial<AiCapabilitySetting> | undefined>>,
): Record<AiCapability, AiCapabilitySetting> {
  const out = defaultCapabilities();
  for (const capability of AI_CAPABILITIES) {
    const s = stored[capability];
    if (!s) continue;
    out[capability] = {
      enabled: s.enabled !== false,
      tier: (MODEL_TIERS as readonly unknown[]).includes(s.tier) ? (s.tier as AiModelTier) : null,
      guidance: typeof s.guidance === 'string' && s.guidance ? s.guidance : null,
    };
  }
  return out;
}

/**
 * Guidance as it is kept: line endings made `\n`, trailing space trimmed, and nothing (null) when
 * nothing is left. Its length is checked after this, so what is counted is what is kept.
 */
export function normalizeAiGuidance(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const kept = text.replace(/\r\n?/g, '\n').trim();
  return kept ? kept : null;
}

/** One capability as a set sends it: `enabled` required, the rest back to the default when left out. */
export interface AiCapabilityInput {
  readonly enabled: boolean;
  readonly tier?: AiModelTier | null;
  readonly guidance?: string | null;
}

/**
 * The capabilities a set changes, checked: each named capability replaced whole, the rest left as
 * `current` has them. 422 naming each part that isn't a capability, a tier or guidance within
 * {@link AI_GUIDANCE_MAX_CHARS} (after {@link normalizeAiGuidance}), whatever surface sent it.
 */
export function applyAiSettingsInput(
  current: Readonly<Record<AiCapability, AiCapabilitySetting>>,
  input: unknown,
): Record<AiCapability, AiCapabilitySetting> {
  const issues: { field: string; message: string }[] = [];
  const next: Record<AiCapability, AiCapabilitySetting> = { ...current };
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError([
      { field: 'capabilities', message: 'An object of capabilities by id' },
    ]);
  }
  for (const [id, raw] of Object.entries(input as Record<string, unknown>)) {
    const field = `capabilities.${id}`;
    if (!isAiCapability(id)) {
      issues.push({
        field,
        message: `Not an AI capability; one of ${AI_CAPABILITIES.join(', ')}`,
      });
      continue;
    }
    const s = raw as Partial<Record<keyof AiCapabilityInput, unknown>> | null;
    if (typeof s !== 'object' || s === null || Array.isArray(s)) {
      issues.push({ field, message: 'An object with enabled, tier and guidance' });
      continue;
    }
    if (typeof s.enabled !== 'boolean') {
      issues.push({ field: `${field}.enabled`, message: 'true or false' });
    }
    const tier = s.tier ?? null;
    if (tier !== null && !(MODEL_TIERS as readonly unknown[]).includes(tier)) {
      issues.push({
        field: `${field}.tier`,
        message: `One of ${MODEL_TIERS.join(', ')}, or null for the default`,
      });
    }
    let guidance: string | null = null;
    if (s.guidance !== undefined && s.guidance !== null && typeof s.guidance !== 'string') {
      issues.push({ field: `${field}.guidance`, message: 'Plain text, or null for none' });
    } else {
      guidance = normalizeAiGuidance(s.guidance as string | null | undefined);
      if (guidance && guidance.length > AI_GUIDANCE_MAX_CHARS) {
        issues.push({
          field: `${field}.guidance`,
          message: `At most ${AI_GUIDANCE_MAX_CHARS} characters (it has ${guidance.length})`,
        });
      }
    }
    // A capability with no prompt (search runs on the embedding model) takes no tier or guidance.
    if (!AI_CAPABILITY_INFO[id].guided && (tier !== null || guidance !== null)) {
      issues.push({
        field,
        message: `${AI_CAPABILITY_INFO[id].label} has no prompt: it takes no tier or guidance`,
      });
    }
    next[id] = {
      enabled: s.enabled === true,
      tier: tier as AiModelTier | null,
      guidance,
    };
  }
  if (issues.length > 0) throw new ValidationError(issues);
  return next;
}

/** What a set of the AI settings changed, for its audit row: parts named, never guidance text. */
export interface AiSettingsChange {
  readonly from: number;
  readonly to: number;
  /** `<capability>.enabled`, `<capability>.tier`, `<capability>.guidance`, in capability order. */
  readonly changed: readonly string[];
}

export function diffAiSettings(
  before: Pick<AiSettings, 'version' | 'capabilities'>,
  after: Pick<AiSettings, 'version' | 'capabilities'>,
): AiSettingsChange {
  const changed: string[] = [];
  for (const c of AI_CAPABILITIES) {
    const a = before.capabilities[c];
    const b = after.capabilities[c];
    if (a.enabled !== b.enabled) changed.push(`${c}.enabled`);
    if (a.tier !== b.tier) changed.push(`${c}.tier`);
    if (a.guidance !== b.guidance) changed.push(`${c}.guidance`);
  }
  return { from: before.version, to: after.version, changed };
}

/**
 * A capability the space's administrators turned off (maps to HTTP 409, like the other refusals
 * that come from how a space is configured). Not retryable as it stands: an administrator turns
 * it back on in Settings → AI.
 */
export class AiCapabilityDisabledError extends DomainError {
  readonly capability: AiCapability;
  constructor(capability: AiCapability) {
    super(
      'ai_capability_disabled',
      `${AI_CAPABILITY_INFO[capability].label} (AI capability "${capability}") is turned off ` +
        'for this space. A space administrator can turn it on in Settings → AI.',
      { capability },
    );
    this.capability = capability;
  }
}
