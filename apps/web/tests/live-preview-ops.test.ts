// The ops the Site pane sends the framed page after each edit: `setField` for ordinary fields,
// key-addressed block ops (every key present) for blocks fields, and each set of ops applied by the
// page's own engine gives exactly the form's new values.
import type { ContentType, EntryFields, FieldDefinition } from '@contentworker/domain';
import {
  applyLivePatch,
  type LiveFields,
  MAX_PATCH_OPS,
} from '@contentworker/sdk-core/live-preview';
import { describe, expect, it } from 'vitest';
import { equal, liveOps } from '~/cms/lib/live-preview/ops';

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

const page: Pick<ContentType, 'fields'> = {
  fields: [
    field('title'),
    field('views', { type: 'Integer', localized: false }),
    field('body', {
      type: 'Array',
      localized: false,
      items: {
        type: 'Component',
        variants: [
          { apiId: 'hero', name: 'Hero', fields: [field('heading', { localized: false })] },
          { apiId: 'cta', name: 'Call to action', fields: [field('label', { localized: false })] },
          {
            apiId: 'columns',
            name: 'Columns',
            fields: [
              field('items', {
                type: 'Array',
                localized: false,
                items: {
                  type: 'Component',
                  variants: [
                    { apiId: 'cta', name: 'CTA', fields: [field('label', { localized: false })] },
                  ],
                },
              }),
            ],
          },
        ],
      },
    } as Partial<FieldDefinition>),
  ],
};

const blocks = (...items: Record<string, unknown>[]): EntryFields => ({ body: { 'en-US': items } });
const hero = (key: string, heading = 'Hi') => ({ _type: 'hero', _key: key, heading });
const cta = (key: string, label = 'Go') => ({ _type: 'cta', _key: key, label });

/** What the page holds after applying the ops to `before`, which must be the form's `after`. */
function roundTrip(before: EntryFields, after: EntryFields) {
  const ops = liveOps(page, before, after);
  expect(ops).not.toBeNull();
  const applied = applyLivePatch(before as LiveFields, ops ?? [], {
    newKey: () => {
      throw new Error('the page had to mint a key: an op left one out');
    },
  });
  if (!applied.ok) throw new Error(applied.message);
  // A cleared field's last locale leaves `{}` on the page: the same as no value.
  const held = Object.fromEntries(
    Object.entries(applied.fields).filter(([, byLocale]) => Object.keys(byLocale).length > 0),
  );
  expect(equal(held, after)).toBe(true);
  return ops ?? [];
}

describe('live preview ops from the form', () => {
  it('sends nothing when nothing changed, whatever order the properties were written in', () => {
    expect(
      liveOps(page, blocks({ _key: 'a', _type: 'hero' }), blocks({ _type: 'hero', _key: 'a' })),
    ).toEqual([]);
  });

  it('sets an ordinary field per locale that changed, and clears one emptied', () => {
    const ops = roundTrip(
      { title: { 'en-US': 'Home', de: 'Start' }, views: { 'en-US': 3 } },
      { title: { 'en-US': 'Homepage', de: 'Start' } },
    );
    expect(ops).toEqual([
      { op: 'setField', field: 'title', locale: 'en-US', value: 'Homepage' },
      { op: 'setField', field: 'views', locale: 'en-US' },
    ]);
  });

  it('updates the one block whose property changed, by its key', () => {
    const ops = roundTrip(blocks(hero('a'), cta('b')), blocks(hero('a', 'Hello'), cta('b')));
    expect(ops).toEqual([
      { op: 'update', field: 'body', locale: 'en-US', key: 'a', set: { heading: 'Hello' } },
    ]);
  });

  it('inserts a new block with its own key, after its neighbour', () => {
    const ops = roundTrip(blocks(hero('a')), blocks(hero('a'), cta('n')));
    expect(ops).toEqual([
      { op: 'insert', field: 'body', locale: 'en-US', block: cta('n'), after: 'a' },
    ]);
    // Every insert carries its key: the page mints none of its own.
    expect(ops.every((op) => op.op !== 'insert' || typeof op.block._key === 'string')).toBe(true);
  });

  it('inserts at the start by index, removes by key and moves by key', () => {
    expect(roundTrip(blocks(hero('a')), blocks(cta('n'), hero('a')))).toEqual([
      { op: 'insert', field: 'body', locale: 'en-US', block: cta('n'), index: 0 },
    ]);
    expect(roundTrip(blocks(hero('a'), cta('b')), blocks(cta('b')))).toEqual([
      { op: 'remove', field: 'body', locale: 'en-US', key: 'a' },
    ]);
    expect(
      roundTrip(blocks(hero('a'), cta('b'), cta('c')), blocks(cta('c'), hero('a'), cta('b'))),
    ).toEqual([{ op: 'move', field: 'body', locale: 'en-US', key: 'c', to: { index: 0 } }]);
  });

  it('sends a changed slot inside a block as that block’s property, keys and all', () => {
    const cols = (...items: Record<string, unknown>[]) => ({
      _type: 'columns',
      _key: 'col',
      items,
    });
    const ops = roundTrip(blocks(cols(cta('x'))), blocks(cols(cta('x'), cta('y', 'More'))));
    expect(ops).toEqual([
      {
        op: 'update',
        field: 'body',
        locale: 'en-US',
        key: 'col',
        set: { items: [cta('x'), cta('y', 'More')] },
      },
    ]);
  });

  it('unsets a property the block no longer has', () => {
    const ops = roundTrip(blocks(hero('a')), blocks({ _type: 'hero', _key: 'a' }));
    expect(ops).toEqual([
      { op: 'update', field: 'body', locale: 'en-US', key: 'a', unset: ['heading'] },
    ]);
  });

  it('sends the field whole when a block has no key, or a key is held twice', () => {
    const keyless = blocks(hero('a'), { _type: 'cta', label: 'Go' });
    expect(roundTrip(blocks(hero('a')), keyless)).toEqual([
      { op: 'setField', field: 'body', locale: 'en-US', value: keyless.body?.['en-US'] },
    ]);
    const twice = blocks(hero('a'), cta('a'));
    expect(liveOps(page, blocks(hero('a')), twice)).toEqual([
      { op: 'setField', field: 'body', locale: 'en-US', value: twice.body?.['en-US'] },
    ]);
    const nestedKeyless = blocks({
      _type: 'columns',
      _key: 'c',
      items: [{ _type: 'cta', label: 'x' }],
    });
    expect(liveOps(page, blocks(), nestedKeyless)?.[0]?.op).toBe('setField');
  });

  it('sends a reshuffle that would take more ops than blocks as the field whole', () => {
    const ops = roundTrip(
      blocks(hero('a'), cta('b'), cta('c')),
      blocks(cta('c', '1'), cta('b', '2'), hero('a', '3')),
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]?.op).toBe('setField');
  });

  it('gives up on a patch when the edits are more than one patch may carry', () => {
    const many = { fields: Array.from({ length: MAX_PATCH_OPS + 1 }, (_, i) => field(`f${i}`)) };
    const after = Object.fromEntries(many.fields.map((f) => [f.apiId, { 'en-US': 'x' }]));
    expect(liveOps(many, {}, after)).toBeNull();
  });
});
