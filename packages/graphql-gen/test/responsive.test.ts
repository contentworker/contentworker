import type { ContentType, FieldDefinition } from '@contentworker/domain';
import type { ResolvedEntry } from '@contentworker/ports';
import { type GraphQLObjectType, graphql, printSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import { buildDeliverySchema, type DeliveryContext } from '../src/index';

/**
 * A block with per-breakpoint overrides gains `_responsive: <BlockType>Responsive`, one nullable
 * field per breakpoint of the overridable props. Additive: every other type keeps its name, even
 * one whose preferred name the new types would otherwise have taken, and the field is named for
 * its stored key, so no prop can ever take it.
 */

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId'>): FieldDefinition =>
  ({
    name: over.apiId,
    type: 'Symbol',
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

const BREAKPOINTS = [
  { id: 'md', name: 'Tablet', minWidth: 768 },
  { id: 'lg', name: 'Desktop', minWidth: 1280 },
];

const card = {
  apiId: 'card',
  name: 'Card',
  responsive: ['hidden'],
  fields: [field({ apiId: 'title' }), field({ apiId: 'hidden', type: 'Boolean', position: 1 })],
};

const page = (breakpoints: typeof BREAKPOINTS | undefined): ContentType => ({
  apiId: 'page',
  name: 'Page',
  displayField: 'title',
  version: 1,
  status: 'published',
  fields: [
    field({ apiId: 'title' }),
    field({
      apiId: 'body',
      type: 'Array',
      position: 1,
      items: {
        type: 'Component',
        ...(breakpoints ? { breakpoints } : {}),
        variants: [
          {
            apiId: 'hero',
            name: 'Hero',
            responsive: ['size', 'columns'],
            fields: [
              field({ apiId: 'size', validations: { in: ['sm', 'md', 'xl'] } }),
              field({
                apiId: 'columns',
                type: 'Integer',
                position: 1,
                validations: { in: [1, 3] },
              }),
              // A component prop whose type wants the name the overrides would prefer.
              field({
                apiId: 'responsive',
                type: 'Component',
                position: 2,
                fields: [field({ apiId: 'note' })],
              }),
            ],
          },
          {
            apiId: 'grid',
            name: 'Grid',
            fields: [
              field({ apiId: 'label' }),
              field({
                apiId: 'items',
                type: 'Array',
                position: 1,
                items: { type: 'Component', variants: [card] },
              }),
            ],
          },
        ],
      },
    }),
  ],
});

const entry: ResolvedEntry = {
  id: 'e1',
  contentType: 'page',
  publishedAt: 'now',
  fields: {
    title: 'Home',
    body: [
      {
        _type: 'hero',
        _key: 'h1',
        size: 'md',
        columns: 1,
        // `md.size` isn't one of its tokens, `lg.columns` not a number: neither is served.
        _responsive: { lg: { size: 'xl', columns: '3' }, md: { size: 'huge' }, xl: { size: 'sm' } },
      },
      {
        _type: 'grid',
        _key: 'g1',
        items: [{ _type: 'card', _responsive: { md: { hidden: true } } }],
      },
    ],
  },
};

const contextValue = {
  resolvers: {
    entry: async (_ct: string, id: string) => (id === 'e1' ? entry : null),
    collection: async () => [entry],
    asset: async () => null,
    localize: async () => null,
    search: async () => [],
  },
} as unknown as DeliveryContext;

const typeNames = (schema: ReturnType<typeof buildDeliverySchema>) =>
  Object.keys(schema.getTypeMap())
    .filter((n) => !n.startsWith('__'))
    .sort();

describe('per-breakpoint overrides in the delivery schema', () => {
  const before = buildDeliverySchema([page(undefined)]);
  const schema = buildDeliverySchema([page(BREAKPOINTS)]);

  it('adds types and renames none', () => {
    const added = typeNames(schema).filter((n) => !typeNames(before).includes(n));
    expect(added.sort()).toEqual(
      [
        'PageBodyHeroResponsive2',
        'PageBodyHeroResponsiveValues',
        'PageBodyGridItemsCardResponsive',
        'PageBodyGridItemsCardResponsiveValues',
      ].sort(),
    );
    // Every type the schema had keeps its name and its fields.
    for (const name of typeNames(before)) {
      const was = before.getType(name) as GraphQLObjectType;
      const now = schema.getType(name) as GraphQLObjectType;
      expect(now?.constructor).toBe(was.constructor);
      if ('getFields' in was) {
        expect(Object.keys(now.getFields())).toEqual(
          expect.arrayContaining(Object.keys(was.getFields())),
        );
      }
    }
    // Without overrides anywhere, the schema is the same as it always was.
    expect(printSchema(buildDeliverySchema([page(undefined)]))).toBe(printSchema(before));
  });

  it('names the overrides field by its stored key, beside a prop called responsive', () => {
    const hero = schema.getType('PageBodyHero') as GraphQLObjectType;
    expect(String(hero.getFields()._responsive?.type)).toBe('PageBodyHeroResponsive2');
    expect(String(hero.getFields().responsive?.type)).toBe('PageBodyHeroResponsive');
    const card = schema.getType('PageBodyGridItemsCard') as GraphQLObjectType;
    expect(String(card.getFields()._responsive?.type)).toBe('PageBodyGridItemsCardResponsive');
    expect(card.getFields().responsive).toBeUndefined();
    const values = schema.getType('PageBodyHeroResponsiveValues') as GraphQLObjectType;
    expect(
      Object.fromEntries(Object.entries(values.getFields()).map(([k, f]) => [k, String(f.type)])),
    ).toEqual({
      size: 'String',
      columns: 'Int',
    });
  });

  it('serves the declared overrides, null where a breakpoint has none or a value isn’t a token', async () => {
    const r = await graphql({
      schema,
      contextValue,
      source: `{ page(id: "e1") { body {
        ... on PageBodyHero { size _responsive { md { size } lg { size columns } } }
        ... on PageBodyGrid { items { ... on PageBodyGridItemsCard { _responsive { md { hidden } lg { hidden } } } } }
      } } }`,
    });
    expect(r.errors).toBeUndefined();
    expect((r.data as { page: { body: unknown[] } }).page.body).toEqual([
      { size: 'md', _responsive: { md: { size: null }, lg: { size: 'xl', columns: null } } },
      { items: [{ _responsive: { md: { hidden: true }, lg: null } }] },
    ]);
  });
});
