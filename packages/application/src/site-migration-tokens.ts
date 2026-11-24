import {
  AiUnavailableError,
  type MigrationTokenRefusal,
  RateLimitedError,
} from '@contentworker/domain';
import type {
  AIProvider,
  ChatMessage,
  GenerateRequest,
  GenerateResult,
} from '@contentworker/ports';
import { billedUsage, generateWithBudget } from './ai-budget';
import type { AppContext } from './context';
import type { TemplateAgentState } from './site-migration-agent';

/**
 * A template agent's model call under its run's token cap: reserved before it, settled after.
 *
 * The run's count is a line per agent in the store ({@link MigrationTokenStore}), each holding its
 * agent's own total, which the agent keeps in its state. So nothing is counted twice: a repeated
 * write says the same total, and a settlement that was lost is made good by the next reservation.
 *
 * - The space's AI budget is asked first: the reservation is made as the call goes to the model,
 *   inside `generateWithBudget`.
 * - A reservation is the most the call can take: its prompt by size, and its whole answer
 *   allowance. What is spent and reserved stays within the cap, so a call overshoots it only by what
 *   the provider reports beyond the call's reservation, which leaves at most one call per agent.
 * - The state is recorded as the call begins (`record`). An agent that comes back to a call begun
 *   and never finished (evicted, redeployed) counts its whole reservation: it may well have been
 *   billed, and nothing will say.
 * - A settlement that fails is tried again, after the agent has ended too (the host's part).
 * - A reservation never settled (its agent is gone) counts as spent after
 *   {@link RESERVATION_MS}, so nobody waits on it.
 */

/** When an open reservation is taken as spent: far longer than a call may take. */
const RESERVATION_MS = 10 * 60_000;
/** How long an agent waits for others' reservations to settle. */
const HELD_RETRY_SECONDS = 30;
/** The longest an agent waits while its line may hold what it doesn't: well before that lapses. */
const UNSETTLED_RETRY_SECONDS = 5 * 60;
/** How long an agent waits after a call that timed out, doubled for each in a row. */
const TIMEOUT_RETRY_SECONDS = 60;
const TIMEOUT_RETRY_MAX_SECONDS = 30 * 60;
/**
 * Tokens a chat template adds around the prompt and around each message and tool, at most. A token
 * is at least a byte of text, so beyond these a prompt can't have more tokens than bytes.
 */
const PROMPT_OVERHEAD_TOKENS = 2_000;
const MESSAGE_OVERHEAD_TOKENS = 32;

/** Keeps the agent's state as a call begins and as it ends, before anything else follows. */
export type RecordAgentState = (state: TemplateAgentState) => Promise<void>;

export type TemplateAgentCall =
  | { readonly state: TemplateAgentState; readonly answer: GenerateResult }
  /** Not now: `state.retryAfterSeconds` says when. */
  | { readonly state: TemplateAgentState; readonly held: true }
  | { readonly state: TemplateAgentState; readonly stopped: string };

/** What the agent has used toward its run's cap, and its own. */
export const spentOf = (state: TemplateAgentState) => state.tokens + (state.abandoned ?? 0);

/** The state with nothing pending: no call under way, no wait. */
const withoutCall = ({
  call: _call,
  retryAfterSeconds: _wait,
  waiting: _waiting,
  ...state
}: TemplateAgentState): TemplateAgentState => state;

/** A call begun in this turn that never finished is counted at its reservation, once. */
export function countLostCall(state: TemplateAgentState): TemplateAgentState {
  if (!state.call) return state;
  const rest = withoutCall(state);
  // A turn ended since (by code that doesn't keep calls): that call finished.
  if (state.call.turn !== state.turns) return rest;
  return { ...rest, abandoned: (state.abandoned ?? 0) + state.call.tokens };
}

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const promptBound = (texts: readonly string[]) =>
  texts.reduce((n, text) => n + bytes(text) + MESSAGE_OVERHEAD_TOKENS, 0);
/** A message as the model reads it: its text, and the calls it asked for. */
const messageText = (m: ChatMessage) =>
  'toolCalls' in m && m.toolCalls ? m.content + JSON.stringify(m.toolCalls) : m.content;

/**
 * The most the call can take. A conversation only grows, so past the first call that is what the
 * last prompt measured and what was added since (compacting only shrinks it); on another tier, whose
 * model may count differently, or where that is less, the prompt as it is.
 */
