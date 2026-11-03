import { ConflictError, NotFoundError, singletonClaim } from '@contentworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  bulkCreateEntries,
  createContentType,
  createEntry,
  createEnvironment,
  createSpace,
  duplicateEntry,
  getContentType,
  getDeliveredSingleton,
  getPreviewSingleton,
  mergeEnvironments,
  publishContentType,
  publishEntry,
  restoreEntry,
  trashEntry,
  updateContentType,
  updateEntry,
} from '../src/index';

const scope = { spaceId: 'site', environmentId: 'main' };
const staging = { spaceId: 'site', environmentId: 'staging' };

function setup() {
  const store = new InMemoryContentStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  return { ctx, store };
}
type Harness = ReturnType<typeof setup>;

const symbol = (apiId: string, position: number, extra: Record<string, unknown> = {}) => ({
  apiId,
  name: apiId,
  type: 'Symbol' as const,
  localized: false,
  required: false,
  position,
  ...extra,
});

async function settingsType(h: Harness, s = scope, singleton = true) {
  await createContentType(h.ctx, s, {
    apiId: 'settings',
    name: 'Site settings',
    displayField: 'title',
    fields: [
      symbol('title', 0),
      symbol('code', 1, { unique: true }),
      {
        apiId: 'home',
        name: 'Home',
        type: 'Link',
        linkType: 'Entry',
        localized: false,
        required: false,
        position: 2,
      },
    ],
    singleton,
  } as Parameters<typeof createContentType>[2]);
  await publishContentType(h.ctx, s, 'settings');
}

async function pageType(h: Harness, s = scope) {
  await createContentType(h.ctx, s, {
    apiId: 'page',
    name: 'Page',
    displayField: 'title',
    fields: [symbol('title', 0)],
  } as Parameters<typeof createContentType>[2]);
  await publishContentType(h.ctx, s, 'page');
}

const settings = (h: Harness, title: string, s = scope) =>
  createEntry(h.ctx, s, { contentTypeApiId: 'settings', fields: { title: { 'en-US': title } } });

