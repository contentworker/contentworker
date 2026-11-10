import { describe, expect, it } from 'vitest';
import {
  type AssistantFill,
  fillRefusal,
  fillRefusalText,
  outsideFill,
  readFillTurn,
} from '../src/assistant/fill';

const fill: AssistantFill = {
  field: 'body',
  locale: 'en-US',
  after: 'hero',
  before: 'footer',
  slot: 'Body',
  blocks: [{ type: 'text', name: 'Text', fields: [{ apiId: 'heading', name: 'Heading' }] }],
  count: 2,
  max: 4,
  around: ['Hero', 'Footer'],
};
const insert = (extra: Record<string, unknown> = {}, type = 'text') => ({
  op: 'insert',
  field: 'body',
  locale: 'en-US',
  block: { _type: type, heading: 'Hi' },
  after: 'hero',
  ...extra,
});

describe('a proposal held to the slot it was asked to fill', () => {
  it('keeps to it: blocks of the types offered, at the place, or after one it just put there', () => {
    expect(outsideFill(fill, [insert()])).toBeUndefined();
    expect(outsideFill(fill, [insert({ ref: 'a' }), insert({ after: 'a' })])).toBeUndefined();
    expect(
      outsideFill(fill, [{ ...insert({ before: 'footer' }), after: undefined }]),
    ).toBeUndefined();
  });

  it('names the first step outside it: another op, field, locale, type, slot or place', () => {
    expect(
      outsideFill(fill, [insert(), { op: 'remove', field: 'body', locale: 'en-US', key: 'hero' }]),
    ).toBe(1);
    expect(outsideFill(fill, [insert({ field: 'sidebar' })])).toBe(0);
    expect(outsideFill(fill, [insert({ locale: 'de-DE' })])).toBe(0);
    expect(outsideFill(fill, [insert({}, 'hero')])).toBe(0);
    expect(outsideFill(fill, [insert({ parent: { key: 'hero', slot: 'items' } })])).toBe(0);
    expect(outsideFill(fill, [insert({ after: 'footer' })])).toBe(0);
    // At the end of the slot, or its start, isn't between Hero and Footer.
    expect(outsideFill(fill, [{ ...insert(), after: undefined }])).toBe(0);
    expect(outsideFill(fill, [{ ...insert(), after: undefined, index: 0 }])).toBe(0);
    expect(outsideFill(fill, ['not an op'])).toBe(0);
  });

  it('refuses a block carrying anything it wasn’t asked for: another field, a link, blocks inside', () => {
    const carrying = (extra: Record<string, unknown>) =>
      insert({ block: { _type: 'text', heading: 'Hi', ...extra } });
    expect(outsideFill(fill, [carrying({ href: 'https://evil.example' })])).toBe(0);
    expect(outsideFill(fill, [carrying({ heading: { nodeType: 'document' } })])).toBe(0);
    expect(outsideFill(fill, [carrying({ items: [{ _type: 'text', heading: 'x' }] })])).toBe(0);
    expect(outsideFill(fill, [carrying({ _key: 'mine' })])).toBeUndefined();
  });

  it('refuses a block put at the end when the place is between two blocks', () => {
    const op = { ...insert(), after: undefined };
    expect(outsideFill(fill, [op])).toBe(0);
    // At the end of the slot, it is the place.
    expect(outsideFill({ ...fill, before: undefined }, [op])).toBeUndefined();
  });

  it('holds to the slot’s most', () => {
    expect(
      outsideFill(fill, [
        insert({ ref: 'a' }),
        insert({ after: 'a', ref: 'b' }),
        insert({ after: 'b' }),
      ]),
    ).toBe(2);
    expect(
      outsideFill({ ...fill, max: undefined }, [insert(), insert(), insert()]),
    ).toBeUndefined();
  });

  it('fills an empty slot inside a block at its start, or with no place given', () => {
    const inner: AssistantFill = {
      ...fill,
      parent: { key: 'sec', slot: 'items' },
      after: undefined,
      before: undefined,
      count: 0,
    };
    const op = { ...insert({ parent: { key: 'sec', slot: 'items' } }), after: undefined };
    expect(outsideFill(inner, [op])).toBeUndefined();
    expect(outsideFill(inner, [{ ...op, index: 0 }])).toBeUndefined();
    expect(outsideFill(inner, [{ ...op, parent: undefined }])).toBe(0);
  });
});

describe('a fill turn’s changes, as the card and the agent judge them', () => {
  const turn = { entryId: 'e1', fill };
  const patch = (ops: unknown[], id = 'e1') => ({ id, expectedVersion: 3, ops });

  it('lets through a patch of that entry that keeps to the slot, and every read', () => {
    expect(fillRefusal(turn, 'entry_blocks_patch', patch([insert()]))).toBeUndefined();
    expect(fillRefusal(turn, 'entry_blocks_outline', { id: 'other' })).toBeUndefined();
    expect(fillRefusal(turn, 'entries_get', { id: 'e1' })).toBeUndefined();
  });

  it('refuses a step outside the slot in words, counted from 1', () => {
    const r = fillRefusal(
      turn,
      'entry_blocks_patch',
      patch([insert(), { op: 'remove', field: 'body', locale: 'en-US', key: 'hero' }]),
    );
    expect(r).toEqual({
      step: 2,
      title: 'Step 2 goes outside Body',
      detail:
        'You asked Coworker to fill Body at one place. This step changes something else, or puts a block somewhere else or of a kind Body doesn’t take, so nothing here can be confirmed',
      hold: 'You can’t confirm this: step 2 goes outside the slot you asked it to fill.',
    });
    expect(fillRefusalText(r!)).toBe(`${r?.title}. ${r?.detail}.`);
  });

  it('refuses a patch of another entry, and any other write, whatever its input', () => {
    expect(fillRefusal(turn, 'entry_blocks_patch', patch([insert()], 'e2'))).toMatchObject({
      title: 'This isn’t filling Body',
    });
    for (const tool of ['entries_update', 'entries_publish', 'entries_trash', 'comments_add']) {
      expect(fillRefusal(turn, tool, { id: 'e1' })).toMatchObject({
        hold: 'You can’t confirm this: it changes something other than the slot you asked it to fill.',
      });
    }
    // Not a tool Coworker offers: nothing to judge here (the agent never runs one).
    expect(fillRefusal(turn, 'entries_purge_everything', {})).toBeUndefined();
  });

  it('reads a turn’s fill as the agent writes it, or none', () => {
    expect(readFillTurn({ entryId: 'e1', fill })).toEqual({ entryId: 'e1', fill });
    expect(readFillTurn({ fill })).toBeUndefined();
    expect(readFillTurn({ entryId: 'e1', fill: { ...fill, blocks: [] } })).toBeUndefined();
    expect(readFillTurn(fill)).toBeUndefined();
    expect(readFillTurn(undefined)).toBeUndefined();
  });
});
