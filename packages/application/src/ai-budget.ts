import {
  AiUnavailableError,
  capModelTier,
  RateLimitedError,
  type Scope,
} from '@contentworker/domain';
import type {
  AIProvider,
  BilledGenerateFailure,
  DecisionModel,
  DecisionRequest,
  DecisionResult,
  GenerateRequest,
  GenerateResult,
} from '@contentworker/ports';
import { mockDecide, mockGenerate } from './ai-mock';
import type { AppContext } from './context';

export interface AiBudgetLimits {
  readonly maxRequests: number;
  readonly maxTokens: number;
  readonly windowSeconds: number;
}

/**
 * Parses the per-space AI budget from environment variables, shared by every
 * composition root so the defaults never drift. Returns `undefined` (metering
 * off) when either ceiling is set to 0.
 */
export function aiBudgetLimits(
  env: Record<string, string | undefined> = {},
): AiBudgetLimits | undefined {
  const limits = {
    maxRequests: Number(env.AI_MAX_REQUESTS_PER_WINDOW ?? 60),
    maxTokens: Number(env.AI_MAX_TOKENS_PER_WINDOW ?? 200_000),
    windowSeconds: Number(env.AI_BUDGET_WINDOW_SECONDS ?? 60),
  };
  if (limits.maxRequests <= 0 || limits.maxTokens <= 0) return undefined;
  return limits;
}

/**
 * A separate, typically stricter window for BACKGROUND agent spend (scheduled
 * runs, on-publish agents), so batch work can never exhaust the interactive
 * budget. Returns `undefined` when the AI_AGENT_* vars are unset — background
 * runs then share the standard window.
 */
export function agentBudgetLimits(
  env: Record<string, string | undefined> = {},
): AiBudgetLimits | undefined {
  if (
    env.AI_AGENT_MAX_REQUESTS_PER_WINDOW === undefined &&
    env.AI_AGENT_MAX_TOKENS_PER_WINDOW === undefined
  ) {
    return undefined;
  }
  const limits = {
    maxRequests: Number(env.AI_AGENT_MAX_REQUESTS_PER_WINDOW ?? 60),
    maxTokens: Number(env.AI_AGENT_MAX_TOKENS_PER_WINDOW ?? 200_000),
    windowSeconds: Number(env.AI_AGENT_BUDGET_WINDOW_SECONDS ?? env.AI_BUDGET_WINDOW_SECONDS ?? 60),
  };
  if (limits.maxRequests <= 0 || limits.maxTokens <= 0) return undefined;
  return limits;
}

/** A call that ran past its cap. */
export class AiTimeoutError extends Error {}

/** `p`, or a rejection once `ms` have passed: the per-call cap every model call is held to. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AiTimeoutError(`AI call timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export interface BudgetOptions {
  /**
   * The call's cap. Past it, the call is abandoned and the space is charged `maxTokens` (the
   * provider may still bill it, and an abandoned call settles nothing), then
   * {@link AiUnavailableError} is thrown: HTTP 503, retryable.
   */
  readonly timeoutMs?: number;
}

/**
 * Runs an AI generation under the space's budget: consults `ctx.costGuard`
 * first (throwing {@link RateLimitedError} → HTTP 429 when the scope is over its
 * per-window request or token ceiling), performs the generation, then records
 * the observed token usage. When no cost guard is wired (dev/tests), it is a
 * transparent pass-through. This is the single choke point every AI use-case
 * calls, so both the HTTP API and the MCP/agent surfaces are metered uniformly.
 */