export function callReservation(state: TemplateAgentState, req: GenerateRequest): number {
  const whole =
    PROMPT_OVERHEAD_TOKENS +
    promptBound([
      req.system ?? '',
      req.prompt,
      ...(req.messages ?? []).map(messageText),
      ...(req.tools ?? []).map((tool) => JSON.stringify(tool)),
    ]);
  const last = state.prompt;
  const grown =
    last && last.tier === state.tier
      ? last.tokens + promptBound(state.messages.slice(last.messages).map(messageText))
      : whole;
  return Math.min(whole, grown) + req.maxTokens;
}

/** The store's answer to a reservation, when it isn't a grant. */
class ReservationRefused extends Error {
  constructor(readonly why: 'gone' | MigrationTokenRefusal) {
    super(`The run's tokens are not to be had: ${why}`);
  }
}

/** What became of the model call itself, whatever happened around it. */
type Outcome = { readonly usage: GenerateResult['usage'] } | { readonly error: unknown };

/**
 * What a call counts. One with no outcome yet (abandoned at its timeout), an answer with no usage, or
 * a provider's own timeout may have been billed and will never say: it counts its whole reservation.
 * A provider's other errors, unless they say what they billed, count nothing.
 */
function usedBy(
  outcome: Outcome | undefined,
  reserved: number,
): { tokens: number; abandoned: number; timedOut: boolean } {
  const unknown = (timedOut: boolean) => ({ tokens: 0, abandoned: reserved, timedOut });
  if (!outcome) return unknown(true);
  const usage = 'usage' in outcome ? outcome.usage : billedUsage(outcome.error);
  if (usage) {
    const tokens = usage.inputTokens + usage.outputTokens;
    return tokens > 0 ? { tokens, abandoned: 0, timedOut: false } : unknown(false);
  }
  const { error } = outcome as { error: unknown };
  return (error as { reason?: unknown } | null)?.reason === 'timeout'
    ? unknown(true)
    : { tokens: 0, abandoned: 0, timedOut: false };
}

export async function callWithinRunCap(
  ctx: AppContext,
  ai: AIProvider,
  from: TemplateAgentState,
  req: GenerateRequest,
  options: { readonly timeoutMs: number; readonly record: RecordAgentState },
): Promise<TemplateAgentCall> {
  let state = countLostCall(from);
  const { scope, runId, templateId } = state;
  const tokens = callReservation(state, req);
  const seq = (state.calls ?? 0) + 1;
  // Told again before anything else, so no one waits on, or is stopped by, what isn't held.
  if (state.unsettled) state = await releaseAgentTokens(ctx, state);
  // One already waiting looks before it asks the space's budget for a call it can't make yet; the
  // reservation is still what decides.
  if (state.waiting && (await mustWait(ctx, state, seq, tokens))) {
    return hold(ctx, state, HELD_RETRY_SECONDS);
  }
  let begun = false;
  // A reservation was asked for and may be held, with no call begun under it.
  let mayHold = false;
  let outcome: Outcome | undefined;
  // Past the call's timeout nobody is listening: a reservation that answers late begins no call.
  let over = false;
  const reserving: AIProvider = {
    async generate(request) {
      const now = ctx.clock.now();
      mayHold = true;
      const reservation = await ctx.store.migrations.reserveAgentTokens(scope, runId, {
        templateId,
        seq,
        spent: spentOf(state),
        tokens,
        at: now.toISOString(),
        until: new Date(now.getTime() + RESERVATION_MS).toISOString(),
      });
      if (reservation !== 'granted') {
        mayHold = false;
        throw new ReservationRefused(reservation);
      }
      if (over) throw new ReservationRefused('wait');
      const beginning = { ...withoutCall(state), calls: seq, call: { turn: state.turns, tokens } };
      await options.record(beginning);
      if (over) throw new ReservationRefused('wait');
      state = beginning;
      begun = true;
      mayHold = false;
      try {
        const result = await ai.generate(request);
        outcome = { usage: result.usage };
        return result;
      } catch (error) {
        outcome = { error };
        throw error;
      }
    },
  };
  /** Ends the call: its use joins the agent's total, kept first and then told to the run. */
  const end = async () => {
    // Counted from here, whatever fails next.
    begun = false;
    const used = usedBy(outcome, tokens);
    const { timeouts = 0, ...ended } = withoutCall(state);
    state = {
      ...ended,
      tokens: ended.tokens + used.tokens,
      ...(used.abandoned ? { abandoned: (ended.abandoned ?? 0) + used.abandoned } : {}),
      ...(used.timedOut ? { timeouts: timeouts + 1 } : {}),
      ...(outcome && 'usage' in outcome && outcome.usage.inputTokens > 0
        ? {
            prompt: {
              tokens: outcome.usage.inputTokens,
              messages: ended.messages.length,
              tier: ended.tier,
            },
          }
        : {}),
    };
    await options.record(state);
    state = await settle(ctx, state, seq);
    if (state.unsettled) await options.record(state);
  };

  try {
    const answer = await generateWithBudget(ctx, reserving, scope, req, {
      timeoutMs: options.timeoutMs,
    });
    if (begun) await end();
    return { state, answer };
  } catch (err) {
    over = true;
    if (err instanceof ReservationRefused) {
      if (err.why === 'wait') {
        return hold(ctx, { ...state, waiting: true }, HELD_RETRY_SECONDS);
      }
      if (err.why === 'gone') return { state, stopped: 'Stopped: the run is gone' };
      if (err.why === 'stale') {
        return { state, stopped: 'Stopped: the run counts a later agent of this template' };
      }
      const at = ctx.clock.now().toISOString();
      // Thrown on, unless it is on record: the run's count is what says the cap stopped the agent.
      try {
        await ctx.store.migrations.capAgentTokens(scope, runId, {
          templateId,
          seq,
          spent: spentOf(state),
          at,
        });
      } catch (failed) {
        state = { ...withoutCall(state), unsettled: true };
        await options.record(state);
        throw failed;
      }
      const now = await ctx.store.migrations.agentTokens(scope, runId, at);
      return {
        state,
        stopped:
          `Stopped: the run's token cap${now ? ` (${now.cap})` : ''} leaves no room for another ` +
          'call. The template can still be authored by a person or an MCP client',
      };
    }
    if (begun) await end();
    else if (mayHold) {
      // Told again before the next call, and never slept on: an earlier wait goes with it.
      state = { ...withoutCall(state), unsettled: true };
      await options.record(state);
    }
    if (err instanceof AiUnavailableError) {
      // An outage is waited out, not spent on: each call that times out counts in full.
      const wait = TIMEOUT_RETRY_SECONDS * 2 ** Math.max(0, (state.timeouts ?? 0) - 1);
      return hold(ctx, state, Math.min(wait, TIMEOUT_RETRY_MAX_SECONDS), mayHold);
    }
    if (err instanceof RateLimitedError) {
      return hold(ctx, state, err.retryAfterSeconds ?? 60);
    }
    throw err;
  }
}

