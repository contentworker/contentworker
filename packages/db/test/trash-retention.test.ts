import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  getTrashSettings,
  publishContentType,
  publishEntry,
  setTrashRetention,
  sweepExpiredTrash,
  trashEntry,
} from '@contentworker/application';
import { type FieldDefinition, type Principal, SCOPES } from '@contentworker/domain';
import { FixedClock } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Trash retention on D1 (0023_trash_retention): the space's setting, and the sweep's read of
 * expired trash, oldest first, past published links, on the partial `entries_trashed` index. An
 * archived entry's `updated_at` is when it was trashed; the store stamps it with database time, so
 * the tests move it back by hand. Each test makes its own space: the file shares one database.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();
const DAY = 24 * 60 * 60 * 1000;
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };

async function harness() {
  // A month and a bit after now, so anything trashed during the test is inside a 30-day window
  // until it is moved back.
  const clock = new FixedClock(new Date(Date.now() + 31 * DAY));
  const ctx: AppContext = { store, clock, ids: { newId: uid } };
  const spaceId = `trash-${uid()}`;
  await createSpace(ctx, { spaceId, name: 'Trash', defaultLocale: 'en-US' });
  const scope = { spaceId, environmentId: 'main' };
  await createContentType(ctx, scope, {
    apiId: 'note',
    name: 'Note',
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
      {
        apiId: 'see',
        name: 'See',
        type: 'Link',
        linkType: 'Entry',
        localized: false,
        required: false,
        position: 1,
      },
    ] as FieldDefinition[],
  });
  await publishContentType(ctx, scope, 'note');
  return { ctx, clock, spaceId, scope };
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function note(h: Harness, title: string, fields: Record<string, unknown> = {}) {
  return (
    await createEntry(h.ctx, h.scope, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': title }, ...fields },
    })
  ).entry.id;
}

/** Sets when an entry last changed, as if it had been trashed `daysAgo` days before now. */
async function trashedAgo(h: Harness, id: string, daysAgo: number) {
  await testDb
    .prepare(
      'UPDATE entries SET updated_at = ? WHERE space_id = ? AND environment_id = ? AND id = ?',
    )
    .bind(Date.now() - daysAgo * DAY, h.scope.spaceId, h.scope.environmentId, id)
    .run();
}

describe('trash retention on D1', () => {
  it('stores the setting per space, off by default', async () => {
    const h = await harness();
    expect(await getTrashSettings(h.ctx, h.scope)).toEqual({ retentionDays: null });
    await setTrashRetention(h.ctx, admin, h.scope, 30);
    expect((await store.spaces.getConfig(h.scope))?.trashRetentionDays).toBe(30);
    expect((await store.spaces.list()).find((s) => s.spaceId === h.spaceId)).toMatchObject({
      trashRetentionDays: 30,
    });
    await setTrashRetention(h.ctx, admin, h.scope, null);
    expect((await store.spaces.getConfig(h.scope))?.trashRetentionDays).toBeUndefined();
  });

  it('lists expired trash oldest first, past the parameter cap, leaving out linked entries', async () => {
    const h = await harness();
    const expired: string[] = [];
    for (let i = 0; i < 105; i++) {
      const id = await note(h, `n${i}`);
      await trashEntry(h.ctx, h.scope, id);
      await trashedAgo(h, id, 200 - i);
      expired.push(id);
    }
    const recent = await note(h, 'recent');
    await trashEntry(h.ctx, h.scope, recent);
    const untrashed = await note(h, 'kept');
    await trashedAgo(h, untrashed, 300);
    const linked = await note(h, 'linked');
    const linker = await note(h, 'linker', { see: { 'en-US': { id: linked, linkType: 'Entry' } } });
    await publishEntry(h.ctx, h.scope, linked);
    await publishEntry(h.ctx, h.scope, linker);
    await trashEntry(h.ctx, h.scope, linked);
    await trashedAgo(h, linked, 400);

    const before = new Date(Date.now() - 30 * DAY);
    expect(await store.entries.listExpiredTrash(h.scope, before, 200)).toEqual(expired);
    expect(await store.entries.listExpiredTrash(h.scope, before, 3)).toEqual(expired.slice(0, 3));
    // Scoped: another environment of the space sees none of it.
    expect(
      await store.entries.listExpiredTrash({ ...h.scope, environmentId: 'staging' }, before, 200),
    ).toEqual([]);
  });

  it('sweeps what is past the window through purgeEntry, and nothing on a second run', async () => {
    const h = await harness();
    await setTrashRetention(h.ctx, admin, h.scope, 30);
    const old = await note(h, 'old');
    const young = await note(h, 'young');
    await trashEntry(h.ctx, h.scope, old);
    await trashEntry(h.ctx, h.scope, young);
    // The clock is 31 days ahead: `old` was trashed 31 + 10 days before it, `young` 31 - 20.
    await trashedAgo(h, old, 10);
    await trashedAgo(h, young, -20);

    const first = await sweepExpiredTrash(h.ctx, { limit: 1000 });
    expect(first.purged).toBeGreaterThanOrEqual(1);
    expect(await store.entries.get(h.scope, old)).toBeNull();
    expect(await store.entries.get(h.scope, young)).not.toBeNull();
    expect((await store.entries.listVersions(h.scope, old)).length).toBe(0);

    const second = await sweepExpiredTrash(h.ctx, { limit: 1000 });
    expect(await store.entries.get(h.scope, young)).not.toBeNull();
    // Other tests' spaces share the database; none of this space's entries go twice.
    expect(second.refused).toBe(0);
  });
});