export async function generateWithBudget(
  ctx: AppContext,
  ai: AIProvider,
  scope: Scope,
  req: GenerateRequest,
  options: BudgetOptions = {},
): Promise<GenerateResult> {
  // AI_MODE=mock: never call the model (local development, demos), from any use-case.
  if (ctx.ai?.mode === 'mock') return mockGenerate(req);
  // The deployment's tier cap, here too: the one choke point, so a call site that named its tier
  // outright (a workflow node, the copilot) is held to it like one that asked its capability.
  const max = ctx.ai?.maxTier;
  if (max) req = { ...req, tier: capModelTier(req.tier ?? 'balanced', max) };
  if (ctx.costGuard) {
    const decision = await ctx.costGuard.consume(scope);
    if (!decision.allowed) {
      throw new RateLimitedError(
        `AI ${decision.reason === 'tokens' ? 'token' : 'request'} budget exceeded for this space; retry later`,
        decision.retryAfterSeconds,
      );
    }
  }
  const call = ai.generate(req);
  let result: GenerateResult;
  try {
    result =
      options.timeoutMs === undefined ? await call : await withTimeout(call, options.timeoutMs);
  } catch (err) {
    if (options.timeoutMs !== undefined && err instanceof AiTimeoutError) {
      // The abandoned call may still fail later: nobody is listening for it.
      call.catch(() => {});
      if (ctx.costGuard) await ctx.costGuard.settle(scope, req.maxTokens);
      throw new AiUnavailableError(
        `The model didn’t answer within ${Math.round(options.timeoutMs / 1000)} s; try again`,
      );
    }
    // A call that failed after the model ran (cut off at maxTokens) was billed: count it.
    const spent = billedUsage(err);
    if (ctx.costGuard && spent) {
      await ctx.costGuard.settle(scope, spent.inputTokens + spent.outputTokens);
    }
    throw err;
  }
  if (ctx.costGuard) {
    const total = result.usage.inputTokens + result.usage.outputTokens;
    await ctx.costGuard.settle(scope, total);
  }
  return result;
}

/** The tokens a failed generation still cost, when the provider says (a BilledGenerateFailure). */
function billedUsage(err: unknown): BilledGenerateFailure['usage'] | undefined {
  const usage = (err as Partial<BilledGenerateFailure> | null)?.usage;
  if (
    typeof usage?.inputTokens === 'number' &&
    typeof usage.outputTokens === 'number' &&
    Number.isFinite(usage.inputTokens + usage.outputTokens)
  ) {
    return usage;
  }
  return undefined;
}

/**
 * Runs any other metered model call (text extraction: Markdown conversion, transcription) under
 * the space's budget, as {@link generateWithBudget} does: the cost guard is consulted first
 * ({@link RateLimitedError} when over), and `tokens(result)` is recorded after. Callers handle
 * AI_MODE=mock themselves (by having no model to call).
 */
export async function runWithBudget<T>(
  ctx: AppContext,
  scope: Scope,
  call: () => Promise<T>,
  tokens: (result: T) => number,
): Promise<T> {
  if (ctx.costGuard) {
    const decision = await ctx.costGuard.consume(scope);
    if (!decision.allowed) {
      throw new RateLimitedError(
        `AI ${decision.reason === 'tokens' ? 'token' : 'request'} budget exceeded for this space; retry later`,
        decision.retryAfterSeconds,
      );
    }
  }
  const result = await call();
  if (ctx.costGuard) await ctx.costGuard.settle(scope, tokens(result));
  return result;
}

/**
 * Asks a decision model under the space's budget, exactly as {@link generateWithBudget} does for
 * generation: AI_MODE=mock answers without the model, the cost guard is consulted first
 * ({@link RateLimitedError} when over), and the observed tokens are recorded after (decision
 * models bill input only).
 */
export async function decideWithBudget(
  ctx: AppContext,
  model: DecisionModel,
  scope: Scope,
  req: DecisionRequest,
): Promise<DecisionResult> {
  if (ctx.ai?.mode === 'mock') return mockDecide(req);
  // Held to the deployment's tier cap, as generation is (decision models default to fast).
  const max = ctx.ai?.maxTier;
  if (max) req = { ...req, tier: capModelTier(req.tier ?? 'fast', max) };
  if (ctx.costGuard) {
    const decision = await ctx.costGuard.consume(scope);
    if (!decision.allowed) {
      throw new RateLimitedError(
        `AI ${decision.reason === 'tokens' ? 'token' : 'request'} budget exceeded for this space; retry later`,
        decision.retryAfterSeconds,
      );
    }
  }
  const result = await model.decide(req);
  if (ctx.costGuard) await ctx.costGuard.settle(scope, result.usage.inputTokens);
  return result;
}
