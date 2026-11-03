import { ForbiddenError, type Principal, SCOPES, ValidationError } from '@contentworker/domain';
import type { HookDispatcher, HookResult } from '@contentworker/ports';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  getTrashSettings,
  publishContentType,
  publishEntry,
  setTrashRetention,
  sweepExpiredTrash,
  trashEntry,
} from '../src/index';

const DAY = 24 * 60 * 60 * 1000;
const main = { spaceId: 's1', environmentId: 'main' };
const staging = { spaceId: 's1', environmentId: 'staging' };
const otherSpace = { spaceId: 's2', environmentId: 'main' };
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
const editor: Principal = { spaceId: 's1', kind: 'cma', scopes: [SCOPES.contentWrite] };

let ctx: AppContext;
let store: InMemoryContentStore;
let clock: FixedClock;

beforeEach(async () => {
  store = new InMemoryContentStore();
  clock = new FixedClock();
  // The store stamps `updated_at` (when an entry was trashed) from the same clock.
  store.nowMs = () => clock.now().getTime();
  ctx = { store, clock, ids: new SequenceIdGenerator('e') };
  for (const spaceId of ['s1', 's2']) {
    store.seedSpace({ spaceId, defaultLocale: 'en-US', locales: ['en-US'] });
    await store.spaces.createEnvironment(spaceId, 'main', 'main');
  }
  await store.spaces.createEnvironment('s1', 'staging', 'staging');
  for (const scope of [main, staging, otherSpace]) {
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
      ],
    } as Parameters<typeof createContentType>[2]);
    await publishContentType(ctx, scope, 'note');
  }
});

async function trashed(scope: typeof main, title: string): Promise<string> {
  const { entry } = await createEntry(ctx, scope, {
    contentTypeApiId: 'note',
    fields: { title: { 'en-US': title } },
  });
  await trashEntry(ctx, scope, entry.id);
  return entry.id;
}

const exists = async (scope: typeof main, id: string) =>
  (await store.entries.get(scope, id)) !== null;

describe('the trash retention setting', () => {
  it('is off until a space admin sets it, and can be turned off again', async () => {
    expect(await getTrashSettings(ctx, main)).toEqual({ retentionDays: null });
    expect(await setTrashRetention(ctx, admin, main, 30)).toEqual({ retentionDays: 30 });
    expect(await getTrashSettings(ctx, main)).toEqual({ retentionDays: 30 });
    // Per space: every environment of it, and no other space.
    expect(await getTrashSettings(ctx, staging)).toEqual({ retentionDays: 30 });
    expect(await getTrashSettings(ctx, otherSpace)).toEqual({ retentionDays: null });
    await setTrashRetention(ctx, admin, main, null);
    expect(await getTrashSettings(ctx, main)).toEqual({ retentionDays: null });
  });

  it('takes whole days from 1 to 3650, from a space admin only', async () => {
    for (const bad of [0, -1, 1.5, 3651]) {
      await expect(setTrashRetention(ctx, admin, main, bad)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    await expect(setTrashRetention(ctx, editor, main, 7)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('the retention sweep', () => {
  it('purges nothing while retention is off, however old the trash', async () => {
    const id = await trashed(main, 'old');
    clock.advance(5000 * DAY);
    expect(await sweepExpiredTrash(ctx)).toEqual({ purged: 0, refused: 0 });
    expect(await exists(main, id)).toBe(true);
  });

  it('purges what was trashed longer ago than the window, in every environment of the space', async () => {
    await setTrashRetention(ctx, admin, main, 30);
    const old = await trashed(main, 'old');
    const oldStaging = await trashed(staging, 'old staging');
    const elsewhere = await trashed(otherSpace, 'other space');
    clock.advance(20 * DAY);
    const recent = await trashed(main, 'recent');
    const { entry: live } = await createEntry(ctx, main, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'not trashed' } },
    });
    clock.advance(11 * DAY);

    expect(await sweepExpiredTrash(ctx)).toEqual({ purged: 2, refused: 0 });
    expect(await exists(main, old)).toBe(false);
    expect(await exists(staging, oldStaging)).toBe(false);
    expect(await exists(main, recent)).toBe(true);
    expect(await exists(main, live.id)).toBe(true);
    // Another space without retention keeps its trash.
    expect(await exists(otherSpace, elsewhere)).toBe(true);

    // A second run finds nothing more to do.
    expect(await sweepExpiredTrash(ctx)).toEqual({ purged: 0, refused: 0 });
  });

  it('keeps an entry a published entry links to, and is not stalled by it', async () => {
    await setTrashRetention(ctx, admin, main, 1);
    const { entry: target } = await createEntry(ctx, main, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'target' } },
    });
    const { entry: linker } = await createEntry(ctx, main, {
      contentTypeApiId: 'note',
      fields: {
        title: { 'en-US': 'linker' },
        see: { 'en-US': { id: target.id, linkType: 'Entry' } },
      },
    });
    await publishEntry(ctx, main, target.id);
    await publishEntry(ctx, main, linker.id);
    await trashEntry(ctx, main, target.id);
    clock.advance(DAY);
    const after = await trashed(main, 'after');
    clock.advance(2 * DAY);

    // With room for one purge, the linked (older) entry doesn't take it.
    expect(await sweepExpiredTrash(ctx, { limit: 1 })).toEqual({ purged: 1, refused: 0 });
    expect(await exists(main, target.id)).toBe(true);
    expect(await exists(main, after)).toBe(false);
  });

  it('purges in bounded runs, shared between environments', async () => {
    await setTrashRetention(ctx, admin, main, 1);
    for (let i = 0; i < 5; i++) await trashed(main, `m${i}`);
    const inStaging = await trashed(staging, 's');
    clock.advance(2 * DAY);

    expect(await sweepExpiredTrash(ctx, { limit: 2 })).toEqual({ purged: 2, refused: 0 });
    // The large trash in main didn't take staging's share.
    expect(await exists(staging, inStaging)).toBe(false);
    expect(await sweepExpiredTrash(ctx, { limit: 100 })).toEqual({ purged: 4, refused: 0 });
  });

  it('leaves an entry a plugin refuses to purge, and counts it', async () => {
    const hooks: HookDispatcher = {
      async dispatch<T>(hook: string, payload: T): Promise<HookResult<T>> {
        return hook === 'entry:beforePurge'
          ? { veto: { hook: 'com.example.keep', reason: 'Legal hold' } }
          : { payload };
      },
    };
    ctx = { ...ctx, hooks };
    await setTrashRetention(ctx, admin, main, 1);
    const id = await trashed(main, 'held');
    clock.advance(2 * DAY);
    expect(await sweepExpiredTrash(ctx)).toEqual({ purged: 0, refused: 1 });
    expect(await exists(main, id)).toBe(true);
  });
});
