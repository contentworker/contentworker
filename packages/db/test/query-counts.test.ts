import {
  type AppContext,
  createAsset,
  createConcept,
  createContentType,
  createEntry,
  createRedirect,
  createScheme,
  createSpace,
  createTag,
  deliveryGraphResolvers,
  deliveryReads,
  getDeliveredAsset,
  getDeliveredTag,
  getEntry,
  getPublishedEntry,
  listDeliveredAssets,
  listDeliveredConcepts,
  listDeliveredRedirects,
  listDeliveredRoutes,
  listDeliveredTags,
  listPreviewEntries,
  listPreviewEntryPage,
  listPublishedEntries,
  publishAsset,
  publishContentType,
  publishEntry,
  resolveDeliveredRedirect,
  setEntryMetadata,
} from '@contentworker/application';
import { type FieldDefinition, type Principal, SCOPES } from '@contentworker/domain';
import { buildDeliverySchema, type DeliveryContext } from '@contentworker/graphql-gen';
import { FakeBlobStore, FixedClock } from '@contentworker/test-kit';
import { execute, parse } from 'graphql';
import { beforeAll, describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';
import { type CountingD1, countingD1, type QueryCount, type QueryLog } from './query-counter';
import committed from './query-counts.json';

/**
 * D1 statements and round trips per representative request, against the committed snapshot
 * (query-counts.json). Each request runs the same use-case its HTTP route and MCP tool call, over
 * the real D1 store, with no delivery cache: the counts are a cache miss, what a request costs
 * the first time. They are deterministic: they depend on the code path and the fixture's shape,
 * never on timing.
 *
 * Any change fails until the snapshot is rewritten
 * (`pnpm --filter @contentworker/db test:query-counts:update`). Delivery reads may only go down;
 * a PR that raises one says why (AGENTS.md, "D1 limits").
 */

const SNAPSHOT = './query-counts.json';
const UPDATE = 'pnpm --filter @contentworker/db test:query-counts:update';

const run = crypto.randomUUID();
const scope = { spaceId: `qc-${run}`, environmentId: 'main' };
/** A Delivery key with no content grants: it reads every type, unmasked. */
const reader: Principal = { spaceId: scope.spaceId, kind: 'cda', scopes: [SCOPES.deliveryRead] };

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;
const entryLink = (id: string) => ({ id, linkType: 'Entry' as const });
const assetLink = (id: string) => ({ id, linkType: 'Asset' as const });
const text = (value: string) => ({ nodeType: 'text', value, marks: [] });

/** Past D1's 100-parameter cap, so a batched link read has to split. */
const MANY_LINKS = 120;

let counter: CountingD1;
let ctx: AppContext;
/** A second page's cursor into the article list, read before the counts are taken. */
let entryCursor = '';
const blob = new FakeBlobStore();
const ids = {
  heroAsset: '',
  authors: [] as string[],
  articles: [] as string[],
  roundup: '',
  landing: '',
  /** Left a draft, so the publish request has one to publish. */
  draft: '',
  tag: '',
  concept: '',
};

/** One model with every kind of link Delivery resolves: Link, Array of Link, rich text. */
async function seed(): Promise<void> {
  await createSpace(ctx, {
    spaceId: scope.spaceId,
    name: 'Query counts',
    defaultLocale: 'en-US',
    locales: ['en-US', 'de'],
  });
  await createContentType(ctx, scope, {
    apiId: 'author',
    name: 'Author',
    displayField: 'name',
    fields: [
      field({ apiId: 'name', type: 'Symbol', required: true }),
      field({ apiId: 'avatar', type: 'Link', linkType: 'Asset', position: 1 }),
    ],
  });
  await createContentType(ctx, scope, {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [
      field({ apiId: 'title', type: 'Symbol', localized: true, required: true }),
      field({ apiId: 'tag', type: 'Symbol', position: 1 }),
      field({ apiId: 'views', type: 'Integer', position: 2 }),
      field({ apiId: 'author', type: 'Link', linkType: 'Entry', position: 3 }),
      field({ apiId: 'hero', type: 'Link', linkType: 'Asset', position: 4 }),
      field({
        apiId: 'related',
        type: 'Array',
        position: 5,
        items: { type: 'Link', linkType: 'Entry' },
      }),
      field({ apiId: 'body', type: 'RichText', position: 6 }),
    ],
  });
  await createContentType(ctx, scope, {
    apiId: 'roundup',
    name: 'Roundup',
    displayField: 'title',
    fields: [
      field({ apiId: 'title', type: 'Symbol', required: true }),
      field({
        apiId: 'people',
        type: 'Array',
        position: 1,
        items: { type: 'Link', linkType: 'Entry' },
      }),
    ],
  });
  // A blocks field: links inside blocks resolve like any other.
  await createContentType(ctx, scope, {
    apiId: 'landing',
    name: 'Landing',
    displayField: 'title',
    fields: [
      field({ apiId: 'title', type: 'Symbol', required: true }),
      field({
        apiId: 'body',
        type: 'Array',
        position: 1,
        items: {
          type: 'Component',
          variants: [
            {
              apiId: 'hero',
              name: 'Hero',
              fields: [
                field({ apiId: 'heading', type: 'Symbol' }),
                field({ apiId: 'image', type: 'Link', linkType: 'Asset', position: 1 }),
              ],
            },
            {
              apiId: 'cta',
              name: 'Call to action',
              fields: [
                field({ apiId: 'label', type: 'Symbol' }),
                field({ apiId: 'target', type: 'Link', linkType: 'Entry', position: 1 }),
              ],
            },
          ],
        },
      }),
    ],
  });
  for (const apiId of ['author', 'article', 'roundup', 'landing']) {
    await publishContentType(ctx, scope, apiId);
  }

  const { asset } = await createAsset(ctx, blob, scope, {
    fileName: 'hero.jpg',
    contentType: 'image/jpeg',
    title: { 'en-US': 'Hero', de: 'Held' },
  });
  await publishAsset(ctx, scope, asset.id);
  ids.heroAsset = asset.id;

  for (let i = 0; i < MANY_LINKS; i++) {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'author',
      fields: {
        name: { 'en-US': `Author ${i}` },
        ...(i < 3 ? { avatar: { 'en-US': assetLink(asset.id) } } : {}),
      },
    });
    await publishEntry(ctx, scope, entry.id);
    ids.authors.push(entry.id);
  }

  // A tag and a concept on every other article, so the taxonomy reads have counts to sum.
  ids.tag = (await createTag(ctx, scope, { name: 'Red', labels: { de: 'Rot' } })).id;
  const scheme = await createScheme(ctx, scope, { name: 'Topics' });
  ids.concept = (await createConcept(ctx, scope, { schemeId: scheme.id, prefLabel: 'Guides' })).id;

  // Each article links an author, the hero, the two articles before it, and embeds its author
  // in the body: include=2 walks article → article → author.
  for (let i = 0; i < 12; i++) {
    const author = ids.authors[i % 3] as string;
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: {
        title: { 'en-US': `Article ${i} guide`, de: `Artikel ${i}` },
        tag: { 'en-US': i % 2 === 0 ? 'red' : 'blue' },
        views: { 'en-US': i * 10 },
        author: { 'en-US': entryLink(author) },
        hero: { 'en-US': assetLink(asset.id) },
        related: { 'en-US': ids.articles.slice(-2).map(entryLink) },
        body: {
          'en-US': {
            nodeType: 'document',
            content: [
              { nodeType: 'paragraph', content: [text(`Body ${i}`)] },
              {
                nodeType: 'embedded-entry-block',
                data: { target: entryLink(author) },
                content: [],
              },
            ],
          },
        },
      },
    });
    if (i % 2 === 0) {
      await setEntryMetadata(ctx, scope, entry.id, { tags: [ids.tag], concepts: [ids.concept] });
    }
    await publishEntry(ctx, scope, entry.id);
    ids.articles.push(entry.id);
  }

  const { entry: roundup } = await createEntry(ctx, scope, {
    contentTypeApiId: 'roundup',
    fields: {
      title: { 'en-US': 'Everyone' },
      people: { 'en-US': ids.authors.map(entryLink) },
    },
  });
  await publishEntry(ctx, scope, roundup.id);
  ids.roundup = roundup.id;

  const { entry: landing } = await createEntry(ctx, scope, landingFields());
  await publishEntry(ctx, scope, landing.id);
  ids.landing = landing.id;
}

