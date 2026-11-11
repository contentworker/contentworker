/**
 * Moving a block on the canvas, without a screen: where a dragged block may land (its own slot,
 * another slot of its field that takes it) and where it may not (its own place, inside itself,
 * another field, a full or locked slot, a locked region, a place the block config narrows away,
 * a slot left short), the one `move` op a drop makes, its undo, Move to's targets, and the config
 * judging the moved draft as the save will.
 */
import {
  type BlockCatalog,
  type BlockConfigIssue,
  type ContentType,
  EMPTY_BLOCK_CONFIG,
  type EntryFields,
  effectiveBlockRules,
} from '@contentworker/domain';
import { describe, expect, it } from 'vitest';
import { configIssues } from '~/cms/lib/block-rules';
import { canDrag, configRefusal, judgeDrop, moveTargets } from '~/cms/lib/canvas/drag';
import { applyOps, EMPTY_HISTORY, record, undo } from '~/cms/lib/canvas/history';
import { type CanvasRules, canvasTree, findBlock, findSlot } from '~/cms/lib/canvas/model';
import type { EntryBlockLock } from '~/cms/lib/management';
import { catalog, pageFields, pageType } from './canvas-fixture';

/** The fixture page with a second section holding two cards: h1, s1 [c1], s2 [c2, c3], a1. */
function twoSections(): EntryFields {
  const fields = pageFields();
  const body = fields.body?.['en-US'] as unknown[];
  body.splice(2, 0, {
    _type: 'section',
    _key: 's2',
    heading: 'More',
    items: [
      { _type: 'card', _key: 'c2', title: 'Safe' },
      { _type: 'card', _key: 'c3', title: 'Sound' },
    ],
  });
  return fields;
}

/** The same type with a second blocks field, `aside`, taking calls to action. */
const twoFields = {
  ...pageType,
  fields: [
    ...pageType.fields,
    {
      apiId: 'aside',
      name: 'Aside',
      type: 'Array',
      localized: false,
      required: false,
      position: 2,
      items: {
        type: 'Component',
        variants: [
          {
            apiId: 'cta',
            name: 'Call to action',
            fields: [
              { apiId: 'label', name: 'Label', type: 'Symbol', localized: false, required: false },
            ],
          },
        ],
      },
    },
  ],
} as unknown as ContentType;

/** Takes the last card out of the section keyed `key`. */
function dropCard(fields: EntryFields, key: string): EntryFields {
  const body = (fields.body?.['en-US'] ?? []) as Record<string, unknown>[];
  const items = body.find((b) => b._key === key)?.items;
  if (Array.isArray(items)) items.pop();
  return fields;
}

const treeOf = (fields: EntryFields, config?: CanvasRules, type: ContentType = pageType) =>
  canvasTree(type, fields, 'en-US', 'en-US', config);
const at = (tree: ReturnType<typeof treeOf>, path: string, index: number) => {
  const slot = findSlot(tree, path);
  if (!slot) throw new Error(`no slot ${path}`);
  return { slot, index };
};
const block = (tree: ReturnType<typeof treeOf>, key: string) => {
  const b = findBlock(tree, key);
  if (!b) throw new Error(`no block ${key}`);
  return b;
};
const keysIn = (fields: EntryFields, path: (b: Record<string, unknown>[]) => unknown[]) =>
  path(fields.body?.['en-US'] as Record<string, unknown>[]).map(
    (b) => (b as { _key: string })._key,
  );

