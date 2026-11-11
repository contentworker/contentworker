import {
  capModelTier,
  isAiModelTier,
  MODEL_TIERS,
  RateLimitedError,
  type Scope,
} from '@contentworker/domain';
import type { AIProvider, GenerateRequest, ModelTier } from '@contentworker/ports';
import type { FakeAdapterBinding } from './adapter-guard';
import { generateWithBudget, withTimeout } from './ai-budget';
import type { AiCallRecord, AiProvenance } from './ai-provenance';
import type { AiCapabilityPolicy } from './ai-settings';
import type { AiMode, AppContext } from './context';

/** Default per-call cap: a slow model must not hold a step (or a person) hostage. */
export const DEFAULT_AI_TIMEOUT_MS = 20_000;

/**
 * Parses AI_MODE / AI_TIMEOUT_MS / AI_MAX_TIER, shared by every composition root so the
 * defaults never drift. Anything but `mock` is live; a missing or non-positive
 * timeout falls back to {@link DEFAULT_AI_TIMEOUT_MS}. An empty or missing AI_MAX_TIER is no cap
 * (as `flagship` is); anything but a tier is refused at boot, since a cap mistyped into no cap
 * would lift the deployment's price ceiling per call.
 */
export function aiRuntimeConfig(env: Record<string, string | undefined> = {}): {
  mode: AiMode;
  timeoutMs: number;
  maxTier?: ModelTier;
} {
  const timeout = Number(env.AI_TIMEOUT_MS);
  const max = env.AI_MAX_TIER?.trim();
  if (max && !isAiModelTier(max)) {
    throw new Error(
      `AI_MAX_TIER must be one of ${MODEL_TIERS.join(', ')}, or empty (got "${max}")`,
    );
  }
  return {
    mode: env.AI_MODE === 'mock' ? 'mock' : 'live',
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_AI_TIMEOUT_MS,
    ...(max && max !== 'flagship' ? { maxTier: max as ModelTier } : {}),
  };
}

/**
 * AI_MODE=mock as a fake-adapter binding: every structured AI answer comes
 * from a heuristic, which a persistent deployment must accept deliberately
 * (ALLOW_FAKE_ADAPTERS=ai), exactly like the stub AIProvider.
 */
export function aiModeFakes(config: { mode: AiMode }): FakeAdapterBinding[] {
  return config.mode === 'mock'
    ? [
        {
          key: 'ai',
          detail: 'AI_MODE=mock (heuristic answers, the model is never called) — set AI_MODE=live',
        },
      ]
    : [];
}

// ---- conforms --------------------------------------------------------------

type Schema = Record<string, unknown>;

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

/** The schema a local `$ref` (`#/$defs/<name>`) names in `root`, else undefined. */
function resolveRef(root: Schema, ref: string): Schema | undefined {
  if (!ref.startsWith('#/$defs/')) return undefined;
  const defs = root.$defs;
  const def =
    defs && typeof defs === 'object'
      ? (defs as Record<string, unknown>)[ref.slice('#/$defs/'.length)]
      : undefined;
  return def && typeof def === 'object' ? (def as Schema) : undefined;
}

/**
 * Structural JSON Schema check covering what generation schemas use: `type`
 * (single or union), `const`, `enum`, `anyOf` (some branch), `oneOf` (exactly
 * one branch), `required`, `properties`, `items`, `additionalProperties:
 * false` and a local `$ref` to `root`'s `$defs` (a blocks schema shares a block
 * shape that occurs more than once that way), recursively. A reference that
 * names nothing conforms to nothing. Unknown keywords are accepted — this guards
 * the shape a step relies on, not every rule (lengths, counts and patterns are
 * the validators' to judge, and they name the field).
 */
export function conforms(value: unknown, schema: Schema, root: Schema = schema): boolean {
  if (typeof schema.$ref === 'string') {
    const def = resolveRef(root, schema.$ref);
    return def !== undefined && def !== schema && conforms(value, def, root);
  }
  const branches = (key: 'anyOf' | 'oneOf') =>
    Array.isArray(schema[key])
      ? (schema[key] as unknown[]).filter((b): b is Schema => !!b && typeof b === 'object')
      : undefined;
  const anyOf = branches('anyOf');
  if (anyOf && !anyOf.some((b) => conforms(value, b, root))) return false;
  const oneOf = branches('oneOf');
  if (oneOf && oneOf.filter((b) => conforms(value, b, root)).length !== 1) return false;
  if ('const' in schema && schema.const !== value) return false;
  const type = schema.type;
  if (typeof type === 'string' && !typeMatches(value, type)) return false;
  if (Array.isArray(type) && !type.some((t) => typeof t === 'string' && typeMatches(value, t))) {
    return false;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === value)) return false;

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !(key in obj)) return false;
      }
    }
    const props =
      schema.properties && typeof schema.properties === 'object'
        ? (schema.properties as Record<string, unknown>)
        : undefined;
    if (props) {
      for (const [key, sub] of Object.entries(props)) {
        if (
          key in obj &&
          sub &&
          typeof sub === 'object' &&
          !conforms(obj[key], sub as Schema, root)
        ) {
          return false;
        }
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) if (!props || !(key in props)) return false;
    }
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === 'object') {
    const items = schema.items as Schema;
    if (!value.every((v) => conforms(v, items, root))) return false;
  }
  return true;
}

