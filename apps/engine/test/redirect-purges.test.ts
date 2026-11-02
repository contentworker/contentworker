import { env } from 'cloudflare:workers';
import {
  type AppContext,
  consumeEvent,
  createRedirect,
  createSpace,
  deleteRedirect,
} from '@contentworker/application';
import { createD1Store } from '@contentworker/db';
import type { DomainEvent } from '@contentworker/domain';
import { deliveryScopeTag } from '@contentworker/platform/messages';
import { RecordingWebhookSender } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import { newPurgePlan, planPurges } from '../src/purges';

/**
 * A change to an environment's redirects reaches the delivery cache: Delivery serves the set and
 * each path's match under the scope's tag, so `redirects.changed` purges it, once per batch.
 */
const store = createD1Store(env.DB);

async function eventsOf(spaceId: string): Promise<DomainEvent[]> {
  const rows = await env.DB.prepare(
    "select payload from outbox where json_extract(payload, '$.scope.spaceId') = ? order by rowid",
  )
    .bind(spaceId)
    .all<{ payload: string }>();
  return rows.results.map((r) => JSON.parse(r.payload) as DomainEvent);
}

describe('redirect changes in the engine', () => {
  it('purge the environment’s delivery responses, and are handled without effects', async () => {
    const ctx: AppContext = {
      store,
      clock: { now: () => new Date() },
      ids: { newId: () => crypto.randomUUID() },
    };
    const spaceId = `engine-redirects-${crypto.randomUUID()}`;
    await createSpace(ctx, { spaceId, name: 'Redirects', defaultLocale: 'en-US' });
    const scope = { spaceId, environmentId: 'main' };
    const { redirect } = await createRedirect(ctx, scope, { source: '/a', destination: '/b' });
    await deleteRedirect(ctx, scope, redirect.id);

    const events = (await eventsOf(spaceId)).filter((e) => e.type === 'redirects.changed');
    expect(events).toHaveLength(2);
    const plan = newPurgePlan();
    for (const e of events) {
      // Redelivered too: a second run plans the same single tag.
      for (let run = 0; run < 2; run++) {
        await consumeEvent(ctx, { sender: new RecordingWebhookSender() }, e);
        await planPurges(ctx, plan, e);
      }
    }
    expect([...plan.delivery]).toEqual([deliveryScopeTag(spaceId, 'main')]);
    expect(plan.media.size + plan.revoked.size).toBe(0);
  });
});