describe('where a dragged block may go', () => {
  it('moves within its slot as one move op, by the neighbours’ keys, and undo puts it back', () => {
    const fields = twoSections();
    const tree = treeOf(fields);
    const verdict = judgeDrop(block(tree, 'a1'), at(tree, 'body', 0));
    expect(verdict).toEqual({
      kind: 'move',
      op: { op: 'move', field: 'body', locale: 'en-US', key: 'a1', to: { before: 'h1' } },
      label: 'Moved Call to action up',
    });
    if (verdict.kind !== 'move') return;
    const r = applyOps(pageType, fields, [verdict.op], () => 'x', { label: verdict.label, at: 0 });
    if (!r.ok) throw new Error('refused');
    expect(keysIn(r.fields, (b) => b)).toEqual(['a1', 'h1', 's1', 's2']);
    const history = record(EMPTY_HISTORY, r.step);
    const back = undo(pageType, r.fields, history);
    if (!back.ok) throw new Error('no undo');
    expect(back.fields).toEqual(fields);
    expect(back.history.future).toHaveLength(1);
  });

  it('moves to another slot that takes it, and the move undoes across slots', () => {
    const fields = twoSections();
    const tree = treeOf(fields);
    const verdict = judgeDrop(block(tree, 'c3'), at(tree, 'body[s1].items', 0));
    expect(verdict).toMatchObject({
      kind: 'move',
      op: { op: 'move', key: 'c3', to: { parent: { key: 's1', slot: 'items' }, before: 'c1' } },
      label: 'Moved Card to Items',
    });
    if (verdict.kind !== 'move') return;
    const r = applyOps(pageType, fields, [verdict.op], () => 'x', { label: verdict.label, at: 0 });
    if (!r.ok) throw new Error('refused');
    const items = (key: string) => (b: Record<string, unknown>[]) =>
      (b.find((x) => x._key === key)?.items ?? []) as unknown[];
    expect(keysIn(r.fields, items('s1'))).toEqual(['c3', 'c1']);
    expect(keysIn(r.fields, items('s2'))).toEqual(['c2']);
    const back = undo(pageType, r.fields, record(EMPTY_HISTORY, r.step));
    expect(back.ok && back.fields).toEqual(fields);
  });

  it('changes nothing at its own place, either side of it', () => {
    const tree = treeOf(twoSections());
    expect(judgeDrop(block(tree, 's1'), at(tree, 'body', 1))).toEqual({ kind: 'home' });
    expect(judgeDrop(block(tree, 's1'), at(tree, 'body', 2))).toEqual({ kind: 'home' });
  });

  it('refuses a slot that doesn’t take it, and one inside itself', () => {
    const tree = treeOf(twoSections());
    expect(judgeDrop(block(tree, 'h1'), at(tree, 'body[s1].items', 0))).toEqual({
      kind: 'refused',
      reason: 'Items doesn’t take Hero',
    });
    expect(judgeDrop(block(tree, 'c1'), at(tree, 'body', 0))).toEqual({
      kind: 'refused',
      reason: 'Main doesn’t take Card',
    });
    expect(judgeDrop(block(tree, 's1'), at(tree, 'body[s1].items', 0))).toEqual({
      kind: 'refused',
      reason: 'Section can’t go inside itself',
    });
  });

  it('refuses a full slot, and lets a slot go short as a remove does', () => {
    const fields = twoSections();
    const tree = treeOf(fields);
    // s2's items hold two of two.
    expect(judgeDrop(block(tree, 'c1'), at(tree, 'body[s2].items', 0))).toEqual({
      kind: 'refused',
      reason: 'Items is full (2 at most)',
    });
    // c1 is s1's only card and its items need one: it may leave all the same (where there's
    // room), and the checks say s1 is short, as after a remove; the API's block patch agrees.
    const t = treeOf(dropCard(twoSections(), 's2'));
    expect(judgeDrop(block(t, 'c1'), at(t, 'body[s2].items', 0)).kind).toBe('move');
    // Within its own slot, a full one still reorders.
    expect(judgeDrop(block(tree, 'c3'), at(tree, 'body[s2].items', 0)).kind).toBe('move');
  });

  it('refuses another blocks field: a move is its own field’s', () => {
    const fields: EntryFields = {
      ...pageFields(),
      aside: { 'en-US': [{ _type: 'cta', _key: 'x1', label: 'More' }] },
    };
    const tree = treeOf(fields, undefined, twoFields);
    expect(judgeDrop(block(tree, 'a1'), at(tree, 'aside', 0))).toEqual({
      kind: 'refused',
      reason: 'Aside is another field’s: a block moves only within its own field',
    });
  });

  it('refuses what the block config narrows away, and a slot it locks, in and out', () => {
    const slotted = {
      ...catalog,
      version: 2,
      blocks: catalog.blocks.map((b) =>
        b.id === 'section'
          ? { ...b, slots: [{ apiId: 'items', name: 'Items', allowedChildren: ['card'], max: 2 }] }
          : b,
      ),
    } as BlockCatalog;
    const fields = twoSections();
    const narrowed = effectiveBlockRules(slotted, {
      ...EMPTY_BLOCK_CONFIG,
      version: 1,
      targets: [{ contentTypeApiId: 'page', field: 'body', blocks: ['hero', 'section'] }],
    });
    const tree = treeOf(fields, { rules: narrowed, stored: fields });
    // The call to action stays where it is stored, but the config takes no new one at the top:
    // a move into Main from elsewhere would be a new placement; a reorder within it is not.
    expect(judgeDrop(block(tree, 'a1'), at(tree, 'body', 0)).kind).toBe('move');

    const locked = effectiveBlockRules(slotted, {
      ...EMPTY_BLOCK_CONFIG,
      version: 1,
      blocks: [{ block: 'section', slots: { items: { locked: true } } }],
    });
    const t = treeOf(fields, { rules: locked, stored: fields });
    expect(canDrag(block(t, 'c3'))).toBe(false);
    expect(judgeDrop(block(t, 'c3'), at(t, 'body[s1].items', 0))).toEqual({
      kind: 'refused',
      reason: 'Items is locked: Card keeps its place',
    });
    expect(judgeDrop(block(t, 'h1'), at(t, 'body[s1].items', 0))).toMatchObject({
      kind: 'refused',
    });
  });

  it('refuses a locked region: its blocks keep their place, and nothing goes between them', () => {
    const fields = twoSections();
    const lock: EntryBlockLock = {
      field: 'body',
      keys: ['s1', 's2'],
      depth: 'self',
      freeze: 'structure',
      lockedBy: 'user:1',
      lockedAt: '2026-11-09T10:00:00Z',
    };
    const tree = treeOf(fields, { rules: undefined, stored: fields, locks: [lock] });
    expect(canDrag(block(tree, 's1'))).toBe(false);
    expect(judgeDrop(block(tree, 's1'), at(tree, 'body', 4))).toEqual({
      kind: 'refused',
      reason: 'Section is locked: it keeps its place',
    });
    expect(judgeDrop(block(tree, 'a1'), at(tree, 'body', 2))).toEqual({
      kind: 'refused',
      reason: 'That place is inside a locked region',
    });
    // Outside the run is open.
    expect(judgeDrop(block(tree, 'a1'), at(tree, 'body', 0)).kind).toBe('move');
  });

  it('never picks up a block the code removed', () => {
    const fields = pageFields();
    const body = fields.body?.['en-US'] as unknown[];
    body.push({ _type: 'gone', _key: 'g1' });
    const tree = treeOf(fields);
    expect(canDrag(block(tree, 'g1'))).toBe(false);
    expect(judgeDrop(block(tree, 'g1'), at(tree, 'body', 0))).toEqual({
      kind: 'refused',
      reason: 'gone was removed from code, so it can’t move',
    });
  });
});

