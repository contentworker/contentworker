import type { ContentType, FieldDefinition } from '@contentworker/domain';
import { describe, expect, it } from 'vitest';
import { draftBlockRows, isBlocksField, placeName } from '~/cms/lib/draft-blocks';

const sym = (apiId: string, name: string, type = 'Symbol') =>
  ({ apiId, name, type, localized: false, required: false, position: 0 }) as FieldDefinition;

const body = {
  ...sym('body', 'Main', 'Array'),
  items: {
    type: 'Component',
    variants: [
      {
        apiId: 'hero',
        name: 'Hero',
        fields: [sym('heading', 'Heading'), sym('image', 'Image', 'Link')],
      },
      {
        apiId: 'section',
        name: 'Section',
        fields: [
          sym('heading', 'Heading'),
          {
            ...sym('items', 'Cards', 'Array'),
            items: {
              type: 'Component',
              variants: [{ apiId: 'card', name: 'Card', fields: [sym('title', 'Title')] }],
            },
          },
        ],
      },
    ],
  },
} as unknown as FieldDefinition;

const page = {
  apiId: 'page',
  name: 'Page',
  fields: [sym('title', 'Title'), body],
} as unknown as ContentType;

const value = [
  { _type: 'hero', heading: '  Welcome   to the   launch  ' },
  {
    _type: 'section',
    heading: 'Legal',
    items: [{ _type: 'card', title: 'Terms' }, { _type: 'card' }],
  },
  { _type: 'mystery' },
];

describe('draftBlockRows', () => {
  it('outlines the blocks by name, a line of their text, slots indented', () => {
    expect(draftBlockRows(body, value)).toEqual([
      { key: 'body[0]', depth: 0, name: 'Hero', text: 'Welcome to the launch' },
      { key: 'body[1]', depth: 0, name: 'Section', text: 'Legal' },
      { key: 'body[1].items[0]', depth: 1, name: 'Card', text: 'Terms' },
      { key: 'body[1].items[1]', depth: 1, name: 'Card' },
      { key: 'body[2]', depth: 0, name: 'mystery' },
    ]);
  });

  it('cuts a long line and reads nothing from a field that holds no blocks', () => {
    const [row] = draftBlockRows(body, [{ _type: 'hero', heading: 'x'.repeat(200) }]);
    expect(row?.text).toHaveLength(80);
    expect(row?.text?.endsWith('…')).toBe(true);
    expect(draftBlockRows(sym('title', 'Title'), 'Hello')).toEqual([]);
    expect(isBlocksField(body)).toBe(true);
    expect(isBlocksField(sym('title', 'Title'))).toBe(false);
  });
});

describe('placeName', () => {
  const fields = { body: { 'en-US': value } };
  it('names a place as an editor sees it', () => {
    expect(placeName(page, fields, 'body[0].image')).toBe('Main › Hero 1 › Image');
    expect(placeName(page, fields, 'body[1].items[0].title')).toBe(
      'Main › Section 2 › Cards › Card 1 › Title',
    );
  });
  it('falls back to the path when a step does not resolve', () => {
    expect(placeName(page, fields, 'body[9].image')).toBe('body[9].image');
    expect(placeName(page, fields, 'nope[0]')).toBe('nope[0]');
  });
});
