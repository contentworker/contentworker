import {
  AI_CAPABILITY_INFO,
  AI_GUIDANCE_MAX_CHARS,
  type AiCapability,
  AiCapabilityDisabledError,
  type AiCapabilitySetting,
  type AiSettings,
  type AiSettingsView,
  aiSettingsView,
  applyAiSettingsInput,
  ConflictError,
  canonicalJson,
  capModelTier,
  DEFAULT_AI_SETTINGS,
  diffAiSettings,
  type Scope,
} from '@contentworker/domain';
import { type ModelTier, TransactionConflictError } from '@contentworker/ports';
import { guidanceForModel } from './ai-prompt';
import { auditActor } from './audit';
import { assertContentTypeCaller, type ContentTypeCaller, SYSTEM_CALLER } from './content-types';
import type { AppContext } from './context';

/**
 * A space's AI settings (see `@contentworker/domain`'s ai-settings module): per capability, on or
 * off, its model tier and its guidance. Reading them takes `preview:read` (the admin hides what is
 * off from every editor); setting them takes `space:admin`, checked by the surfaces.
 *
 * Every AI use-case asks {@link aiCapability} (or {@link requireAiCapability}) for its capability
 * before it calls a model, so the admin, REST, MCP, Coworker and workflow nodes meet the same
 * refusal, tier and guidance. One read by primary key per call; nothing is written on that path.
 */

/** The space's settings: version 0 and everything on before the first set. A read. */
export async function getAiSettings(ctx: AppContext, spaceId: string): Promise<AiSettings> {
  return (await ctx.store.aiSettings.get(spaceId)) ?? DEFAULT_AI_SETTINGS;
}

/**
 * The space's settings as REST, MCP and the admin report them: with the deployment's tier cap and
 * the tier each capability actually runs on under it. A read.
 */
export async function readAiSettings(ctx: AppContext, spaceId: string): Promise<AiSettingsView> {
  return aiSettingsView(await getAiSettings(ctx, spaceId), ctx.ai?.maxTier);
}

/** What `setAiSettings` takes. `capabilities` is checked here, whatever sent it. */
export interface SetAiSettingsInput {
  /** The version the settings were read at (0 before the first set): another is a conflict. */
  readonly expectedVersion: number;
  /** By capability id; each one named is replaced whole, the rest are left as they are. */
  readonly capabilities: unknown;
}

export interface AiSettingsSet {
  /** As {@link readAiSettings} reports them. */
  readonly settings: AiSettingsView;
  /** The settings were already this: nothing written, the version unchanged. */
  readonly unchanged: boolean;
}

/**
 * Sets the capabilities `input` names, as a new version. Setting what is in force again writes
 * nothing, whatever `expectedVersion` says, so a retried set whose first try landed is a no-op.
 *
 * 409 (naming the version in force) when `expectedVersion` isn't the version in force, or when
 * another set commits first; 422 naming each part that isn't a capability, a tier, or guidance
 * within its length. A tier above the deployment's cap is kept as set and reported with the tier it
 * runs on (`effectiveTier`), never refused: a cap lowered after a space chose its tiers would
 * otherwise refuse every later save of the settings until each tier was lowered by hand, and the
 * stored choice comes back when the cap is raised. Turning `search` on or off starts a reindex in
 * each of the space's environments (`search.toggled`, committed with the set). A delegated bearer (PAT, OAuth token) holding `space:admin` may set them: they
 * are configuration, and grant nobody access that outlives the token.
 */
