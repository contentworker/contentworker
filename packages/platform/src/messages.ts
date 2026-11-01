import type { DomainEvent, Scope } from '@contentworker/domain';

/** Minimal runtime shape check for a queued DomainEvent (defensive, not exhaustive). */
export function isDomainEvent(body: unknown): body is DomainEvent {
  if (typeof body !== 'object' || body === null) return false;
  const e = body as Record<string, unknown>;
  const scope = e.scope as Record<string, unknown> | undefined;
  return (
    typeof e.id === 'string' &&
    typeof e.type === 'string' &&
    typeof e.occurredAt === 'string' &&
    typeof scope?.spaceId === 'string' &&
    typeof scope?.environmentId === 'string'
  );
}

/** One on-publish agent job on the `contentworker-agents` queue (consumed one at a time). */
export interface AgentJobMessage {
  readonly kind: 'agent.publish_run';
  readonly scope: Scope;
  readonly entryId: string;
}

export function isAgentJob(body: unknown): body is AgentJobMessage {
  if (typeof body !== 'object' || body === null) return false;
  const j = body as Record<string, unknown>;
  const scope = j.scope as Record<string, unknown> | undefined;
  return (
    j.kind === 'agent.publish_run' &&
    typeof j.entryId === 'string' &&
    typeof scope?.spaceId === 'string' &&
    typeof scope?.environmentId === 'string'
  );
}

/**
 * One message on the `contentworker-purge` queue: cache tags whose delivery responses are stale.
 * Produced by the engine after a publish-side event, consumed by the delivery Worker (rationed).
 */
export interface PurgeMessage {
  readonly tags: readonly string[];
}

/** Cache tag for everything delivered from one space:environment (delivery responses carry it). */
export const deliveryScopeTag = (spaceId: string, environmentId: string) =>
  `cw:${spaceId}:${environmentId}`;

/**
 * Another attempt at one webhook delivery, on the events queue with a delay (the backoff). Not a
 * domain event: the engine's events consumer recognises it by `kind` and re-sends to that webhook
 * alone (`redeliverWebhook`), so a down receiver neither loses the event nor re-drives the rest
 * of its dispatch.
 */
export interface WebhookRetryMessage {
  readonly kind: 'webhook.retry';
  readonly webhookId: string;
  readonly event: DomainEvent;
  /** The attempt this message is (2 for the first retry). */
  readonly attempt: number;
}

export function isWebhookRetryMessage(value: unknown): value is WebhookRetryMessage {
  const m = value as Partial<WebhookRetryMessage> | null;
  return (
    !!m &&
    m.kind === 'webhook.retry' &&
    typeof m.webhookId === 'string' &&
    typeof m.attempt === 'number' &&
    typeof m.event === 'object' &&
    m.event !== null
  );
}