/** A landing page of three blocks, linking an asset and two entries from inside them. */
function landingFields() {
  return {
    contentTypeApiId: 'landing',
    fields: {
      title: { 'en-US': 'Launch' },
      body: {
        'en-US': [
          { _type: 'hero', heading: 'Launch', image: assetLink(ids.heroAsset) },
          { _type: 'cta', label: 'Read', target: entryLink(ids.articles[0] as string) },
          { _type: 'cta', label: 'Meet', target: entryLink(ids.authors[0] as string) },
        ],
      },
    },
  };
}

/**
 * The GraphQL Delivery request as `packages/http/src/api/routes/delivery.ts` serves it to a key
 * with no content grants: one request's reads build the schema (the visible content types, with
 * the space config alongside), and the route's own resolvers (`deliveryGraphResolvers`) run on
 * the same reads.
 */
async function graphql(source: string): Promise<void> {
  const reads = deliveryReads(ctx);
  const { contentTypes = [] } = await reads.read(scope, { contentTypes: true, config: true });
  const schema = buildDeliverySchema(contentTypes);
  const result = await execute({
    schema,
    document: parse(source),
    contextValue: {
      resolvers: deliveryGraphResolvers(ctx, scope, reader, { rag: undefined, reads }),
    } satisfies DeliveryContext,
  });
  if (result.errors?.length) throw new Error(result.errors.map((e) => e.message).join('; '));
}

