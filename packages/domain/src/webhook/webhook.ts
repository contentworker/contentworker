import type { EventType } from '../events';

/**
 * A webhook subscription. When a domain event matching one of `topics` is
 * relayed, the worker signs and POSTs the event to `url`. Signing/transport is
 * infrastructure; this type and `matchesTopic` are the pure parts.
 */
export interface Webhook {
  readonly id: string;
  readonly url: string;
  /** Event types this webhook is interested in. "*" matches everything. */
  readonly topics: readonly (EventType | '*')[];
  /** Shared secret used to HMAC-sign payloads. */
  readonly secret: string;
  readonly active: boolean;
  /** Extra static headers to send with each delivery. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * The one environment whose events it receives, or `null` for every environment in the space.
   * A scoped hook is visible (listed, editable) only under its environment; a space-wide one
   * under every environment.
   */
  readonly environmentId: string | null;
}

/** Outcome of a single delivery attempt, recorded for observability. */
export interface WebhookDelivery {
  readonly webhookId: string;
  readonly eventId: string;
  readonly status: 'success' | 'failed';
  readonly statusCode?: number;
  readonly attempts: number;
  readonly error?: string;
}

/** True if the webhook is space-wide or scoped to `environmentId`. */
export function coversEnvironment(webhook: Webhook, environmentId: string): boolean {
  return webhook.environmentId === null || webhook.environmentId === environmentId;
}

/** True if the webhook subscribes to the given event type. */
export function matchesTopic(webhook: Webhook, type: EventType): boolean {
  return webhook.active && webhook.topics.some((t) => t === '*' || t === type);
}
