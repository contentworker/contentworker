import { DurableObject } from 'cloudflare:workers';
import type { DomainEvent, Scope } from '@contentworker/domain';
import type { EventBus } from '@contentworker/ports';
import type { EdgeEnv } from '../env.js';

const HEARTBEAT_MS = 15_000;

const scopeKey = (scope: Scope) => `${scope.spaceId}:${scope.environmentId}`;

interface SseClient {
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly types: string[];
}

const encoder = new TextEncoder();

function sseFrame(fields: { event: string; id?: string; data: string }): Uint8Array {
  const lines = [
    `event: ${fields.event}`,
    ...(fields.id ? [`id: ${fields.id}`] : []),
    `data: ${fields.data}`,
    '',
    '',
  ];
  return encoder.encode(lines.join('\n'));
}

/**
 * Live Content API fan-out hub — one object per space:environment. The queue
 * consumer publishes domain events via the `publish` RPC; delivery clients hold
 * an SSE stream served straight from `fetch` (the edge live route authorizes,
 * then forwards the request here). Dead writers are pruned on write failure.
 */
export class LiveHubDO extends DurableObject<EdgeEnv> {
  private clients = new Map<string, SseClient>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  /** Connection counter — client keys are DO-instance-local, not entity ids. */
  private seq = 0;

  /** Fan a domain event out to every connected client (filtered by ?types=). */
  async publish(event: DomainEvent): Promise<void> {
    const frame = sseFrame({ event: event.type, id: event.id, data: JSON.stringify(event) });
    await this.broadcast(event.type, frame);
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const types = (url.searchParams.get('types') ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const id = String(++this.seq);
    this.clients.set(id, { writer, types });
    this.ensureHeartbeat();

    // Initial ping so clients observe an open stream immediately.
    writer.write(sseFrame({ event: 'ping', data: '' })).catch(() => this.drop(id));

    return new Response(readable, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  }

  private async broadcast(eventType: string, frame: Uint8Array): Promise<void> {
    for (const [id, client] of this.clients) {
      if (client.types.length > 0 && !client.types.includes(eventType)) continue;
      // Never await writes: a client that stopped reading would park the write
      // promise on backpressure and stall publish() (and the queue consumer
      // behind it). Zero desiredSize means the buffer is full — drop the
      // client; failed writes also drop.
      if (client.writer.desiredSize !== null && client.writer.desiredSize <= 0) {
        this.drop(id);
        continue;
      }
      client.writer.write(frame).catch(() => this.drop(id));
    }
  }

  private drop(id: string): void {
    const client = this.clients.get(id);
    this.clients.delete(id);
    client?.writer.close().catch(() => {});
    if (this.clients.size === 0 && this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  private ensureHeartbeat(): void {
    // Heartbeats keep proxies from reaping idle SSE connections and detect
    // departed clients (their write fails → dropped).
    this.heartbeat ??= setInterval(() => {
      void this.broadcast('ping', sseFrame({ event: 'ping', data: '' }));
    }, HEARTBEAT_MS);
  }
}

/**
 * EventBus over the LiveHub Durable Objects: `publish` routes an event to its
 * scope's hub. `subscribe` is unsupported here — on Cloudflare the subscribe
 * side is the DO-served SSE stream (see routes/live.ts), not this port.
 */
export function createDoEventBus(ns: DurableObjectNamespace<LiveHubDO>): EventBus {
  return {
    async publish(event) {
      const stub = ns.get(ns.idFromName(scopeKey(event.scope)));
      await stub.publish(event);
    },
    subscribe() {
      throw new Error(
        'EventBus.subscribe is not supported on Cloudflare — the live SSE route is served by LiveHubDO',
      );
    },
  };
}