/**
 * A model's structured answer when it has the schema's shape, else `undefined`. JSON mode asks the
 * model for the shape; it does not promise it, so a use-case reads the answer through this rather
 * than casting it: a malformed answer is no answer (the caller's empty result or refusal), never a
 * `TypeError` on the first field it touches. Keys the answer adds beside the schema's are let be:
 * the caller reads only the ones it names.
 */
export function conformingAnswer<T>(
  result: { readonly object?: unknown },
  schema: Schema,
): T | undefined {
  const value = result.object;
  if (value === undefined || value === null) return undefined;
  const { additionalProperties: _extra, ...named } = schema;
  return conforms(value, named) ? (value as T) : undefined;
}

/**
 * The strings in one list field of a model's structured answer (`field` of `result.object`): what
 * isn't a list is no list, and what in it isn't a string is left out. Read per field, so a model
 * that got one list right and fumbled the other still counts for the one.
 */
export function answerStrings(result: { readonly object?: unknown }, field: string): string[] {
  const value =
    typeof result.object === 'object' && result.object !== null && !Array.isArray(result.object)
      ? (result.object as Record<string, unknown>)[field]
      : undefined;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

// ---- generateJson -----------------------------------------------------------

export interface GenerateJsonOptions<T> {
  /** Stable prompt id for provenance and logs (e.g. `workflow.router`). */
  readonly prompt: string;
  /** The deterministic answer when the model can't give one. Must satisfy the schema. */
  readonly fallback: () => T;
  /**
   * Set while a durable step has attempts left: a failed call (provider error
   * or timeout) then throws so the step retries with its backoff, instead of
   * recording the heuristic's answer for good. The last attempt, and every
   * caller outside a step, falls back at once. Bad answers and budget
   * refusals always fall back — retrying wouldn't change them.
   */
  readonly retry?: boolean;
  /** Overrides `ctx.ai.timeoutMs` (the copilot runs 120 s calls). */
  readonly timeoutMs?: number;
  /**
   * The space's settings for the capability this call is (`aiCapability`): turned off, the
   * heuristic answers (recorded as a `disabled` fallback) without calling the model; otherwise its
   * tier stands in for the call site's default. Guidance is the caller's to add to `system`.
   */
  readonly policy?: AiCapabilityPolicy;
}

export type GenerateJsonResult<T> = AiProvenance & {
  readonly value: T;
  readonly usage?: { inputTokens: number; outputTokens: number };
};

/**
 * One structured model call with firm guarantees, so AI never blocks a
 * run: JSON mode against a schema, a per-call cap, the answer checked against
 * the schema, and a deterministic fallback whose use is recorded in the
 * result's provenance (never silent). Runs under the space's AI budget
 * (`generateWithBudget`); a refusal is a fallback too.
 */
export async function generateJson<T>(
  ctx: AppContext,
  ai: AIProvider,
  scope: Scope,
  req: GenerateRequest & { outputSchema: Record<string, unknown> },
  opts: GenerateJsonOptions<T>,
): Promise<GenerateJsonResult<T>> {
  // Held to the deployment's cap either way, so the provenance names the tier that answered.
  const tier: ModelTier = opts.policy
    ? opts.policy.tier(req.tier ?? 'balanced')
    : capModelTier(req.tier ?? 'balanced', ctx.ai?.maxTier);
  const started = ctx.clock.now().getTime();
  const elapsed = () => ctx.clock.now().getTime() - started;
  const log = (record: Omit<AiCallRecord, 'type' | 'ms'>) =>
    ctx.ai?.log?.({ type: 'ai_call', ms: elapsed(), ...record });

  const heuristic = (
    reason: string,
    usage?: GenerateJsonResult<T>['usage'],
  ): GenerateJsonResult<T> => {
    const p: AiProvenance = {
      source: 'heuristic',
      tier: null,
      prompt: opts.prompt,
      fallback: reason,
    };
    log({ ...p, ...(usage ? { tokens: usage.inputTokens + usage.outputTokens } : {}) });
    return { ...p, value: opts.fallback(), ...(usage ? { usage } : {}) };
  };

  if (ctx.ai?.mode === 'mock') return heuristic('mock');
  if (opts.policy && !opts.policy.enabled) {
    return heuristic(`disabled: the space turned ${opts.policy.capability} AI off`);
  }

  let result: Awaited<ReturnType<AIProvider['generate']>>;
  try {
    result = await withTimeout(
      generateWithBudget(ctx, ai, scope, { ...req, tier }),
      opts.timeoutMs ?? ctx.ai?.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (err instanceof RateLimitedError) return heuristic(`budget: ${reason}`);
    if (opts.retry) {
      log({ source: 'heuristic', tier, prompt: opts.prompt, retrying: reason });
      throw new Error(`The model call failed (${reason}); trying again`);
    }
    return heuristic(reason);
  }

  // A bad answer isn't retried: the same prompt tends to get the same answer,
  // at another call's cost. What the model used counts either way.
  const value = result.object;
  if (value === undefined || value === null) return heuristic('empty response', result.usage);
  if (!conforms(value, req.outputSchema)) {
    return heuristic('response does not match the schema', result.usage);
  }
  const p: AiProvenance = { source: 'model', tier, prompt: opts.prompt };
  log({ ...p, tokens: result.usage.inputTokens + result.usage.outputTokens });
  return { ...p, value: value as T, usage: result.usage };
}