/**
 * A turn put off, with nothing held meanwhile: not even a reservation made just before an eviction,
 * which the state knows nothing of. `late`: a reservation may still land, so it is let go of again.
 */
async function hold(
  ctx: AppContext,
  from: TemplateAgentState,
  seconds: number,
  late = false,
): Promise<TemplateAgentCall> {
  const released = await releaseAgentTokens(ctx, from);
  const state = late ? { ...released, unsettled: true } : released;
  const retryAfterSeconds = state.unsettled ? Math.min(seconds, UNSETTLED_RETRY_SECONDS) : seconds;
  return { state: { ...state, retryAfterSeconds }, held: true };
}

/** Whether only what other agents hold is in the way of `tokens` more, as the run's count reads. */
async function mustWait(ctx: AppContext, state: TemplateAgentState, seq: number, tokens: number) {
  return (
    (await ctx.store.migrations.askAgentTokens(state.scope, state.runId, {
      templateId: state.templateId,
      seq,
      spent: spentOf(state),
      tokens,
      at: ctx.clock.now().toISOString(),
    })) === 'wait'
  );
}

/** Tells the run the agent's total; one that couldn't be told is marked, to be told again. */
async function settle(
  ctx: AppContext,
  state: TemplateAgentState,
  seq: number,
): Promise<TemplateAgentState> {
  const { unsettled: _, ...settled } = state;
  try {
    await ctx.store.migrations.settleAgentTokens(state.scope, state.runId, {
      templateId: state.templateId,
      seq,
      spent: spentOf(state),
      at: ctx.clock.now().toISOString(),
    });
    return settled;
  } catch {
    return { ...settled, unsettled: true };
  }
}

/**
 * Lets go of what an agent may still hold, a reservation whose answer it never heard included, and
 * says its total. An agent that never reserved has no line, and gets none. When the run can't be
 * told now the state comes back `unsettled`, and the host tells it again.
 */
export async function releaseAgentTokens(
  ctx: AppContext,
  state: TemplateAgentState,
): Promise<TemplateAgentState> {
  const ended = countLostCall(state);
  return settle(ctx, ended, (ended.calls ?? 0) + 1);
}