const article = (i: number) => ids.articles[i] as string;

/** The requests measured, in snapshot order. Reads come first: the writes add rows. */
const REQUESTS: readonly (readonly [string, () => Promise<unknown>])[] = [
  ['delivery: GET /entries/:id', () => getPublishedEntry(ctx, scope, article(5))],
  [
    'delivery: GET /entries/:id?locale=de',
    () => getPublishedEntry(ctx, scope, article(5), { locale: 'de' }),
  ],
  [
    'delivery: GET /entries/:id?include=1',
    () => getPublishedEntry(ctx, scope, article(5), { include: 1 }),
  ],
  [
    'delivery: GET /entries/:id?include=2',
    () => getPublishedEntry(ctx, scope, article(5), { include: 2 }),
  ],
  [
    `delivery: GET /entries/:id?include=1 (${MANY_LINKS} links)`,
    () => getPublishedEntry(ctx, scope, ids.roundup, { include: 1 }),
  ],
  [
    'delivery: GET /entries?content_type=article',
    () => listPublishedEntries(ctx, scope, { contentTypeApiId: 'article' }),
  ],
  [
    'delivery: GET /entries filtered, ordered, limited',
    () =>
      listPublishedEntries(ctx, scope, {
        contentTypeApiId: 'article',
        filters: [
          { field: 'tag', op: 'eq', value: 'red' },
          { field: 'views', op: 'gt', value: 10 },
        ],
        order: [{ field: 'views', direction: 'desc' }],
        limit: 3,
      }),
  ],
  [
    'delivery: GET /entries?query=guide',
    () => listPublishedEntries(ctx, scope, { contentTypeApiId: 'article', search: 'guide' }),
  ],
  [
    'delivery: GET /entries?content_type=article&include=1',
    () => listPublishedEntries(ctx, scope, { contentTypeApiId: 'article' }, { include: 1 }),
  ],
  [
    'delivery: GET /entries?content_type=article&include=2',
    () => listPublishedEntries(ctx, scope, { contentTypeApiId: 'article' }, { include: 2 }),
  ],
  [
    'delivery: POST /graphql entry',
    () => graphql(`{ article(id: "${article(5)}") { _sys { id } title author hero related } }`),
  ],
  [
    'delivery: POST /graphql collection',
    () => graphql('{ articleCollection(limit: 5) { _sys { id } title author } }'),
  ],
  [
    'delivery: POST /graphql asset',
    () => graphql(`{ asset(id: "${ids.heroAsset}") { id title url } }`),
  ],
  [
    'delivery: GET /entries/:id?include=1 (blocks)',
    () => getPublishedEntry(ctx, scope, ids.landing, { include: 1 }),
  ],
  [
    'delivery: POST /graphql blocks',
    () =>
      graphql(
        `{ landing(id: "${ids.landing}") { title body { __typename ... on LandingBodyHero { _key heading image } ... on LandingBodyCta { _key label target } } } }`,
      ),
  ],
  ['delivery: GET /assets/:id', () => getDeliveredAsset(ctx, scope, ids.heroAsset)],
  [
    'delivery: GET /assets/:id?locale=de',
    () => getDeliveredAsset(ctx, scope, ids.heroAsset, { locale: 'de' }),
  ],
  ['delivery: GET /assets', () => listDeliveredAssets(ctx, scope)],
  ['delivery: GET /taxonomy/tags', () => listDeliveredTags(ctx, scope)],
  [
    'delivery: GET /taxonomy/tags/:slug?locale=de',
    () => getDeliveredTag(ctx, scope, 'red', { locale: 'de' }),
  ],
  ['delivery: GET /taxonomy/concepts', () => listDeliveredConcepts(ctx, scope)],
  [
    'delivery: GET /entries?metadata.tags.slug=red',
    () =>
      listPublishedEntries(ctx, scope, {
        contentTypeApiId: 'article',
        filters: [{ field: 'metadata.tags.slug', op: 'eq', value: 'red' }],
      }),
  ],
  ['delivery: GET /redirects', () => listDeliveredRedirects(ctx, scope)],
  [
    'delivery: GET /redirects/resolve',
    () => resolveDeliveredRedirect(ctx, scope, '/blog/old-3?ref=x'),
  ],
  ['delivery: GET /routes', () => listDeliveredRoutes(ctx, scope)],
  ['management: GET /entries/:id', () => getEntry(ctx, scope, article(5))],
  [
    'management: GET /entries?content_type=article',
    () => listPreviewEntries(ctx, scope, { contentTypeApiId: 'article' }),
  ],
  // The admin's entries list: a page, then the next one from its cursor. The same reads as the
  // plain list: the cursor is a WHERE on (updated_at, id), and the extra row is in the same read.
  [
    'preview: GET /entries?content_type=article (page)',
    () => listPreviewEntryPage(ctx, scope, { contentTypeApiId: 'article', limit: 2 }),
  ],
  [
    'preview: GET /entries?content_type=article&cursor',
    () =>
      listPreviewEntryPage(ctx, scope, {
        contentTypeApiId: 'article',
        limit: 2,
        cursor: entryCursor,
      }),
  ],
  [
    'management: POST /entries',
    () =>
      createEntry(ctx, scope, {
        contentTypeApiId: 'article',
        fields: {
          title: { 'en-US': 'Fresh' },
          author: { 'en-US': entryLink(ids.authors[0] as string) },
          related: { 'en-US': [entryLink(article(0)), entryLink(article(1))] },
        },
      }),
  ],
  ['management: POST /entries (blocks)', () => createEntry(ctx, scope, landingFields())],
  ['management: POST /entries/:id/published', () => publishEntry(ctx, scope, ids.draft)],
];

