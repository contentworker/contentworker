import { NotFoundError, ValidationError } from '@contentworker/domain';
import type { ImportSource, SourceReadResult } from '@contentworker/ports';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  analyzeImport,
  createContentType,
  createEntry,
  executeImport,
  IMPORT_MAX_RECORDS,
  type ImportInput,
  listPreviewEntries,
  publishContentType,
  trashEntry,
} from '../src/index';

const SPACE = 's1';
const scope = { spaceId: SPACE, environmentId: 'main' };
let ctx: AppContext;

/** A source that hands back exactly what a test wrote, so the pipeline is what is under test. */
function fakeSource(result: Partial<SourceReadResult>): ImportSource {
  return {
    id: 'fake',
    name: 'Fake',
    async read() {
      return { records: [], fields: [], warnings: [], ...result };
    },
  };
}

const rows = (values: Record<string, unknown>[]): ImportSource =>
  fakeSource({
    records: values.map((v, i) => ({ externalId: `x${i + 1}`, values: v })),
    fields: [...new Set(values.flatMap((v) => Object.keys(v)))],
  });

/**
 * The actionable text of a refusal. `ValidationError.message` is the generic
 * "one or more fields are invalid"; the reason lives in `issues`, which is what
 * the API serializes.
 */
const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (err) {
    return err instanceof ValidationError ? (err.issues[0]?.message ?? '') : String(err);
  }
  return '';
};

const input = (over: Partial<ImportInput> = {}): ImportInput => ({
  payload: '',
  mapping: {
    contentTypeApiId: 'article',
    fields: { title: 'name' },
    ...over.mapping,
  },
  ...over,
});

beforeEach(async () => {
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: SPACE, defaultLocale: 'en-US', locales: ['en-US', 'de-DE'] });
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  await createContentType(ctx, scope, {
    apiId: 'article',
    name: 'Article',
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
        apiId: 'views',
        name: 'Views',
        type: 'Integer',
        localized: false,
        required: false,
        position: 1,
      },
      {
        apiId: 'featured',
        name: 'Featured',
        type: 'Boolean',
        localized: false,
        required: false,
        position: 2,
      },
      { apiId: 'sku', name: 'SKU', type: 'Symbol', localized: false, required: false, position: 3 },
      {
        apiId: 'body',
        name: 'Body',
        type: 'RichText',
        localized: false,
        required: false,
        position: 4,
      },
    ],
  } as Parameters<typeof createContentType>[2]);
  await publishContentType(ctx, scope, 'article');
});

describe('analyze writes nothing', () => {
  it('reports what would be created without creating it', async () => {
    const source = rows([{ name: 'One' }, { name: 'Two' }]);
    const analysis = await analyzeImport(ctx, scope, source, input());

    expect(analysis).toMatchObject({ records: 2, willCreate: 2, willUpdate: 0, invalid: 0 });
    expect(await listPreviewEntries(ctx, scope, {})).toHaveLength(0);
  });

  it('names the source fields nothing maps to', async () => {
    const source = rows([{ name: 'One', excerpt: 'lost', author: 'also lost' }]);
    const analysis = await analyzeImport(ctx, scope, source, input());
    // "I lost the excerpt column" is only findable before the run.
    expect(analysis.unmappedSourceFields).toEqual(['excerpt', 'author']);
  });

  it('carries the source’s own warnings through', async () => {
    const source = fakeSource({ records: [], fields: [], warnings: ['Row 4 was unreadable'] });
    expect((await analyzeImport(ctx, scope, source, input())).warnings).toEqual([
      'Row 4 was unreadable',
    ]);
  });
});

