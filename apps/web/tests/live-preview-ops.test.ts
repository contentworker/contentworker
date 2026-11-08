// What the Site pane sends the framed page after each edit: one locale's values, the changed
// ordinary fields as `entry.patch` values (null clears), blocks fields as key-addressed ops in
// applied form (every key present), and the page's own engine turning them into exactly the
// form's new values. Rich text that isn't a document never crosses.
import type { ContentType, FieldDefinition } from '@contentworker/domain';
import {
  applyLivePatch,
  type LiveFields,
  MAX_PATCH_OPS,
} from '@contentworker/sdk-core/live-preview';
import { describe, expect, it } from 'vitest';
import { equal, liveEdits, liveFields } from '~/cms/lib/live-preview/ops';

const field = (apiId: string, extra: Partial<FieldDefinition> = {}): FieldDefinition =>
  ({
    apiId,
    name: apiId,
    type: 'Symbol',
    localized: true,
    required: false,
    position: 0,
    ...extra,
  }) as FieldDefinition;

const cta = { apiId: 'cta', name: 'CTA', fields: [field('label', { localized: false })] };
const page: Pick<ContentType, 'fields'> = {
  fields: [
    field('title'),
    field('views', { type: 'Integer', localized: false }),
    field('content', { type: 'RichText', localized: false }),
    field('body', {
      type: 'Array',
      localized: false,
      items: {
        type: 'Component',
        variants: [
          { apiId: 'hero', name: 'Hero', fields: [field('heading', { localized: false })] },
          cta,
          {
            apiId: 'columns',
            name: 'Columns',
            fields: [
              field('items', {
                type: 'Array',
                localized: false,
                items: { type: 'Component', variants: [cta] },
              } as Partial<FieldDefinition>),
            ],
          },
        ],
      },
    } as Partial<FieldDefinition>),
  ],
};

const hero = (key: string, heading = 'Hi') => ({ _type: 'hero', _key: key, heading });
const ctaBlock = (key: string, label = 'Go') => ({ _type: 'cta', _key: key, label });
const blocks = (...items: Record<string, unknown>[]): LiveFields => ({ body: items });

/** The page's values after applying the edits to `before`, which must be the form's `after`. */
function roundTrip(before: LiveFields, after: LiveFields) {
  const edits = liveEdits(page, 'en-US', before, after);
  let held: LiveFields = { ...before };
  for (const [name, value] of Object.entries(edits.fields)) {
    if (value === null) delete held[name];
    else held[name] = value;
  }
  for (const { field: name, ops } of edits.blocks) {
    const result = applyLivePatch({ [name]: { 'en-US': held[name] } }, ops, {
      newKey: () => {
        throw new Error('the page had to mint a key: an op left one out');
      },
    });
    if (!result.ok) throw new Error(result.message);
    held = { ...held, [name]: result.fields[name]?.['en-US'] };
  }
  expect(equal(held, after)).toBe(true);
  return edits;
}

describe('live preview values from the form', () => {
  it('takes one locale: a localized field’s own value, any other from the default locale', () => {
    expect(
      liveFields(
        page,
        { title: { 'en-US': 'Home', de: 'Start' }, views: { 'en-US': 3 } },
        'de',
        'en-US',
      ),
    ).toEqual({ title: 'Start', views: 3 });
  });

  it('never sends rich text that isn’t a document', () => {
    const doc = { nodeType: 'document', content: [] };
    expect(liveFields(page, { content: { 'en-US': doc } }, 'en-US', 'en-US')).toEqual({
      content: doc,
    });
    expect(liveFields(page, { content: { 'en-US': '<p>Hi</p>' } }, 'en-US', 'en-US')).toEqual({});
  });
});

describe('live preview edits', () => {
  it('sends nothing when nothing changed, whatever order the properties were written in', () => {
    const edits = liveEdits(
      page,
      'en-US',
      blocks({ _key: 'a', _type: 'hero' }),
      blocks({ _type: 'hero', _key: 'a' }),
    );
    expect(edits).toEqual({ fields: {}, blocks: [] });
  });

  it('sends a changed ordinary field’s new value, and null for one cleared', () => {
    expect(roundTrip({ title: 'Home', views: 3 }, { title: 'Homepage' }).fields).toEqual({
      title: 'Homepage',
      views: null,
    });
  });

  it('updates the one block whose property changed, by its key', () => {
    expect(
      roundTrip(blocks(hero('a'), ctaBlock('b')), blocks(hero('a', 'Hello'), ctaBlock('b'))).blocks,
    ).toEqual([
      {
        field: 'body',
        ops: [
          { op: 'update', field: 'body', locale: 'en-US', key: 'a', set: { heading: 'Hello' } },
        ],
      },
    ]);
  });

  it('inserts a new block with its own key, removes and moves by key', () => {
    const insert = roundTrip(blocks(hero('a')), blocks(hero('a'), ctaBlock('n'))).blocks[0]?.ops;
    expect(insert).toEqual([
      { op: 'insert', field: 'body', locale: 'en-US', block: ctaBlock('n'), after: 'a' },
    ]);
    expect(
      roundTrip(blocks(hero('a'), ctaBlock('b')), blocks(ctaBlock('b'))).blocks[0]?.ops,
    ).toEqual([{ op: 'remove', field: 'body', locale: 'en-US', key: 'a' }]);
    expect(
      roundTrip(
        blocks(hero('a'), ctaBlock('b'), ctaBlock('c')),
        blocks(ctaBlock('c'), hero('a'), ctaBlock('b')),
      ).blocks[0]?.ops,
    ).toEqual([{ op: 'move', field: 'body', locale: 'en-US', key: 'c', to: { index: 0 } }]);
  });

  it('sends a changed slot inside a block as that block’s property, keys and all', () => {
    const cols = (...items: Record<string, unknown>[]) => ({
      _type: 'columns',
      _key: 'col',
      items,
    });
    expect(
      roundTrip(blocks(cols(ctaBlock('x'))), blocks(cols(ctaBlock('x'), ctaBlock('y', 'More'))))
        .blocks[0]?.ops,
    ).toEqual([
      {
        op: 'update',
        field: 'body',
        locale: 'en-US',
        key: 'col',
        set: { items: [ctaBlock('x'), ctaBlock('y', 'More')] },
      },
    ]);
  });

  it('sends the field whole when a block has no key, a key is held twice, or a reshuffle is costly', () => {
    const keyless = blocks(hero('a'), { _type: 'cta', label: 'Go' });
    expect(roundTrip(blocks(hero('a')), keyless)).toEqual({
      fields: { body: keyless.body },
      blocks: [],
    });
    const twice = blocks(hero('a'), ctaBlock('a'));
    expect(liveEdits(page, 'en-US', blocks(hero('a')), twice).fields).toEqual({ body: twice.body });
    const shuffled = roundTrip(
      blocks(hero('a'), ctaBlock('b'), ctaBlock('c')),
      blocks(ctaBlock('c', '1'), ctaBlock('b', '2'), hero('a', '3')),
    );
    expect(shuffled.blocks).toEqual([]);
    expect(Object.keys(shuffled.fields)).toEqual(['body']);
  });

  it('sends a blocks field whole when its ops would be more than one patch carries', () => {
    const many = Array.from({ length: MAX_PATCH_OPS + 1 }, (_, i) => hero(`k${i}`));
    const edits = liveEdits(
      page,
      'en-US',
      blocks(...many),
      blocks(...many.map((b) => ({ ...b, heading: 'x' }))),
    );
    expect(edits.blocks).toEqual([]);
    expect(Object.keys(edits.fields)).toEqual(['body']);
  });
});