/** The snapshot as written: one line per request, so a diff names the request. */
function formatCounts(counts: Readonly<Record<string, QueryCount>>): string {
  const lines = Object.entries(counts).map(
    ([name, c]) =>
      `  ${JSON.stringify(name)}: { "statements": ${c.statements}, "roundTrips": ${c.roundTrips} }`,
  );
  return `{\n${lines.join(',\n')}\n}\n`;
}

/**
 * What changed against the committed counts, worst first: increases (with the SQL the request
 * now runs), then new, removed and decreased requests. Empty when nothing changed.
 */
function driftReport(
  before: Readonly<Record<string, QueryCount>>,
  after: Readonly<Record<string, QueryLog>>,
): string {
  const up: string[] = [];
  const other: string[] = [];
  const delta = (a: number, b: number) => `${a} → ${b} (${b > a ? '+' : ''}${b - a})`;
  for (const [name, now] of Object.entries(after)) {
    const was = before[name];
    if (!was) {
      other.push(`  new      ${name}: ${now.statements} statements, ${now.roundTrips} round trips`);
      continue;
    }
    if (was.statements === now.statements && was.roundTrips === now.roundTrips) continue;
    const line = `${name}: statements ${delta(was.statements, now.statements)}, round trips ${delta(was.roundTrips, now.roundTrips)}`;
    if (now.statements > was.statements || now.roundTrips > was.roundTrips) {
      up.push(`  UP       ${line}`, ...now.sql.map((s) => `             ${s}`));
    } else {
      other.push(`  down     ${line}`);
    }
  }
  for (const name of Object.keys(before)) {
    if (!(name in after)) other.push(`  removed  ${name}`);
  }
  if (up.length === 0 && other.length === 0) return '';
  return [
    'D1 query counts changed (packages/db/test/query-counts.json):',
    ...up,
    ...other,
    `If the change is intended, run \`${UPDATE}\` and commit the snapshot.`,
    'Delivery reads may only go down; a PR that raises one states why.',
  ].join('\n');
}

