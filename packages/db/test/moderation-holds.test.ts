import {
  type AppContext,
  countPendingApprovals,
  createContentType,
  createEntry,
  createSpace,
  getEntry,
  holdEntryForModeration,
  keepHeldEntryUnpublished,
  listModerationHolds,
  publishEntry,
  republishHeldEntry,
  SYSTEM_CALLER,
} from '@contentworker/application';
import { ConflictError, type ModerationHold, type Principal } from '@contentworker/domain';
import { TransactionConflictError } from '@contentworker/ports';
import { FixedClock } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Moderation holds on D1 (0051_moderation_holds): the hold opening in the same batch as the
 * unpublish and its outbox row, one open hold per entry, the decision's compare-and-set refusing a
 * lost race at commit, and an uncapped count per type. Each test makes its own space: the file
 * shares one database.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();
const AT = '2026-01-01T00:00:00.000Z';

async function harness() {
  const ctx: AppContext = { store, clock: new FixedClock(new Date(AT)), ids: { newId: uid } };
  const spaceId = `holds-${uid()}`;
  await createSpace(ctx, { spaceId, name: 'Holds', defaultLocale: 'en-US' });
  const scope = { spaceId, environmentId: 'main' };
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'post',
    name: 'Post',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
    ],
  });
  const post = async () => {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'Flagged' } },
    });
    await publishEntry(ctx, scope, entry.id);
    return entry.id;
  };
  const outbox = async (entryId: string, type: string) =>
    (
      await testDb
        .prepare('SELECT count(*) AS n FROM outbox WHERE type = ? AND payload LIKE ?')
        .bind(type, `%${entryId}%`)
        .first<{ n: number }>()
    )?.n ?? 0;
  return { ctx, scope, post, outbox };
}

const person = (subject: string): { principal: Principal } => ({
  principal: { spaceId: '*', kind: 'user', subject, scopes: ['content:publish'] },
});

const hold = (entryId: string, over: Partial<ModerationHold> = {}): ModerationHold => ({
  id: uid(),
  entryId,
  contentTypeApiId: 'post',
  entryVersion: 1,
  flags: ['hate'],
  status: 'open',
  createdAt: AT,
  ...over,
});