describe('singleton types', () => {
  let h: Harness;

  beforeEach(async () => {
    h = setup();
    await createSpace(h.ctx, { spaceId: 'site', name: 'Site', defaultLocale: 'en-US' });
    await settingsType(h);
  });

  it('stores the flag only when set, and keeps it through a revision that leaves it out', async () => {
    expect((await getContentType(h.ctx, scope, 'settings')).singleton).toBe(true);
    await pageType(h);
    expect('singleton' in (await getContentType(h.ctx, scope, 'page'))).toBe(false);

    const revised = await updateContentType(h.ctx, scope, 'settings', { name: 'Settings' });
    expect(revised.singleton).toBe(true);
  });

  it('refuses a second entry on create, bulk create and duplicate, naming the one it has', async () => {
    const first = await settings(h, 'Site');

    const second = settings(h, 'Another');
    await expect(second).rejects.toBeInstanceOf(ConflictError);
    await expect(second).rejects.toThrow(first.entry.id);

    const bulk = await bulkCreateEntries(h.ctx, scope, [
      { contentTypeApiId: 'settings', fields: { title: { 'en-US': 'Bulk' } } },
    ]);
    expect(bulk.failed).toBe(1);
    expect(bulk.results[0]?.error).toContain('singleton');

    await expect(duplicateEntry(h.ctx, scope, first.entry.id)).rejects.toBeInstanceOf(
      ConflictError,
    );
    // Editing the one entry is never refused by its own claim.
    await updateEntry(h.ctx, scope, first.entry.id, { title: { 'en-US': 'Site, edited' } });
    expect((await h.store.entries.list(scope, { contentTypeApiId: 'settings' })).length).toBe(1);
  });

  it('refuses the second of two racing creates through the claim, when its read saw no entry', async () => {
    const first = await settings(h, 'A');
    // The race: the second create's read ran before the first committed, so it saw nothing.
    const list = h.store.entries.list;
    h.store.entries.list = async () => [];
    try {
      await expect(settings(h, 'B')).rejects.toBeInstanceOf(ConflictError);
    } finally {
      h.store.entries.list = list;
    }
    const left = await h.store.entries.list(scope, { contentTypeApiId: 'settings' });
    expect(left.map((e) => e.entry.id)).toEqual([first.entry.id]);
  });

  it('still refuses a second entry when the one it has lost its claim (written by an older release)', async () => {
    const first = await settings(h, 'Site');
    // What a rollback leaves: the entry saved by code that knew nothing of the claim.
    await h.store.entries.releaseUniqueClaims(scope, first.entry.id);
    await expect(settings(h, 'Another')).rejects.toThrow(first.entry.id);
  });

  it('frees the singleton when its entry goes to the trash, and refuses to restore it beside a new one', async () => {
    const first = await settings(h, 'Old');
    await trashEntry(h.ctx, scope, first.entry.id);
    const second = await settings(h, 'New');

    const restore = restoreEntry(h.ctx, scope, first.entry.id);
    await expect(restore).rejects.toBeInstanceOf(ConflictError);
    await expect(restore).rejects.toThrow(second.entry.id);

    // With the new one trashed in turn, the old one comes back.
    await trashEntry(h.ctx, scope, second.entry.id);
    await restoreEntry(h.ctx, scope, first.entry.id);
  });

  it('refuses turning the flag on for a type with more than one entry, naming them', async () => {
    await pageType(h);
    const ids: string[] = [];
    for (const title of ['a', 'b', 'c']) {
      ids.push(
        (
          await createEntry(h.ctx, scope, {
            contentTypeApiId: 'page',
            fields: { title: { 'en-US': title } },
          })
        ).entry.id,
      );
    }
    const turn = updateContentType(h.ctx, scope, 'page', { singleton: true });
    await expect(turn).rejects.toBeInstanceOf(ConflictError);
    await expect(turn).rejects.toThrow(ids[0] as string);
    expect('singleton' in (await getContentType(h.ctx, scope, 'page'))).toBe(false);

    // Trashed entries don't count: with two in the trash, the one left makes it a singleton.
    await trashEntry(h.ctx, scope, ids[1] as string);
    await trashEntry(h.ctx, scope, ids[2] as string);
    await updateContentType(h.ctx, scope, 'page', { singleton: true });
    const held = await h.store.entries.findUniqueConflicts(scope, [singletonClaim('page')]);
    expect(held.map((c) => c.entryId)).toEqual([ids[0]]);
    await expect(
      createEntry(h.ctx, scope, { contentTypeApiId: 'page', fields: { title: { 'en-US': 'd' } } }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('gives the claim back when the flag is turned off, keeping the entry’s unique values', async () => {
    const first = await createEntry(h.ctx, scope, {
      contentTypeApiId: 'settings',
      fields: { title: { 'en-US': 'Site' }, code: { 'en-US': 'x1' } },
    });
    await updateContentType(h.ctx, scope, 'settings', { singleton: false });
    expect('singleton' in (await getContentType(h.ctx, scope, 'settings'))).toBe(false);
    await settings(h, 'Second');
    expect(await h.store.entries.findUniqueConflicts(scope, [singletonClaim('settings')])).toEqual(
      [],
    );
    // Its `code` claim survived the rebuild.
    const code = { contentTypeApiId: 'settings', fieldApiId: 'code', locale: 'en-US', value: 'x1' };
    expect(
      (await h.store.entries.findUniqueConflicts(scope, [code])).map((c) => c.entryId),
    ).toEqual([first.entry.id]);
  });

  it('serves the published entry from Delivery, by locale and with links included', async () => {
    await pageType(h);
    const home = await createEntry(h.ctx, scope, {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': 'Home' } },
    });
    await publishEntry(h.ctx, scope, home.entry.id);
    const one = await createEntry(h.ctx, scope, {
      contentTypeApiId: 'settings',
      fields: {
        title: { 'en-US': 'Site' },
        home: { 'en-US': { id: home.entry.id, linkType: 'Entry' } },
      },
    });

    // Not published yet: nothing to serve, though Preview has it.
    await expect(getDeliveredSingleton(h.ctx, scope, 'settings')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const draft = await getPreviewSingleton(h.ctx, scope, 'settings', { locale: 'en-US' });
    expect(draft).toMatchObject({ id: one.entry.id, status: 'draft', fields: { title: 'Site' } });

    await publishEntry(h.ctx, scope, one.entry.id);
    const served = await getDeliveredSingleton(h.ctx, scope, 'settings', {
      locale: 'en-US',
      include: 1,
    });
    expect(served.id).toBe(one.entry.id);
    expect(served.fields.title).toBe('Site');
    expect((served.fields.home as { fields: { title: string } }).fields.title).toBe('Home');
    // Without include the link stays a link.
    const shallow = await getDeliveredSingleton(h.ctx, scope, 'settings', { locale: 'en-US' });
    expect(shallow.fields.home).toEqual({ id: home.entry.id, linkType: 'Entry' });
  });

  it('is not found for an ordinary type, an unknown one, or a singleton with no entry', async () => {
    await pageType(h);
    const page = await createEntry(h.ctx, scope, {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': 'p' } },
    });
    await publishEntry(h.ctx, scope, page.entry.id);
    for (const apiId of ['page', 'nope', 'settings']) {
      await expect(getDeliveredSingleton(h.ctx, scope, apiId)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(getPreviewSingleton(h.ctx, scope, apiId)).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it('keeps one entry per environment', async () => {
    await createEnvironment(h.ctx, 'site', 'staging');
    await settingsType(h, staging);
    await settings(h, 'Main');
    await settings(h, 'Staging', staging);
    await expect(settings(h, 'Again', staging)).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses an environment merge that would give the target a second entry', async () => {
    await createEnvironment(h.ctx, 'site', 'staging');
    await settingsType(h, staging);
    const fromStaging = await settings(h, 'Staging', staging);
    await settings(h, 'Main');
    await expect(
      mergeEnvironments(h.ctx, 'site', 'staging', 'main', { entries: [fromStaging.entry.id] }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await h.store.entries.list(scope, { contentTypeApiId: 'settings' })).length).toBe(1);
  });

  it('refuses a merge that turns a target type with several entries into a singleton', async () => {
    await createEnvironment(h.ctx, 'site', 'staging');
    await settingsType(h, staging);
    // Main has the same type as an ordinary one, with two entries.
    await updateContentType(h.ctx, scope, 'settings', { singleton: false });
    await settings(h, 'A');
    await settings(h, 'B');
    await expect(
      mergeEnvironments(h.ctx, 'site', 'staging', 'main', { contentTypes: ['settings'] }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect('singleton' in (await getContentType(h.ctx, scope, 'settings'))).toBe(false);
  });
});
