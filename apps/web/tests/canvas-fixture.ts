/**
 * A page type for the canvas tests: a `body` blocks field taking a hero, a call to action and a
 * section, whose `items` slot takes cards (one at least, two at most), plus a block catalog that
 * groups and describes them as `contentworker blocks push` would.
 */
import type {
  BlockCatalog,
  ContentType,
  EntryFields,
  FieldDefinition,
} from '@contentworker/domain';
import { formatContentRef } from '@contentworker/sdk-core';
import { canvasTree } from '~/cms/lib/canvas/model';

const f = (
  d: Pick<FieldDefinition, 'apiId' | 'name' | 'type'> & Partial<FieldDefinition>,
): FieldDefinition => ({ localized: false, required: false, position: 0, ...d });

export const card = {
  apiId: 'card',
  name: 'Card',
  fields: [f({ apiId: 'title', name: 'Title', type: 'Symbol' })],
};

export const pageType = {
  apiId: 'page',
  name: 'Page',
  displayField: 'title',
  status: 'published',
  preview: { urlTemplate: 'https://site.example/{id}' },
  fields: [
    f({ apiId: 'title', name: 'Title', type: 'Symbol' }),
    f({
      apiId: 'body',
      name: 'Main',
      type: 'Array',
      position: 1,
      validations: { size: { max: 8 } },
      items: {
        type: 'Component',
        variants: [
          {
            apiId: 'hero',
            name: 'Hero',
            fields: [
              f({ apiId: 'heading', name: 'Heading', type: 'Symbol', required: true }),
              f({
                apiId: 'tone',
                name: 'Tone',
                type: 'Symbol',
                position: 1,
                validations: { in: ['light', 'dark'] },
              }),
              f({ apiId: 'image', name: 'Image', type: 'Link', linkType: 'Asset', position: 2 }),
            ],
          },
          {
            apiId: 'cta',
            name: 'Call to action',
            fields: [f({ apiId: 'label', name: 'Label', type: 'Symbol' })],
          },
          {
            apiId: 'section',
            name: 'Section',
            fields: [
              f({ apiId: 'heading', name: 'Heading', type: 'Symbol' }),
              f({
                apiId: 'items',
                name: 'Items',
                type: 'Array',
                position: 1,
                required: true,
                validations: { size: { min: 1, max: 2 } },
                items: { type: 'Component', variants: [card] },
              }),
            ],
          },
        ],
      },
    }),
  ],
} as unknown as ContentType;

export const catalog = {
  version: 1,
  hash: 'h',
  pushedAt: '2026-11-01T00:00:00Z',
  pushedBy: null,
  changes: { added: [], changed: [], removed: [], renamed: [] },
  targets: [{ contentTypeApiId: 'page', field: 'body' }],
  blocks: [
    { id: 'hero', name: 'Hero banner', group: 'Headers', description: 'A big opening', fields: [] },
    { id: 'cta', name: 'Call to action', group: 'Actions', fields: [] },
    { id: 'section', name: 'Section', fields: [] },
    { id: 'card', name: 'Card', allowedParents: ['section'], fields: [] },
  ],
} as unknown as BlockCatalog;

/** A page: a hero, a section holding one card, and a call to action. */
export function pageFields(): EntryFields {
  return {
    title: { 'en-US': 'Home' },
    body: {
      'en-US': [
        { _type: 'hero', _key: 'h1', heading: 'Welcome', tone: 'light' },
        {
          _type: 'section',
          _key: 's1',
          heading: 'Features',
          items: [{ _type: 'card', _key: 'c1', title: 'Fast' }],
        },
        { _type: 'cta', _key: 'a1', label: 'Start' },
      ],
    },
  };
}

export const tree = (fields: EntryFields = pageFields()) =>
  canvasTree(pageType, fields, 'en-US', 'en-US');

export const refCtx = {
  space: 'sp',
  environment: 'main',
  entryId: 'e1',
  contentType: 'page',
  locale: 'en-US',
  defaultLocale: 'en-US',
};

/** A content ref for this entry, as the page writes it. */
export const ref = (field: string, over: Partial<typeof refCtx> = {}) => {
  const c = { ...refCtx, ...over };
  return formatContentRef({
    space: c.space,
    environment: c.environment,
    entryId: c.entryId,
    contentType: c.contentType,
    field,
    locale: c.locale,
  });
};
