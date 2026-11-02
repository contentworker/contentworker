import { defineContentType } from '@contentworker/domain';
import type { DeliveryResolvers, ResolvedEntry } from '@contentworker/ports';
import { type GraphQLObjectType, graphql } from 'graphql';
import { describe, expect, it } from 'vitest';
import { buildDeliverySchema, type DeliveryContext } from '../src/index';

const article = defineContentType({
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
      apiId: 'wordCount',
      name: 'Words',
      type: 'Integer',
      localized: false,
      required: false,
      position: 1,
    },
    {
      apiId: 'hero',
      name: 'Hero',
      type: 'Link',
      localized: false,
      required: false,
      position: 2,
      linkType: 'Asset',
    },
    {
      apiId: 'body',
      name: 'Body',
      type: 'RichText',
      localized: false,
      required: false,
      position: 3,
    },
  ],
});

const entries: Record<string, ResolvedEntry> = {
  e1: {
    id: 'e1',
    contentType: 'article',
    publishedAt: 'now',
    fields: { title: 'Hello', wordCount: 42, hero: { id: 'a1', file: { fileName: 'h.jpg' } } },
  },
};

const resolvers: DeliveryResolvers = {
  entry: async (_ct, id) => entries[id] ?? null,
  collection: async () => Object.values(entries),
  asset: async (id) => ({ id, file: { fileName: 'h.jpg' } }),
  search: async () => [{ entryId: 'e1', score: 0.9, snippet: 'Hello' }],
};

describe('@contentworker/graphql-gen', () => {
  // Resolvers travel per-request as contextValue — never baked into the schema.
  const schema = buildDeliverySchema([article]);
  const contextValue: DeliveryContext = { resolvers };

  it('generates typed object types with scalar + JSON (link) fields', async () => {
    const r = await graphql({
      schema,
      contextValue,
      source: '{ article(id: "e1") { _sys { id contentType } title wordCount hero } }',
    });
    expect(r.errors).toBeUndefined();
    const a = (r.data as { article: Record<string, unknown> }).article;
    expect((a._sys as { id: string }).id).toBe('e1');
    expect(a.title).toBe('Hello');
    expect(a.wordCount).toBe(42);
    // Link field arrives as resolved JSON (the embedded asset).
    expect((a.hero as { id: string }).id).toBe('a1');
  });

  it('describes a rich-text field as a document tree with structured embeds, never HTML', () => {
    const type = schema.getType('Article') as GraphQLObjectType;
    const description = type.getFields().body?.description ?? '';
    expect(description).toMatch(/document tree/);
    expect(description).toMatch(/never HTML/);
    expect(description).toMatch(/"embed" node/);
    expect(type.getFields().title?.description).toBeUndefined();
  });

  it('exposes a collection root and a search root', async () => {
    const r = await graphql({
      schema,
      contextValue,
      source: '{ articleCollection { _sys { id } } search(query: "x") { entryId score } }',
    });
    expect(r.errors).toBeUndefined();
    const data = r.data as { articleCollection: unknown[]; search: { entryId: string }[] };
    expect(data.articleCollection).toHaveLength(1);
    expect(data.search[0]?.entryId).toBe('e1');
  });

  it('returns null for a wrong-id query without throwing', async () => {
    const r = await graphql({ schema, contextValue, source: '{ article(id: "nope") { title } }' });
    expect(r.errors).toBeUndefined();
    expect((r.data as { article: unknown }).article).toBeNull();
  });
});
