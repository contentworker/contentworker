import type { FieldDefinition } from '@contentworker/domain';
import { ValidationError } from '@contentworker/domain';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
  StubAIProvider,
} from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createAsset,
  createContentType,
  createEntry,
  createEnvironment,
  draftEntry,
  exportSnapshot,
  getContentType,
  importSnapshot,
  updateEntry,
  validateEntry,
} from '../src/index';

const scope = { spaceId: 's1', environmentId: 'main' };

const field = (apiId: string, over: Partial<FieldDefinition> = {}): FieldDefinition => ({
  apiId,
  name: apiId,
  type: 'Symbol',
  localized: false,
  required: false,
  position: 0,
  ...over,
});

let ctx: AppContext;
let blob: FakeBlobStore;

beforeEach(async () => {
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 's1', defaultLocale: 'en', locales: ['en'] });
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('g') };
  blob = new FakeBlobStore();
});

const issuesOf = async (p: Promise<unknown>): Promise<string[]> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof ValidationError) return err.issues.map((i) => `${i.field}: ${i.message}`);
    throw err;
  }
  return [];
};

describe('asset MIME types on asset links', () => {
  beforeEach(async () => {
    await createContentType(ctx, scope, {
      apiId: 'doc',
      name: 'Document',
      displayField: 'title',
      fields: [
        field('title'),
        field('file', {
          type: 'Link',
          linkType: 'Asset',
          position: 1,
          validations: { assetMimeTypes: ['application/pdf'] },
        }),
        field('images', {
          type: 'Array',
          position: 2,
          items: { type: 'Link', linkType: 'Asset' },
          validations: { assetMimeTypes: ['image/*'], messages: { assetMimeTypes: 'Images only' } },
        }),
      ],
    });
  });

  const asset = async (fileName: string, contentType: string) =>
    (await createAsset(ctx, blob, scope, { fileName, contentType })).asset.id;

  it('takes an asset of an allowed type, exactly or by family', async () => {
    const pdf = await asset('a.pdf', 'application/pdf');
    const png = await asset('a.png', 'image/png');
    const created = await createEntry(ctx, scope, {
      contentTypeApiId: 'doc',
      fields: {
        title: { en: 'Brochure' },
        file: { en: { id: pdf, linkType: 'Asset' } },
        images: { en: [{ id: png, linkType: 'Asset' }] },
      },
    });
    expect(created.entry.id).toBeTruthy();
  });

  it('refuses one of another type on create, update and the dry run, by the asset’s own type', async () => {
    const pdf = await asset('a.pdf', 'application/pdf');
    const png = await asset('a.png', 'image/png');
    const wrong = {
      title: { en: 'Brochure' },
      file: { en: { id: png, linkType: 'Asset' } },
      images: { en: [{ id: pdf, linkType: 'Asset' }] },
    };
    const expected = [
      `file: Asset ${png} is image/png; this field takes application/pdf`,
      'images[0]: Images only',
    ];
    expect(
      await issuesOf(createEntry(ctx, scope, { contentTypeApiId: 'doc', fields: wrong })),
    ).toEqual(expected);
    expect(
      await issuesOf(validateEntry(ctx, scope, { contentTypeApiId: 'doc', fields: wrong })),
    ).toEqual(expected);
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'doc',
      fields: { title: { en: 'Brochure' } },
    });
    expect(await issuesOf(updateEntry(ctx, scope, entry.id, wrong))).toEqual(expected);
  });

  it('leaves a link to a missing asset to the publish gate', async () => {
    const created = await createEntry(ctx, scope, {
      contentTypeApiId: 'doc',
      fields: { title: { en: 'x' }, file: { en: { id: 'nope', linkType: 'Asset' } } },
    });
    expect(created.fields.file).toEqual({ en: { id: 'nope', linkType: 'Asset' } });
  });
});

describe('content type details through the use-cases', () => {
  const details = {
    group: 'Editorial',
    description: 'Long reads.',
    icon: 'newspaper',
    layout: {
      tabs: [{ apiId: 'main', name: 'Main', groups: [{ name: 'Basics', fields: ['title'] }] }],
    },
  };

  it('keeps them on revision, and a clone copies them', async () => {
    await createContentType(ctx, scope, {
      apiId: 'article',
      name: 'Article',
      displayField: 'title',
      fields: [field('title'), field('when', { type: 'Date', format: 'date', position: 1 })],
      ...details,
    });
    // Revised through create (idempotent on apiId) without the details: they stay.
    await createContentType(ctx, scope, {
      apiId: 'article',
      name: 'Articles',
      displayField: 'title',
      fields: [field('title'), field('when', { type: 'Date', format: 'date', position: 1 })],
    });
    expect(await getContentType(ctx, scope, 'article')).toMatchObject({
      name: 'Articles',
      ...details,
    });

    await createEnvironment(ctx, 's1', 'copy');
    const snapshot = await exportSnapshot(ctx, scope);
    await importSnapshot(ctx, { spaceId: 's1', environmentId: 'copy' }, snapshot);
    expect(
      await getContentType(ctx, { spaceId: 's1', environmentId: 'copy' }, 'article'),
    ).toMatchObject({ ...details, fields: [{ apiId: 'title' }, { format: 'date' }] });
  });

  it('tells a model the written form of a Date field', async () => {
    await createContentType(ctx, scope, {
      apiId: 'event',
      name: 'Event',
      displayField: 'title',
      fields: [field('title'), field('day', { type: 'Date', format: 'date', position: 1 })],
    });
    const ai = new StubAIProvider(() => ({ title: 'Launch', day: '2026-11-03' }));
    const draft = await draftEntry(ctx, ai, scope, { contentTypeApiId: 'event', prompt: 'x' });
    expect(draft.fields.day).toEqual({ en: '2026-11-03' });
    const schema = ai.requests[0]?.outputSchema as
      | { properties: Record<string, { description: string }> }
      | undefined;
    expect(schema?.properties.day?.description).toContain('a date, YYYY-MM-DD');
  });
});