describe('Move to', () => {
  it('lists every other slot of the field that takes the block, at its end', () => {
    // s1's items hold one of two: room for c2, which s2 can spare.
    const tree = treeOf(twoSections());
    expect(moveTargets(tree, block(tree, 'c2')).map((t) => [t.slot.path, t.op])).toEqual([
      [
        'body[s1].items',
        {
          op: 'move',
          field: 'body',
          locale: 'en-US',
          key: 'c2',
          to: { parent: { key: 's1', slot: 'items' }, after: 'c1' },
        },
      ],
    ]);
    // A top-level block has nowhere else to go in this field; s2's items are full for c1.
    expect(moveTargets(tree, block(tree, 'h1'))).toEqual([]);
    expect(moveTargets(tree, block(tree, 'c1'))).toEqual([]);
  });
});

describe('the config judging a moved draft', () => {
  it('names an issue the move adds, and none that was there before or moved along', () => {
    const before = pageFields();
    const after = twoSections();
    const issue = (over: Partial<BlockConfigIssue>): BlockConfigIssue => ({
      code: 'slot_too_few',
      field: 'body[1].items',
      message: 'Items needs at least 1 block here',
      ...over,
    });
    // The same issue at a new path (the slot moved down a place) is not a new one.
    const was = [issue({})];
    const now = [issue({ field: 'body[2].items' })];
    expect(configRefusal((f) => (f === before ? was : now), before, after)).toBeUndefined();
    const more = [...now, issue({ code: 'slot_locked', field: 'body[2].items' })];
    expect(configRefusal((f) => (f === before ? was : more), before, after)?.code).toBe(
      'slot_locked',
    );
  });

  it('passes a move the save would take, judged by the canvas’s own config issues', () => {
    const fields = twoSections();
    const rules = effectiveBlockRules(catalog, EMPTY_BLOCK_CONFIG);
    const tree = treeOf(fields, { rules, stored: fields });
    const verdict = judgeDrop(block(tree, 'c3'), at(tree, 'body[s1].items', 1));
    if (verdict.kind !== 'move') throw new Error('refused');
    const r = applyOps(pageType, fields, [verdict.op], () => 'x', { label: '', at: 0 });
    if (!r.ok) throw new Error('refused');
    const judge = (f: EntryFields) =>
      configIssues(pageType, catalog, rules, fields, f, ['en-US'], []);
    expect(configRefusal(judge, fields, r.fields)).toBeUndefined();
  });
});
