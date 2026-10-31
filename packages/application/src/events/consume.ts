import type { DomainEvent } from '@contentworker/domain';
import type { EventBus } from '@contentworker/ports';
import {
  type AgentRunner,
  type PublishAgentRunSummary,
  type PublishAgentsConfig,
  runPublishAgents,
} from '../agent-actions.js';
import type { AppContext } from '../context.js';
import { type DispatchDeps, dispatchEvent } from './dispatch.js';

export interface ConsumeDeps extends DispatchDeps {
  /** Optional — live-content fan-out (SSE). Publish failures never block dispatch. */
  readonly bus?: EventBus;
  /** Invoked when the best-effort live publish fails (for caller-side logging). */
  readonly onLiveError?: (err: unknown) => void;
  /** Optional — on-publish agents (enrich/moderate); both must be set to run them. */
  readonly agents?: AgentRunner;
  readonly agentConfig?: PublishAgentsConfig;
}

/**
 * Consumes one relayed domain event end-to-end: dispatch (webhooks, cache
 * invalidation, RAG, functions), best-effort live fan-out, then the configured
 * on-publish agents. This is the single consumer body shared by every queue
 * host (the Worker's Cloudflare queue handler; tests call it directly). A throw propagates to the
 * queue for retry/dead-letter. Delivery is at-least-once — relayOutbox claims
 * rows (SKIP LOCKED) so duplicates are rare, but consumers must tolerate
 * redelivery: webhook receivers dedupe on the event id, and agent runs are
 * recorded proposals, never direct state changes.
 */
export async function consumeEvent(
  ctx: AppContext,
  deps: ConsumeDeps,
  event: DomainEvent,
): Promise<PublishAgentRunSummary[]> {
  await dispatchEvent(ctx, deps, event);
  if (deps.bus) {
    await deps.bus.publish(event).catch((err) => deps.onLiveError?.(err));
  }
  if (deps.agents && deps.agentConfig && event.type === 'entry.published') {
    return runPublishAgents(ctx, deps.agents, event.scope, event.entryId, deps.agentConfig);
  }
  return [];
}