describe('D1 query counts', () => {
  beforeAll(async () => {
    counter = countingD1(testDb);
    let n = 0;
    ctx = {
      store: createD1Store(counter.d1),
      clock: new FixedClock(),
      ids: { newId: () => `${run}-${++n}` },
    };
    await seed();
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: {
        title: { 'en-US': 'To publish' },
        author: { 'en-US': entryLink(ids.authors[1] as string) },
      },
    });
    ids.draft = entry.id;
    entryCursor =
      (await listPreviewEntryPage(ctx, scope, { contentTypeApiId: 'article', limit: 2 }))
        .nextCursor ?? '';
    // A set with exact sources and a pattern, so a resolve walks both.
    for (let i = 0; i < 5; i++) {
      await createRedirect(ctx, scope, { source: `/old/${i}`, destination: `/new/${i}` });
    }
    await createRedirect(ctx, scope, { source: '/blog/[slug]', destination: '/posts/[slug]' });
  }, 120_000);

  it('counts a lone statement as one round trip and a batch as one round trip', async () => {
    const lone = await counter.measure(() => counter.d1.prepare('SELECT 1').all());
    expect(lone).toMatchObject({ statements: 1, roundTrips: 1 });
    const batch = await counter.measure(() =>
      counter.d1.batch([
        counter.d1.prepare('SELECT ?').bind(1),
        counter.d1.prepare('SELECT ?').bind(2),
        counter.d1.prepare('SELECT ?').bind(3),
      ]),
    );
    expect(batch).toMatchObject({ statements: 3, roundTrips: 1 });
    expect(batch.sql).toEqual(['[batch] SELECT ?', '[batch] SELECT ?', '[batch] SELECT ?']);
    const session = counter.d1.withSession('first-unconstrained');
    const read = await counter.measure(() => session.prepare('SELECT 1').first());
    expect(read).toMatchObject({ statements: 1, roundTrips: 1 });
  });

  it('reports an increase with the SQL behind it, and every other change', () => {
    const before = {
      a: { statements: 2, roundTrips: 2 },
      b: { statements: 3, roundTrips: 1 },
      gone: { statements: 1, roundTrips: 1 },
    };
    const report = driftReport(before, {
      a: { statements: 3, roundTrips: 3, sql: ['select 1', 'select 2', 'select 3'] },
      b: { statements: 2, roundTrips: 1, sql: [] },
      fresh: { statements: 1, roundTrips: 1, sql: [] },
    });
    expect(report).toContain('UP       a: statements 2 → 3 (+1), round trips 2 → 3 (+1)');
    expect(report).toContain('             select 3');
    expect(report).toContain('down     b: statements 3 → 2 (-1), round trips 1 → 1 (0)');
    expect(report).toContain('new      fresh');
    expect(report).toContain('removed  gone');
    expect(report.indexOf('UP')).toBeLessThan(report.indexOf('down'));
    expect(driftReport(before, before as never)).toBe('');
  });

  it('match the committed snapshot', async () => {
    const logs: Record<string, QueryLog> = {};
    for (const [name, request] of REQUESTS) logs[name] = await counter.measure(request);
    const counts = Object.fromEntries(
      Object.entries(logs).map(([name, l]) => [
        name,
        { statements: l.statements, roundTrips: l.roundTrips },
      ]),
    );
    await expect(formatCounts(counts), driftReport(committed, logs)).toMatchFileSnapshot(SNAPSHOT);
  });
});