describe('a mapping that cannot work', () => {
  it('blocks when a required field has no source', async () => {
    const source = rows([{ name: 'One' }]);
    const analysis = await analyzeImport(
      ctx,
      scope,
      source,
      input({ mapping: { contentTypeApiId: 'article', fields: { views: 'name' } } }),
    );
    expect(analysis.missingRequiredFields).toEqual(['title']);
    expect(analysis.executable).toBe(false);
  });

  it('blocks when a target field does not exist', async () => {
    const analysis = await analyzeImport(
      ctx,
      scope,
      rows([{ name: 'One' }]),
      input({ mapping: { contentTypeApiId: 'article', fields: { title: 'name', nope: 'name' } } }),
    );
    expect(analysis.unknownTargetFields).toEqual(['nope']);
    expect(analysis.executable).toBe(false);
  });

  it('refuses to execute a blocked mapping rather than importing half of it', async () => {
    await expect(
      executeImport(
        ctx,
        scope,
        rows([{ name: 'One' }]),
        input({ mapping: { contentTypeApiId: 'article', fields: { views: 'name' } } }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('404s on a content type that is not there', async () => {
    await expect(
      analyzeImport(
        ctx,
        scope,
        rows([]),
        input({ mapping: { contentTypeApiId: 'ghost', fields: {} } }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a locale the space does not have', async () => {
    expect(
      await refusal(
        analyzeImport(
          ctx,
          scope,
          rows([]),
          input({ mapping: { contentTypeApiId: 'article', fields: {}, locale: 'fr-FR' } }),
        ),
      ),
    ).toMatch(/fr-FR/);
  });
});

describe('a record that cannot be written', () => {
  it('is reported, not thrown', async () => {
    const source = rows([{ name: 'Fine' }, { other: 'no title' }]);
    const analysis = await analyzeImport(ctx, scope, source, input());
    expect(analysis.invalid).toBe(1);
    expect(analysis.issues[0]?.messages[0]).toMatch(/title.*required/i);
    // One bad row does not block the good ones.
    expect(analysis.executable).toBe(true);
    expect(analysis.willCreate).toBe(1);
  });

  it('is skipped by execute, leaving the rest imported', async () => {
    const result = await executeImport(ctx, scope, rows([{ name: 'Fine' }, {}]), input());
    expect(result).toMatchObject({ created: 1, skipped: 1 });
    expect(await listPreviewEntries(ctx, scope, {})).toHaveLength(1);
  });

  it('catches a repeated identity in the payload itself', async () => {
    const source = fakeSource({
      records: [
        { externalId: 'same', values: { name: 'One' } },
        { externalId: 'same', values: { name: 'Two' } },
      ],
      fields: ['name'],
    });
    // Otherwise the same thing imports twice and the run looks like it worked.
    const analysis = await analyzeImport(ctx, scope, source, input());
    expect(analysis.issues[0]?.messages[0]).toMatch(/duplicate identity/i);
  });
});

describe('coercing what a spreadsheet gives you', () => {
  const mapping = {
    contentTypeApiId: 'article',
    fields: { title: 'name', views: 'hits', featured: 'star' },
  };

  it('turns a numeric string into a number', async () => {
    const result = await executeImport(
      ctx,
      scope,
      rows([{ name: 'One', hits: '42' }]),
      input({ mapping }),
    );
    expect(result.created).toBe(1);
    const [entry] = await listPreviewEntries(ctx, scope, {});
    expect(entry?.fields.views?.['en-US']).toBe(42);
  });

  it('reads the ways a sheet spells true', async () => {
    await executeImport(
      ctx,
      scope,
      rows([
        { name: 'One', star: 'yes' },
        { name: 'Two', star: 'FALSE' },
      ]),
      input({ mapping }),
    );
    const entries = await listPreviewEntries(ctx, scope, {});
    const byTitle = new Map(entries.map((e) => [e.fields.title?.['en-US'], e.fields.featured]));
    expect(byTitle.get('One')?.['en-US']).toBe(true);
    expect(byTitle.get('Two')?.['en-US']).toBe(false);
  });

  it('reads text for a rich-text field as HTML', async () => {
    // What a blog export holds; plain prose in a cell is the same thing with no tags.
    const result = await executeImport(
      ctx,
      scope,
      rows([{ name: 'One', html: '<p>Hello <strong>there</strong></p>' }]),
      input({ mapping: { contentTypeApiId: 'article', fields: { title: 'name', body: 'html' } } }),
    );
    expect(result).toMatchObject({ created: 1, failed: [] });
    const [entry] = await listPreviewEntries(ctx, scope, {});
    expect(entry?.fields.body?.['en-US']).toEqual({
      nodeType: 'document',
      data: {},
      content: [
        {
          nodeType: 'paragraph',
          data: {},
          content: [
            { nodeType: 'text', value: 'Hello ', marks: [], data: {} },
            { nodeType: 'text', value: 'there', marks: [{ type: 'bold' }], data: {} },
          ],
        },
      ],
    });
  });

  it('treats markup with no text in it as no value', async () => {
    // An empty editor block is not content; storing it would satisfy a
    // required rich-text field with a blank document.
    const result = await executeImport(
      ctx,
      scope,
      rows([{ name: 'One', html: '<!-- wp:paragraph --><p></p><!-- /wp:paragraph -->' }]),
      input({ mapping: { contentTypeApiId: 'article', fields: { title: 'name', body: 'html' } } }),
    );
    expect(result.created).toBe(1);
    const [entry] = await listPreviewEntries(ctx, scope, {});
    expect(entry?.fields.body).toBeUndefined();
  });

  it('reports a rich-text value that is neither text nor a document', async () => {
    const analysis = await analyzeImport(
      ctx,
      scope,
      rows([{ name: 'One', body: 42 }]),
      input({ mapping: { contentTypeApiId: 'article', fields: { title: 'name', body: 'body' } } }),
    );
    expect(analysis.invalid).toBe(1);
    expect(analysis.issues[0]?.messages[0]).toMatch(/body/);
  });

  it('leaves a value that is already a rich-text document alone', async () => {
    const doc = { nodeType: 'document', data: {}, content: [] };
    await executeImport(
      ctx,
      scope,
      rows([{ name: 'One', body: doc }]),
      input({ mapping: { contentTypeApiId: 'article', fields: { title: 'name', body: 'body' } } }),
    );
    const [entry] = await listPreviewEntries(ctx, scope, {});
    expect(entry?.fields.body?.['en-US']).toEqual(doc);
  });

  it('reports a value it cannot convert instead of quietly emptying the field', async () => {
    const analysis = await analyzeImport(
      ctx,
      scope,
      rows([{ name: 'One', hits: 'lots' }]),
      input({ mapping }),
    );
    expect(analysis.invalid).toBe(1);
    expect(analysis.issues[0]?.messages[0]).toMatch(/views/);
  });

  it('leaves an empty cell as no value rather than an empty string', async () => {
    await executeImport(ctx, scope, rows([{ name: 'One', hits: '' }]), input({ mapping }));
    const [entry] = await listPreviewEntries(ctx, scope, {});
    expect(entry?.fields.views).toBeUndefined();
  });
});

describe('running the same import twice', () => {
  const mapping = {
    contentTypeApiId: 'article',
    fields: { title: 'name', sku: 'code' },
    identityField: 'sku',
  };
  const payload = rows([{ name: 'One', code: 'A-1' }]);

  it('duplicates everything when nothing identifies a record', async () => {
    // Stated by the analysis rather than left to be discovered on run two.
    await executeImport(ctx, scope, rows([{ name: 'One' }]), input());
    await executeImport(ctx, scope, rows([{ name: 'One' }]), input());
    expect(await listPreviewEntries(ctx, scope, {})).toHaveLength(2);
  });

  it('recognises what it already imported and leaves it alone by default', async () => {
    await executeImport(ctx, scope, payload, input({ mapping }));
    const second = await executeImport(ctx, scope, payload, input({ mapping }));

    expect(second).toMatchObject({ created: 0, skipped: 1 });
    expect(await listPreviewEntries(ctx, scope, {})).toHaveLength(1);
  });

  it('updates the matched entry when asked to', async () => {
    await executeImport(ctx, scope, payload, input({ mapping }));
    const changed = rows([{ name: 'Renamed', code: 'A-1' }]);
    const second = await executeImport(ctx, scope, changed, input({ mapping }), {
      conflicts: 'update',
    });

    expect(second).toMatchObject({ created: 0, updated: 1 });
    const [entry] = await listPreviewEntries(ctx, scope, {});
    expect(entry?.fields.title?.['en-US']).toBe('Renamed');
  });

  it('refuses the conflicting record when told to fail', async () => {
    await executeImport(ctx, scope, payload, input({ mapping }));
    const second = await executeImport(ctx, scope, payload, input({ mapping }), {
      conflicts: 'fail',
    });
    expect(second.analysis.issues[0]?.messages[0]).toMatch(/already exists/i);
    expect(second.skipped).toBe(1);
  });

  it('does not match against something that was trashed', async () => {
    await executeImport(ctx, scope, payload, input({ mapping }));
    const [entry] = await listPreviewEntries(ctx, scope, {});
    await trashEntry(ctx, scope, entry?.id ?? '');

    const second = await executeImport(ctx, scope, payload, input({ mapping }));
    // Matching trash would silently revive what someone deleted.
    expect(second.created).toBe(1);
  });
});

describe('the analysis and the run cannot disagree', () => {
  it('reports the same counts it then produces', async () => {
    const source = rows([{ name: 'One' }, { name: 'Two' }, {}]);
    const analysis = await analyzeImport(ctx, scope, source, input());
    const result = await executeImport(ctx, scope, source, input());

    expect(result.created).toBe(analysis.willCreate);
    expect(result.skipped).toBe(analysis.willSkip);
  });

  it('re-analyzes rather than acting on what it was told earlier', async () => {
    const mapping = {
      contentTypeApiId: 'article',
      fields: { title: 'name', sku: 'code' },
      identityField: 'sku',
    };
    const source = rows([{ name: 'One', code: 'A-1' }]);
    // Analysis says "create"...
    expect((await analyzeImport(ctx, scope, source, input({ mapping }))).willCreate).toBe(1);
    // ...then the entry appears from somewhere else.
    await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Arrived' }, sku: { 'en-US': 'A-1' } },
    });
    const result = await executeImport(ctx, scope, source, input({ mapping }));
    // Acting on the stale plan would have created a duplicate.
    expect(result.created).toBe(0);
  });
});

describe('bounds', () => {
  it('refuses to write more than the synchronous path can hold', async () => {
    const many = Array.from({ length: IMPORT_MAX_RECORDS + 1 }, (_, i) => ({ name: `n${i}` }));
    expect(await refusal(executeImport(ctx, scope, rows(many), input()))).toMatch(
      /split the file/i,
    );
  });

  it('still describes a file too big to write in one request', async () => {
    // Analysis writes nothing, so its bound is memory, not time. Refusing to
    // describe a file the durable path would import would leave an operator
    // unable to find out how big their problem is.
    const many = Array.from({ length: IMPORT_MAX_RECORDS + 1 }, (_, i) => ({ name: `n${i}` }));
    const analysis = await analyzeImport(ctx, scope, rows(many), input());
    expect(analysis.records).toBe(IMPORT_MAX_RECORDS + 1);
  });

  it('lists only a bounded sample of per-record problems', async () => {
    const broken = Array.from({ length: 150 }, () => ({ other: 'no title' }));
    const analysis = await analyzeImport(ctx, scope, rows(broken), input());
    expect(analysis.invalid).toBe(150);
    expect(analysis.issues.length).toBeLessThanOrEqual(100);
  });
});
