import { RateLimitedError, type Scope } from '@contentworker/domain';
import type { AIProvider, GenerateRequest, GenerateResult } from '@contentworker/ports';
import type { AppContext } from './context.js';

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
): Promise<GenerateResult> {
  if (ctx.costGuard) {
    const decision = await ctx.costGuard.consume(scope);
    if (!decision.allowed) {
      throw new RateLimitedError(
        `AI ${decision.reason === 'tokens' ? 'token' : 'request'} budget exceeded for this space; retry later`,
        decision.retryAfterSeconds,
      );
    }
  }
  const result = await ai.generate(req);
  if (ctx.costGuard) {
    const total = result.usage.inputTokens + result.usage.outputTokens;
    await ctx.costGuard.settle(scope, total);
  }
  return result;
}
