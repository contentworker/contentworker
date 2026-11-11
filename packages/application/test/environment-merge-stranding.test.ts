import { ConflictError, NotFoundError, ValidationError } from '@contentworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  getContentType,
  getEntry,
  mergeEnvironments,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  trashEntry,
  updateContentType,
} from '../src/index';

const main = { spaceId: 'shop', environmentId: 'main' };
const staging = { spaceId: 'shop', environmentId: 'staging' };

const symbol = (apiId: string, position: number, extra: Record<string, unknown> = {}) => ({
  apiId,
  name: apiId,
  type: 'Symbol',
  localized: false,
  required: false,
  position,
  ...extra,
});
const hero = { apiId: 'hero', name: 'Hero', fields: [symbol('heading', 0)] };
const cta = { apiId: 'cta', name: 'CTA', fields: [symbol('label', 0)] };

/** A page whose `body` takes `variants`, with a unique `slug` and, optionally, a `kicker`. */
const page = (variants: readonly unknown[], kicker = true) =>
  ({
    apiId: 'page',
    name: 'Page',
    displayField: 'title',
    fields: [
      { ...symbol('title', 0), required: true },
      symbol('slug', 1, { unique: true }),
      ...(kicker ? [symbol('kicker', 2)] : []),
      { ...symbol('body', 3), type: 'Array', items: { type: 'Component', variants } },
    ],
  }) as Parameters<typeof createContentType>[3];

const fields = (
  title: string,
  blocks: readonly string[] = [],
  extra: Record<string, string> = {},
) => ({
  title: { 'en-US': title },
  slug: { 'en-US': title.toLowerCase() },
  body: {
    'en-US': blocks.map((t) =>
      t === 'cta' ? { _type: t, label: 'Secret launch copy' } : { _type: t, heading: 'Hi' },
    ),
  },
  ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, { 'en-US': v }])),
});

