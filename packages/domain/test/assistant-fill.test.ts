import { describe, expect, it } from 'vitest';
import { type AssistantFill, outsideFill } from '../src/assistant/fill';

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