export async function setAiSettings(
  ctx: AppContext,
  caller: ContentTypeCaller,
  spaceId: string,
  input: SetAiSettingsInput,
): Promise<AiSettingsSet> {
  assertContentTypeCaller(caller);
  const current = await getAiSettings(ctx, spaceId);
  const capabilities = applyAiSettingsInput(current.capabilities, input.capabilities);
  const view = (s: AiSettings) => aiSettingsView(s, ctx.ai?.maxTier);
  if (canonicalJson(capabilities) === canonicalJson(current.capabilities)) {
    return { settings: view(current), unchanged: true };
  }
  const stale = () =>
    new ConflictError(
      `The AI settings are at version ${current.version}, not ${input.expectedVersion}: ` +
        'someone changed them since. Load them again and set yours over theirs.',
      { version: current.version, currentVersion: current.version },
    );
  if (input.expectedVersion !== current.version) throw stale();
  const settings: AiSettings = {
    version: current.version + 1,
    capabilities,
    updatedAt: ctx.clock.now().toISOString(),
    updatedBy: caller === SYSTEM_CALLER ? null : auditActor(caller),
  };
  // Search turned on or off: each environment's index is brought in line by a background job
  // (`search-reindex.ts`), started from an event that commits with the setting or not at all.
  const searchToggled = current.capabilities.search.enabled !== capabilities.search.enabled;
  const environments = searchToggled ? await ctx.store.spaces.listEnvironments(spaceId) : [];
  try {
    if (environments.length > 0) {
      const occurredAt = ctx.clock.now().toISOString();
      await ctx.store.withTransaction(async (tx) => {
        await tx.outbox.appendMany(
          environments.map((env) => ({
            id: ctx.ids.newId(),
            type: 'search.toggled' as const,
            scope: { spaceId, environmentId: env.id },
            occurredAt,
            enabled: capabilities.search.enabled,
            settingsVersion: settings.version,
            ...(settings.updatedBy ? { actor: settings.updatedBy } : {}),
          })),
        );
        await tx.aiSettings.save(spaceId, settings);
      });
    } else {
      await ctx.store.aiSettings.save(spaceId, settings);
    }
  } catch (err) {
    if (!(err instanceof TransactionConflictError)) throw err;
    throw new ConflictError('The AI settings changed while they were being set; try again', {
      version: current.version,
      currentVersion: current.version,
    });
  }
  // Committed: the audit row names what changed, never the guidance itself.
  ctx.changes?.noteAiSettings(diffAiSettings(current, settings));
  return { settings: view(settings), unchanged: false };
}

/** How one AI call site runs under its capability's settings. */
export interface AiCapabilityPolicy {
  readonly capability: AiCapability;
  readonly enabled: boolean;
  /**
   * The tier to call with: what the request asked for, else the space's tier for the capability,
   * else the call site's own default; whichever it is, held to the deployment's cap (AI_MAX_TIER).
   * The tier then goes through the AI adapter's tier → model mapping (and AI Gateway) like any
   * other call; the cost guard meters it the same.
   */
  tier(callSiteDefault: ModelTier, requested?: ModelTier): ModelTier;
  /** The built-in system prompt with the capability's guidance fenced after it, when there is any. */
  system(base: string): string;
}

function policyOf(
  capability: AiCapability,
  s: AiCapabilitySetting,
  maxTier: ModelTier | undefined,
): AiCapabilityPolicy {
  const { label, guided } = AI_CAPABILITY_INFO[capability];
  const fence =
    guided && s.guidance ? guidanceForModel(label, s.guidance, AI_GUIDANCE_MAX_CHARS) : null;
  return {
    capability,
    enabled: s.enabled,
    tier: (fallback, requested) => capModelTier(requested ?? s.tier ?? fallback, maxTier),
    system: (base) => (fence ? `${base}\n\n${fence}` : base),
  };
}

/**
 * The policy of a capability with nothing configured: on, the call site's tier (held to `maxTier`,
 * the deployment's cap), no guidance.
 */
export const defaultAiPolicy = (
  capability: AiCapability,
  maxTier?: ModelTier,
): AiCapabilityPolicy =>
  policyOf(capability, DEFAULT_AI_SETTINGS.capabilities[capability], maxTier);

/**
 * The space's settings for `capability`, as a policy. Background work (an ingest step, a queue
 * consumer, a workflow node) checks `enabled` and skips; a request uses {@link requireAiCapability}.
 */
export async function aiCapability(
  ctx: AppContext,
  scope: Pick<Scope, 'spaceId'>,
  capability: AiCapability,
): Promise<AiCapabilityPolicy> {
  const settings = await getAiSettings(ctx, scope.spaceId);
  return policyOf(capability, settings.capabilities[capability], ctx.ai?.maxTier);
}

/** {@link aiCapability}, refusing (409 `ai_capability_disabled`) when it is turned off. */
export async function requireAiCapability(
  ctx: AppContext,
  scope: Pick<Scope, 'spaceId'>,
  capability: AiCapability,
): Promise<AiCapabilityPolicy> {
  const policy = await aiCapability(ctx, scope, capability);
  if (!policy.enabled) throw new AiCapabilityDisabledError(capability);
  return policy;
}