describe('moderation holds on D1', () => {
  it('opens a hold with the unpublish and its event, once', async () => {
    const { ctx, scope, post, outbox } = await harness();
    const entryId = await post();
    expect(await holdEntryForModeration(ctx, scope, entryId, { flags: ['hate'] })).toBe('held');
    expect((await getEntry(ctx, scope, entryId)).entry.publishedVersion).toBeNull();
    expect(await outbox(entryId, 'entry.unpublished')).toBe(1);
    const [open, ...rest] = await store.moderationHolds.list(scope, { status: 'open' });
    expect(rest).toEqual([]);
    expect(open).toMatchObject({ entryId, entryVersion: 1, flags: ['hate'], status: 'open' });
    // A retried step finds it already offline.
    expect(await holdEntryForModeration(ctx, scope, entryId, { flags: ['hate'] })).toBe(
      'not_published',
    );
    expect(await outbox(entryId, 'entry.unpublished')).toBe(1);
  });

  it('keeps at most one open hold per entry', async () => {
    const { scope } = await harness();
    expect(await store.moderationHolds.create(scope, hold('e1'))).toBe(true);
    expect(await store.moderationHolds.create(scope, hold('e1'))).toBe(false);
    // Inside a unit the insert is still queued, so the open one aborts the unit at commit.
    await expect(
      store.withTransaction((tx) => tx.moderationHolds.create(scope, hold('e1'))),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    expect(await store.moderationHolds.list(scope, { entryId: 'e1' })).toHaveLength(1);
    // A decided hold leaves room for a new one.
    const [first] = await store.moderationHolds.list(scope, { entryId: 'e1' });
    await store.moderationHolds.decide(scope, first?.id ?? '', {
      status: 'kept',
      decidedAt: AT,
      decidedBy: 'usr_a',
    });
    expect(await store.moderationHolds.create(scope, hold('e1'))).toBe(true);
    expect(await store.moderationHolds.list(scope, { entryId: 'e1' })).toHaveLength(2);
  });

  it('aborts a unit whose decision lost the race at commit', async () => {
    const { scope } = await harness();
    const h = hold('e1');
    await store.moderationHolds.create(scope, h);
    const decision = { status: 'kept' as const, decidedAt: AT, decidedBy: 'usr_a' };
    await expect(
      store.withTransaction(async (tx) => {
        expect(await tx.moderationHolds.decide(scope, h.id, decision)).toBe(true);
        // Someone else decides between this unit's reads and its commit.
        expect(
          await store.moderationHolds.decide(scope, h.id, { ...decision, decidedBy: 'usr_b' }),
        ).toBe(true);
      }),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    expect(await store.moderationHolds.get(scope, h.id)).toMatchObject({ decidedBy: 'usr_b' });
    // Once decided, a direct decide reports the loss instead.
    expect(await store.moderationHolds.decide(scope, h.id, decision)).toBe(false);
  });

  it('republishes the held version, and refuses a decided hold', async () => {
    const { ctx, scope, post, outbox } = await harness();
    const entryId = await post();
    await holdEntryForModeration(ctx, scope, entryId, { flags: ['spam'] });
    const [open] = await store.moderationHolds.list(scope, { status: 'open' });
    const result = await republishHeldEntry(ctx, scope, open?.id ?? '', {
      ...person('usr_editor'),
      note: 'False positive',
    });
    expect(result.published).toBe(true);
    expect((await getEntry(ctx, scope, entryId)).entry.publishedVersion).toBe(1);
    expect(await outbox(entryId, 'entry.published')).toBe(2);
    expect(await store.moderationHolds.get(scope, open?.id ?? '')).toMatchObject({
      status: 'republished',
      decidedBy: 'usr_editor',
      note: 'False positive',
    });
    // The pass its republish starts leaves the released version live.
    expect(await holdEntryForModeration(ctx, scope, entryId, { flags: ['spam'] })).toBe(
      'overridden',
    );
    await expect(
      keepHeldEntryUnpublished(ctx, scope, open?.id ?? '', person('usr_other')),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('lets the first of Keep and Republish win, and the other commit nothing', async () => {
    const { ctx, scope, post, outbox } = await harness();
    const entryId = await post();
    await holdEntryForModeration(ctx, scope, entryId, { flags: ['spam'] });
    const [open] = await store.moderationHolds.list(scope, { status: 'open' });
    const id = open?.id ?? '';
    // Republish reads the hold open; Keep commits between its reads and its commit.
    const racing: AppContext = {
      ...ctx,
      store: {
        ...store,
        withTransaction: (fn) =>
          store.withTransaction((tx) =>
            fn({
              ...tx,
              moderationHolds: {
                ...tx.moderationHolds,
                decide: async (...args) => {
                  const queued = await tx.moderationHolds.decide(...args);
                  await keepHeldEntryUnpublished(ctx, scope, id, person('usr_keeper'));
                  return queued;
                },
              },
            }),
          ),
      },
    };
    await expect(republishHeldEntry(racing, scope, id, person('usr_editor'))).rejects.toThrow(
      /already decided \(kept\)/,
    );
    // The publish rode in the losing unit: nothing went live, no event went out.
    expect((await getEntry(ctx, scope, entryId)).entry.publishedVersion).toBeNull();
    expect(await outbox(entryId, 'entry.published')).toBe(1);
    expect(await store.moderationHolds.get(scope, id)).toMatchObject({
      status: 'kept',
      decidedBy: 'usr_keeper',
    });
  });

  it('aborts a refresh of a hold decided meanwhile, with the unpublish it rode with', async () => {
    const { ctx, scope, post, outbox } = await harness();
    const entryId = await post();
    await store.moderationHolds.create(scope, hold(entryId));
    const [open] = await store.moderationHolds.list(scope, { entryId });
    const lost: AppContext = {
      ...ctx,
      store: {
        ...store,
        withTransaction: (fn) =>
          store.withTransaction((tx) =>
            fn({
              ...tx,
              moderationHolds: {
                ...tx.moderationHolds,
                refresh: async (...args) => {
                  const queued = await tx.moderationHolds.refresh(...args);
                  await store.moderationHolds.decide(scope, open?.id ?? '', {
                    status: 'kept',
                    decidedAt: AT,
                    decidedBy: 'usr_a',
                  });
                  return queued;
                },
              },
            }),
          ),
      },
    };
    await expect(
      holdEntryForModeration(lost, scope, entryId, { flags: ['hate'] }),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    expect((await getEntry(ctx, scope, entryId)).entry.publishedVersion).toBe(1);
    expect(await outbox(entryId, 'entry.unpublished')).toBe(0);
  });

  it('counts open holds per type past the lists’ caps, one scope only', async () => {
    const { ctx, scope } = await harness();
    const other = { spaceId: scope.spaceId, environmentId: 'staging' };
    for (let i = 0; i < 105; i++) {
      await store.moderationHolds.create(scope, hold(`e${i}`, { contentTypeApiId: 'post' }));
    }
    await store.moderationHolds.create(scope, hold('k', { status: 'kept' }));
    await store.moderationHolds.create(other, hold('o'));
    expect(await store.moderationHolds.countOpen(scope)).toEqual([
      { contentTypeApiId: 'post', count: 105 },
    ]);
    expect((await countPendingApprovals(ctx, scope)).moderationHolds).toBe(105);
    // Every status unless one is asked for.
    expect(await listModerationHolds(ctx, scope, { status: 'open', limit: 500 })).toHaveLength(105);
    expect(await store.moderationHolds.list(scope, { limit: 1000 })).toHaveLength(106);
    expect(await store.moderationHolds.list(other)).toHaveLength(1);
  });
});
