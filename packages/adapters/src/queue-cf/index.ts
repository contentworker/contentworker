import type { Queue, Subscription } from '@contentworker/ports';

/** The subset of a Cloudflare Queues producer binding this adapter uses. */
export interface CfQueueBinding {
  send(message: unknown, options?: { delaySeconds?: number }): Promise<unknown>;
  sendBatch(
    messages: Iterable<{ body: unknown; delaySeconds?: number }>,
    options?: { delaySeconds?: number },
  ): Promise<unknown>;
}

/** Cloudflare Queues caps: 100 messages and 256 KB total per sendBatch call. */
const MAX_BATCH_COUNT = 100;
const MAX_BATCH_BYTES = 200 * 1024; // headroom under the 256 KB hard limit

/**
 * Produce-only Queue adapter over Cloudflare Queues producer bindings, keyed
 * by topic. `process()` throws: on Cloudflare, consumers are declarative — the
 * `queue()` handler in the edge composition root routes batches to
 * `consumeEvent` — so nothing should ever subscribe through this port there.
 *
 * `dedupeKey` is accepted but ignored (Cloudflare Queues has no producer-side
 * dedupe); event dispatch is idempotent on the event id, so at-least-once
 * delivery already covers duplicates.
 */
export function createCfQueueProducer(bindings: Record<string, CfQueueBinding>): Queue {
  const bindingFor = (topic: string): CfQueueBinding => {
    const binding = bindings[topic];
    if (!binding) throw new Error(`No Cloudflare queue binding for topic "${topic}"`);
    return binding;
  };

  return {
    async enqueue(topic, payload, opts) {
      await bindingFor(topic).send(payload, {
        ...(opts?.delayMs ? { delaySeconds: Math.ceil(opts.delayMs / 1000) } : {}),
      });
    },
    async enqueueMany(topic, messages) {
      const binding = bindingFor(topic);
      // Chunk by count and (approximate) payload size: sendBatch rejects the
      // whole call past 100 messages / 256 KB, and one oversized batch must
      // not fail the relay of every event in it.
      let batch: { body: unknown; delaySeconds?: number }[] = [];
      let batchBytes = 0;
      const flush = async () => {
        if (batch.length === 0) return;
        await binding.sendBatch(batch);
        batch = [];
        batchBytes = 0;
      };
      const encoder = new TextEncoder();
      for (const msg of messages) {
        // Real UTF-8 bytes, not UTF-16 code units — non-ASCII payloads are up
        // to 3× larger on the wire than their string length suggests.
        const serialized = JSON.stringify(msg.payload);
        const bytes = serialized ? encoder.encode(serialized).byteLength : 0;
        if (
          batch.length >= MAX_BATCH_COUNT ||
          (batch.length > 0 && batchBytes + bytes > MAX_BATCH_BYTES)
        ) {
          await flush();
        }
        batch.push({
          body: msg.payload,
          ...(msg.delayMs ? { delaySeconds: Math.ceil(msg.delayMs / 1000) } : {}),
        });
        batchBytes += bytes;
      }
      await flush();
    },
    process(topic): Subscription {
      throw new Error(
        `Queue.process("${topic}") is not supported on Cloudflare — consumers are wired as queue() handlers in apps/engine`,
      );
    },
  };
}
