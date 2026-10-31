import { RateLimitedError, type Scope } from '@contentworker/domain';
import type { AIProvider, GenerateRequest, ModelTier } from '@contentworker/ports';
import type { FakeAdapterBinding } from './adapter-guard.js';
import { generateWithBudget } from './ai-budget.js';
import type { AiCallRecord, AiProvenance } from './ai-provenance.js';
import type { AiMode, AppContext } from './context.js';

/** Default per-call cap: a slow model must not hold a step (or a person) hostage. */
export const DEFAULT_AI_TIMEOUT_MS = 20_000;

/**
 * Parses AI_MODE / AI_TIMEOUT_MS, shared by every composition root so the
 * defaults never drift. Anything but `mock` is live; a missing or non-positive
 * timeout falls back to {@link DEFAULT_AI_TIMEOUT_MS}.
 */
export function aiRuntimeConfig(env: Record<string, string | undefined> = {}): {
  mode: AiMode;
  timeoutMs: number;
} {
  const timeout = Number(env.AI_TIMEOUT_MS);
  return {
    mode: env.AI_MODE === 'mock' ? 'mock' : 'live',
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_AI_TIMEOUT_MS,
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

/**
 * Structural JSON Schema check covering what generation schemas use: `type`
 * (single or union), `enum`, `required`, `properties`, `items` and
 * `additionalProperties: false`, recursively. Unknown keywords are accepted —
 * this guards the shape a step relies on, not every rule.
 */
export function conforms(value: unknown, schema: Schema): boolean {
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
        if (key in obj && sub && typeof sub === 'object' && !conforms(obj[key], sub as Schema)) {
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
    if (!value.every((v) => conforms(v, items))) return false;
  }
  return true;
}

// ---- generateJson -----------------------------------------------------------

class AiTimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AiTimeoutError(`AI call timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

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
  const tier: ModelTier = req.tier ?? 'balanced';
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

  let result: Awaited<ReturnType<AIProvider['generate']>>;
  try {
    result = await withTimeout(
      generateWithBudget(ctx, ai, scope, req),
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
