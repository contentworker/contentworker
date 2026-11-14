import type { AppContext } from '@contentworker/application';
import type { DomainEvent } from '@contentworker/domain';
import { deliveryScopeTag, type PurgeMessage } from '@contentworker/platform/messages';
import { describe, expect, it } from 'vitest';
import { newPurgePlan, planPurges, sendPurges } from '../src/purges';

/**
 * A publish or edit only invalidates the environment's delivery responses (readers keep the stored
 * copy while it revalidates), while anything that must stop being served purges them outright.
 */
const ctx = {
  store: {
    assetCollections: { collectionsOf: async () => [] },
    spaces: { listEnvironments: async () => [{ id: 'main' }] },
  },
} as unknown as Pick<AppContext, 'store'>;

const scope = { spaceId: 's1', environmentId: 'main' };
const base = { id: 'e', scope, occurredAt: '2026-11-13T00:00:00Z' };
const tag = deliveryScopeTag('s1', 'main');

async function sent(events: object[]): Promise<PurgeMessage[]> {
  const plan = newPurgePlan();
  for (const e of events) await planPurges(ctx, plan, e as DomainEvent);
  const messages: PurgeMessage[] = [];
  await sendPurges(
    {
      PURGE_QUEUE: {
        send: async (m: unknown) => void messages.push(m as PurgeMessage),
      } as never,
    },
    plan,
    (what, err) => {
      throw new Error(`${what}: ${String(err)}`);
    },
  );
  return messages;
}

describe('delivery invalidation', () => {
  it('invalidates on a publish', async () => {
    const out = await sent([
      { ...base, type: 'entry.published', entryId: 'x', contentTypeApiId: 'post', version: 2 },
    ]);
    expect(out).toEqual([{ tags: [tag], mode: 'invalidate' }]);
  });

  it('invalidates on a menu, redirect or taxonomy change', async () => {
    for (const type of ['menus.changed', 'redirects.changed', 'taxonomy.changed']) {
      expect(await sent([{ ...base, type }]), type).toEqual([{ tags: [tag], mode: 'invalidate' }]);
    }
  });

  it('purges on an unpublish, even beside a publish in the same batch', async () => {
    const out = await sent([
      { ...base, type: 'entry.published', entryId: 'x', contentTypeApiId: 'post', version: 2 },
      { ...base, type: 'entry.unpublished', entryId: 'y', contentTypeApiId: 'post' },
    ]);
    expect(out).toEqual([{ tags: [tag] }]);
  });

  it('purges when assets stop being served or a republish replaces the file', async () => {
    for (const event of [
      { ...base, type: 'asset.unpublished', assetId: 'a' },
      { ...base, type: 'asset.deleted', assetId: 'a', version: 1 },
      { ...base, type: 'asset.rights_changed', assetId: 'a' },
      { ...base, type: 'asset.published', assetId: 'a', version: 3, replacedVersion: 2 },
    ]) {
      expect(await sent([event]), event.type).toEqual([{ tags: [tag] }]);
    }
  });

  it('invalidates on a plain asset publish', async () => {
    const out = await sent([{ ...base, type: 'asset.published', assetId: 'a', version: 1 }]);
    expect(out).toEqual([{ tags: [tag], mode: 'invalidate' }]);
  });

  it('purges everything in one call when a batch must purge anything', async () => {
    const out = await sent([
      { ...base, type: 'menus.changed', scope: { spaceId: 's1', environmentId: 'other' } },
      { ...base, type: 'entry.unpublished', entryId: 'y', contentTypeApiId: 'post' },
    ]);
    expect(out).toEqual([{ tags: [deliveryScopeTag('s1', 'other'), tag] }]);
  });

  it('purges when the environment, its alias or a type’s shape changes', async () => {
    for (const type of [
      'environment.deleted',
      'environment_alias.changed',
      'content_type.published',
    ]) {
      expect(await sent([{ ...base, type }]), type).toEqual([{ tags: [tag] }]);
    }
  });
});