describe('a merge that would strand the target’s entries', () => {
  let ctx: AppContext;
  beforeEach(async () => {
    const store = new InMemoryContentStore();
    store.seedSpace({ spaceId: 'shop', defaultLocale: 'en-US', locales: ['en-US'] });
    ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
    // Staging dropped the CTA block; main still has it.
    await createContentType(ctx, SYSTEM_CALLER, staging, page([hero]));
    await createContentType(ctx, SYSTEM_CALLER, main, page([hero, cta]));
    await publishContentType(ctx, staging, 'page');
    await publishContentType(ctx, main, 'page');
  });

  /** The same entry in both environments: main's holding `inMain`, staging's `inStaging`. */
  const both = async (id: string, inMain: readonly string[], inStaging: readonly string[]) => {
    await createEntry(ctx, main, { id, contentTypeApiId: 'page', fields: fields(id, inMain) });
    await createEntry(ctx, staging, {
      id,
      contentTypeApiId: 'page',
      fields: fields(id, inStaging),
    });
  };
  const variantsInMain = async () =>
    (await getContentType(ctx, main, 'page')).fields
      .find((f) => f.apiId === 'body')
      ?.items?.variants?.map((v) => v.apiId);

  it('refuses, naming the type, the variant and the entries, never their content, and writes nothing', async () => {
    await createEntry(ctx, main, {
      id: 'held-1',
      contentTypeApiId: 'page',
      fields: fields('One', ['cta']),
    });
    await createEntry(ctx, main, {
      id: 'held-2',
      contentTypeApiId: 'page',
      fields: fields('Two', ['hero', 'cta']),
    });
    await createEntry(ctx, staging, {
      id: 'fresh',
      contentTypeApiId: 'page',
      fields: fields('Fresh', ['hero']),
    });

    const refused = mergeEnvironments(ctx, SYSTEM_CALLER, 'shop', 'staging', 'main', {
      contentTypes: ['page'],
      entries: ['fresh'],
    });
    await expect(refused).rejects.toBeInstanceOf(ValidationError);
    const err = (await refused.catch((e: unknown) => e)) as ValidationError;
    expect(err.issues).toEqual([
      {
        field: 'contentTypes',
        message:
          'The content type "page" can\'t go to main: it removes a block variant 2 entries there still use: body: cta (entries held-1, held-2). Change or clear those values there first, or leave "page" out of the merge',
      },
    ]);
    expect(JSON.stringify(err.issues)).not.toContain('Secret launch copy');
    expect(await variantsInMain()).toEqual(['hero', 'cta']);
    await expect(getEntry(ctx, main, 'fresh')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a removed field an entry still holds, as revising the type there would', async () => {
    await createContentType(ctx, SYSTEM_CALLER, staging, {
      ...page([hero, cta], false),
      apiId: 'note',
    });
    await createContentType(ctx, SYSTEM_CALLER, main, { ...page([hero, cta]), apiId: 'note' });
    await createEntry(ctx, main, {
      id: 'kicked',
      contentTypeApiId: 'note',
      fields: fields('Kicked', [], { kicker: 'Breaking' }),
    });
    await expect(
      mergeEnvironments(ctx, SYSTEM_CALLER, 'shop', 'staging', 'main', { contentTypes: ['note'] }),
    ).rejects.toMatchObject({
      issues: [
        {
          field: 'contentTypes',
          message:
            'The content type "note" can\'t go to main: it removes a field 1 entry there still holds a value for: kicker (entry kicked). Change or clear those values there first, or leave "note" out of the merge',
        },
      ],
    });
    // The direct revision refuses the same entry.
    await expect(
      updateContentType(ctx, SYSTEM_CALLER, main, 'note', {
        fields: page([hero, cta], false).fields,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('lets it go when only merged entries hold it, writing them over the copies first', async () => {
    await both('mine', ['cta'], ['hero']);
    const result = await mergeEnvironments(ctx, SYSTEM_CALLER, 'shop', 'staging', 'main', {
      contentTypes: ['page'],
      entries: ['mine'],
    });
    expect(result).toEqual({ mergedContentTypes: ['page'], mergedEntries: ['mine'] });
    expect(await variantsInMain()).toEqual(['hero']);
    const merged = await getEntry(ctx, main, 'mine');
    expect(merged.fields.body).toMatchObject({ 'en-US': [{ _type: 'hero', heading: 'Hi' }] });
  });

  it('counts the published snapshot of a merged entry, which a merge never replaces', async () => {
    await both('live', ['cta'], ['hero']);
    await publishEntry(ctx, main, 'live');
    await expect(
      mergeEnvironments(ctx, SYSTEM_CALLER, 'shop', 'staging', 'main', {
        contentTypes: ['page'],
        entries: ['live'],
      }),
    ).rejects.toMatchObject({
      issues: [
        {
          field: 'contentTypes',
          message: expect.stringContaining('1 entry there still uses: body: cta (entry live)'),
        },
      ],
    });
    expect(await variantsInMain()).toEqual(['hero', 'cta']);
  });

  it('still counts an entry the merge leaves alone beside one it lets off', async () => {
    await both('mine', ['cta'], ['hero']);
    await createEntry(ctx, main, {
      id: 'other',
      contentTypeApiId: 'page',
      fields: fields('Other', ['cta']),
    });
    await expect(
      mergeEnvironments(ctx, SYSTEM_CALLER, 'shop', 'staging', 'main', {
        contentTypes: ['page'],
        entries: ['mine'],
      }),
    ).rejects.toMatchObject({
      issues: [
        { field: 'contentTypes', message: expect.stringContaining('body: cta (entry other)') },
      ],
    });
    // Nothing written: the merged entry's copy is as it was.
    expect((await getEntry(ctx, main, 'mine')).entry.currentVersion).toBe(1);
  });

  it('counts an entry in the target’s trash, and lets off a merged one there, which it writes over', async () => {
    await createEntry(ctx, main, {
      id: 'binned',
      contentTypeApiId: 'page',
      fields: fields('Binned', ['cta']),
    });
    await trashEntry(ctx, main, 'binned');
    await expect(
      mergeEnvironments(ctx, SYSTEM_CALLER, 'shop', 'staging', 'main', { contentTypes: ['page'] }),
    ).rejects.toMatchObject({
      issues: [
        { field: 'contentTypes', message: expect.stringContaining('body: cta (entry binned)') },
      ],
    });

    // Merged, its copy in the trash takes the source's version (and stays there).
    await createEntry(ctx, staging, {
      id: 'binned',
      contentTypeApiId: 'page',
      fields: fields('Binned', ['hero']),
    });
    await mergeEnvironments(ctx, SYSTEM_CALLER, 'shop', 'staging', 'main', {
      contentTypes: ['page'],
      entries: ['binned'],
    });
    const after = await ctx.store.entries.get(main, 'binned');
    expect(after?.entry.status).toBe('archived');
    expect(after?.fields.body).toMatchObject({ 'en-US': [{ _type: 'hero', heading: 'Hi' }] });
    expect(await variantsInMain()).toEqual(['hero']);
  });

  it('writes an entry giving a unique value up before the one taking it, let off or not', async () => {
    // In staging, B gave "x" up and A, whose copy in main holds the CTA block, took it.
    await createEntry(ctx, main, {
      id: 'a',
      contentTypeApiId: 'page',
      fields: fields('A', ['cta'], { slug: 'a' }),
    });
    await createEntry(ctx, main, {
      id: 'b',
      contentTypeApiId: 'page',
      fields: fields('B', [], { slug: 'x' }),
    });
    await createEntry(ctx, staging, {
      id: 'a',
      contentTypeApiId: 'page',
      fields: fields('A', ['hero'], { slug: 'x' }),
    });
    await createEntry(ctx, staging, {
      id: 'b',
      contentTypeApiId: 'page',
      fields: fields('B', [], { slug: 'y' }),
    });
    await mergeEnvironments(ctx, SYSTEM_CALLER, 'shop', 'staging', 'main', {
      contentTypes: ['page'],
      entries: ['b', 'a'],
    });
    expect((await getEntry(ctx, main, 'a')).fields.slug).toEqual({ 'en-US': 'x' });
    expect((await getEntry(ctx, main, 'b')).fields.slug).toEqual({ 'en-US': 'y' });
    expect(await variantsInMain()).toEqual(['hero']);
  });

  it('refuses values handed round in a circle before saving any type', async () => {
    await createContentType(ctx, SYSTEM_CALLER, staging, { ...page([hero], false), apiId: 'note' });
    await createContentType(ctx, SYSTEM_CALLER, main, { ...page([hero]), apiId: 'note' });
    for (const [env, a, b] of [
      [main, 'p', 'q'],
      [staging, 'q', 'p'],
    ] as const) {
      await createEntry(ctx, env, {
        id: 'ca',
        contentTypeApiId: 'page',
        fields: fields('A', [], { slug: a }),
      });
      await createEntry(ctx, env, {
        id: 'cb',
        contentTypeApiId: 'page',
        fields: fields('B', [], { slug: b }),
      });
    }
    const refused = mergeEnvironments(ctx, SYSTEM_CALLER, 'shop', 'staging', 'main', {
      contentTypes: ['note'],
      entries: ['ca', 'cb'],
    });
    await expect(refused).rejects.toBeInstanceOf(ConflictError);
    await expect(refused).rejects.toThrow(
      /in a circle between entries the target already has \(ca, cb\)/,
    );
    expect((await getContentType(ctx, main, 'note')).fields.some((f) => f.apiId === 'kicker')).toBe(
      true,
    );
    expect((await getEntry(ctx, main, 'ca')).entry.currentVersion).toBe(1);
  });

  it('merges a type or an entry named twice once', async () => {
    await both('twice', ['cta'], ['hero']);
    await expect(
      mergeEnvironments(ctx, SYSTEM_CALLER, 'shop', 'staging', 'main', {
        contentTypes: ['page', 'page'],
        entries: ['twice', 'twice'],
      }),
    ).resolves.toEqual({ mergedContentTypes: ['page'], mergedEntries: ['twice'] });
    expect(await variantsInMain()).toEqual(['hero']);
    expect((await getEntry(ctx, main, 'twice')).entry.currentVersion).toBe(2);
  });

  it('judges what the target serves too, when a published type replaces it', async () => {
    // Main's working draft already dropped CTA; what it serves (and the live entry) still has it.
    await createEntry(ctx, main, {
      id: 'served',
      contentTypeApiId: 'page',
      fields: fields('Served', ['cta']),
    });
    await publishEntry(ctx, main, 'served');
    await ctx.store.contentTypes.save(main, {
      ...(await getContentType(ctx, main, 'page')),
      fields: page([hero]).fields,
      status: 'draft',
    });
    await expect(
      mergeEnvironments(ctx, SYSTEM_CALLER, 'shop', 'staging', 'main', { contentTypes: ['page'] }),
    ).rejects.toMatchObject({
      issues: [
        { field: 'contentTypes', message: expect.stringContaining('body: cta (entry served)') },
      ],
    });
  });
});

describe('a merge that fails on an entry', () => {
  let ctx: AppContext;
  beforeEach(async () => {
    const store = new InMemoryContentStore();
    store.seedSpace({ spaceId: 'shop', defaultLocale: 'en-US', locales: ['en-US'] });
    ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
    // Staging's page drops main's `kicker` (and the CTA block), which none of main's entries hold.
    await createContentType(ctx, SYSTEM_CALLER, staging, page([hero], false));
    await createContentType(ctx, SYSTEM_CALLER, main, page([hero, cta]));
  });

  const unchanged = async () =>
    expect(
      (await getContentType(ctx, main, 'page')).fields.find((f) => f.apiId === 'kicker'),
    ).toBeDefined();

  it('saves no type when a selected entry is missing from the source', async () => {
    await expect(
      mergeEnvironments(ctx, SYSTEM_CALLER, 'shop', 'staging', 'main', {
        contentTypes: ['page'],
        entries: ['ghost'],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await unchanged();
  });

  it('saves no type when an entry’s type is in neither the target nor the merge', async () => {
    await createContentType(ctx, SYSTEM_CALLER, staging, { ...page([hero]), apiId: 'post' });
    await createEntry(ctx, staging, { id: 'p1', contentTypeApiId: 'post', fields: fields('P1') });
    await expect(
      mergeEnvironments(ctx, SYSTEM_CALLER, 'shop', 'staging', 'main', {
        contentTypes: ['page'],
        entries: ['p1'],
      }),
    ).rejects.toThrow(/include it in the merge/);
    await unchanged();
  });

  it('saves no type when an entry would take a unique value the target holds', async () => {
    await createEntry(ctx, main, { id: 'taken', contentTypeApiId: 'page', fields: fields('Home') });
    await createEntry(ctx, staging, {
      id: 'taker',
      contentTypeApiId: 'page',
      fields: fields('Home'),
    });
    await expect(
      mergeEnvironments(ctx, SYSTEM_CALLER, 'shop', 'staging', 'main', {
        contentTypes: ['page'],
        entries: ['taker'],
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    await unchanged();
  });

  it('saves no type when another type’s singleton turn is refused', async () => {
    await createContentType(ctx, SYSTEM_CALLER, main, { ...page([hero]), apiId: 'solo' });
    await createContentType(ctx, SYSTEM_CALLER, staging, {
      ...page([hero]),
      apiId: 'solo',
      singleton: true,
    } as Parameters<typeof createContentType>[3]);
    await createEntry(ctx, main, { id: 's1', contentTypeApiId: 'solo', fields: fields('One') });
    await createEntry(ctx, main, { id: 's2', contentTypeApiId: 'solo', fields: fields('Two') });
    await expect(
      mergeEnvironments(ctx, SYSTEM_CALLER, 'shop', 'staging', 'main', {
        contentTypes: ['page', 'solo'],
      }),
    ).rejects.toThrow(/cannot be a singleton/);
    await unchanged();
    expect((await getContentType(ctx, main, 'solo')).singleton).not.toBe(true);
  });

  it('validates a new entry against the type as the merge leaves it', async () => {
    // Staging's page has a field main's lacks; the entry using it merges with the type.
    await createContentType(ctx, SYSTEM_CALLER, staging, { ...page([hero]), apiId: 'promo' });
    await createContentType(ctx, SYSTEM_CALLER, main, { ...page([hero], false), apiId: 'promo' });
    await createEntry(ctx, staging, {
      id: 'k1',
      contentTypeApiId: 'promo',
      fields: fields('K1', [], { kicker: 'New' }),
    });
    await mergeEnvironments(ctx, SYSTEM_CALLER, 'shop', 'staging', 'main', {
      contentTypes: ['promo'],
      entries: ['k1'],
    });
    expect((await getEntry(ctx, main, 'k1')).fields.kicker).toEqual({ 'en-US': 'New' });
  });
});
