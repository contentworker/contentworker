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
  type ComponentVariant,
  type ContentType,
  EMPTY_BLOCK_CONFIG,
  type EntryFields,
  effectiveBlockRules,
  type FieldDefinition,
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

const body = pageType.fields.find((f) => f.apiId === 'body');
const bodyVariants = (body?.items?.variants ?? []) as ComponentVariant[];

/**
 * The same type with a second blocks field, `aside`, taking calls to action and sections as Main
 * defines them (most three), with `over` changing the field.
 */
const twoFields = (over: Partial<FieldDefinition> = {}, variants = bodyVariants) =>
  ({
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
        validations: { size: { max: 3 } },
        items: {
          type: 'Component',
          variants: variants.filter((v) => v.apiId === 'cta' || v.apiId === 'section'),
        },
        ...over,
      },
    ],
  }) as unknown as ContentType;

/** The fixture page with an aside holding one call to action. */
const withAside = (aside: unknown[] = [{ _type: 'cta', _key: 'x1', label: 'More' }]) => ({
  ...pageFields(),
  aside: { 'en-US': aside },
});

/** The block of Main keyed `key`, to change in place. */
function bodyBlock(fields: EntryFields, key: string): Record<string, unknown> {
  const found = ((fields.body?.['en-US'] ?? []) as Record<string, unknown>[]).find(
    (b) => b._key === key,
  );
  if (!found) throw new Error(`no block ${key}`);
  return found;
}

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
    const verdict = judgeDrop(block(tree, 'a1'), at(tree, 'body', 0), tree);
    expect(verdict).toEqual({
      kind: 'move',
      ops: [{ op: 'move', field: 'body', locale: 'en-US', key: 'a1', to: { before: 'h1' } }],
      label: 'Moved Call to action up',
    });
    if (verdict.kind !== 'move') return;
    const r = applyOps(pageType, fields, verdict.ops, () => 'x', { label: verdict.label, at: 0 });
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
    const verdict = judgeDrop(block(tree, 'c3'), at(tree, 'body[s1].items', 0), tree);
    expect(verdict).toMatchObject({
      kind: 'move',
      ops: [{ op: 'move', key: 'c3', to: { parent: { key: 's1', slot: 'items' }, before: 'c1' } }],
      label: 'Moved Card to Items',
    });
    if (verdict.kind !== 'move') return;
    const r = applyOps(pageType, fields, verdict.ops, () => 'x', { label: verdict.label, at: 0 });
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
    expect(judgeDrop(block(tree, 's1'), at(tree, 'body', 1), tree)).toEqual({ kind: 'home' });
    expect(judgeDrop(block(tree, 's1'), at(tree, 'body', 2), tree)).toEqual({ kind: 'home' });
  });

  it('refuses a slot that doesn’t take it, and one inside itself', () => {
    const tree = treeOf(twoSections());
    expect(judgeDrop(block(tree, 'h1'), at(tree, 'body[s1].items', 0), tree)).toEqual({
      kind: 'refused',
      reason: 'Items doesn’t take Hero',
    });
    expect(judgeDrop(block(tree, 'c1'), at(tree, 'body', 0), tree)).toEqual({
      kind: 'refused',
      reason: 'Main doesn’t take Card',
    });
    expect(judgeDrop(block(tree, 's1'), at(tree, 'body[s1].items', 0), tree)).toEqual({
      kind: 'refused',
      reason: 'Section can’t go inside itself',
    });
  });

  it('refuses a full slot, and lets a slot go short as a remove does', () => {
    const fields = twoSections();
    const tree = treeOf(fields);
    // s2's items hold two of two.
    expect(judgeDrop(block(tree, 'c1'), at(tree, 'body[s2].items', 0), tree)).toEqual({
      kind: 'refused',
      reason: 'Items is full (2 at most)',
    });
    // c1 is s1's only card and its items need one: it may leave all the same (where there's
    // room), and the checks say s1 is short, as after a remove; the API's block patch agrees.
    const t = treeOf(dropCard(twoSections(), 's2'));
    expect(judgeDrop(block(t, 'c1'), at(t, 'body[s2].items', 0), t).kind).toBe('move');
    // Within its own slot, a full one still reorders.
    expect(judgeDrop(block(tree, 'c3'), at(tree, 'body[s2].items', 0), tree).kind).toBe('move');
  });

  it('moves into another blocks field as a remove and an insert, one step undo takes back', () => {
    const type = twoFields();
    const fields = withAside();
    const tree = treeOf(fields, undefined, type);
    const verdict = judgeDrop(block(tree, 'a1'), at(tree, 'aside', 0), tree);
    const a1 = { _type: 'cta', _key: 'a1', label: 'Start' };
    expect(verdict).toEqual({
      kind: 'move',
      ops: [
        { op: 'remove', field: 'body', locale: 'en-US', key: 'a1' },
        { op: 'insert', field: 'aside', locale: 'en-US', block: a1, before: 'x1' },
      ],
      label: 'Moved Call to action to Aside',
    });
    if (verdict.kind !== 'move') return;
    const r = applyOps(type, fields, verdict.ops, () => 'minted', { label: verdict.label, at: 0 });
    if (!r.ok) throw new Error('refused');
    // Carried whole, under its own key: nothing is minted.
    expect(r.fields.aside?.['en-US']).toEqual([a1, { _type: 'cta', _key: 'x1', label: 'More' }]);
    expect(keysIn(r.fields, (b) => b)).toEqual(['h1', 's1']);
    const history = record(EMPTY_HISTORY, r.step);
    expect(history.past).toHaveLength(1);
    const back = undo(type, r.fields, history);
    expect(back.ok && back.fields).toEqual(fields);
  });

  it('carries the blocks inside it, with their keys and overrides, into another field', () => {
    // Both fields take overrides at Tablet, as a catalog push writes its breakpoints on each.
    const md = [{ id: 'md', name: 'Tablet', minWidth: 768 }];
    const withMd = (f: FieldDefinition) =>
      ({ ...f, items: { ...f.items, breakpoints: md } }) as FieldDefinition;
    const type = twoFields();
    const both = {
      ...type,
      fields: type.fields.map((f) => (f.apiId === 'title' ? f : withMd(f))),
    } as ContentType;
    const fields = pageFields();
    const s1 = bodyBlock(fields, 's1');
    s1._responsive = { md: { heading: 'x' } };
    const tree = treeOf(fields, undefined, both);
    const verdict = judgeDrop(block(tree, 's1'), at(tree, 'aside', 0), tree);
    expect(verdict.kind).toBe('move');
    if (verdict.kind !== 'move') return;
    const r = applyOps(both, fields, verdict.ops, () => 'minted', { label: '', at: 0 });
    if (!r.ok) throw new Error(r.issues[0]?.message);
    expect(r.fields.aside?.['en-US']).toEqual([s1]);
    const moved = treeOf(r.fields, undefined, both);
    expect(findBlock(moved, 'c1')?.slot.path).toBe('aside[s1].items');
  });

  it('lists another field’s slots in Move to', () => {
    const tree = treeOf(withAside(), undefined, twoFields());
    expect(moveTargets(tree, block(tree, 'a1')).map((t) => t.slot.path)).toEqual(['aside']);
    // A card goes only into a section's items, in either field.
    const t = treeOf(
      withAside([{ _type: 'section', _key: 's9', heading: 'Side', items: [] }]),
      undefined,
      twoFields(),
    );
    expect(moveTargets(t, block(t, 'c1')).map((x) => x.slot.path)).toEqual(['aside[s9].items']);
  });

  it('refuses another field that would change the block: its kind, its definition, a key it holds', () => {
    const translated = twoFields({ localized: true });
    let tree = treeOf(withAside(), undefined, translated);
    expect(judgeDrop(block(tree, 'a1'), at(tree, 'aside', 0), tree)).toEqual({
      kind: 'refused',
      reason: 'Aside is translated and Main isn’t: add a new Call to action there',
    });

    // A call to action modelled apart by hand, under the same apiId.
    const other = twoFields({}, [
      { apiId: 'cta', name: 'Call to action', fields: [] } as unknown as ComponentVariant,
    ]);
    tree = treeOf(withAside(), undefined, other);
    expect(judgeDrop(block(tree, 'a1'), at(tree, 'aside', 0), tree)).toEqual({
      kind: 'refused',
      reason: 'Aside’s Call to action is set up differently: add a new one there',
    });

    // The aside already holds a block keyed `a1` (a key is unique only within its field).
    tree = treeOf(withAside([{ _type: 'cta', _key: 'a1', label: 'Twin' }]), undefined, twoFields());
    expect(judgeDrop(block(tree, 'a1'), at(tree, 'aside', 0), tree)).toEqual({
      kind: 'refused',
      reason: 'Aside already has a copy of this Call to action: add a new one there',
    });
    // So does one of the section's cards, deep inside: the section can't go either.
    tree = treeOf(
      withAside([
        {
          _type: 'section',
          _key: 's9',
          heading: 'Side',
          items: [{ _type: 'card', _key: 'c1', title: 'Twin' }],
        },
      ]),
      undefined,
      twoFields(),
    );
    expect(judgeDrop(block(tree, 's1'), at(tree, 'aside', 0), tree)).toMatchObject({
      kind: 'refused',
      reason: 'Aside already has a copy of this Section: add a new one there',
    });
  });

  it('refuses another field without the breakpoints its overrides are set at', () => {
    const fields = withAside();
    const a1 = bodyBlock(fields, 'a1');
    a1._responsive = { md: { label: 'Go' } };
    const tree = treeOf(fields, undefined, twoFields());
    expect(judgeDrop(block(tree, 'a1'), at(tree, 'aside', 0), tree)).toEqual({
      kind: 'refused',
      reason: 'Aside doesn’t take Call to action’s per-width settings: they’d be lost',
    });
  });

  it('holds another field to its own counts and the block config, as any other slot', () => {
    const full = withAside([
      { _type: 'cta', _key: 'x1', label: 'One' },
      { _type: 'cta', _key: 'x2', label: 'Two' },
      { _type: 'cta', _key: 'x3', label: 'Three' },
    ]);
    const tree = treeOf(full, undefined, twoFields());
    expect(judgeDrop(block(tree, 'a1'), at(tree, 'aside', 0), tree)).toEqual({
      kind: 'refused',
      reason: 'Aside is full (3 at most)',
    });
    // A hero isn't one of the aside's blocks at all.
    expect(judgeDrop(block(tree, 'h1'), at(tree, 'aside', 0), tree)).toEqual({
      kind: 'refused',
      reason: 'Aside doesn’t take Hero',
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
    expect(judgeDrop(block(tree, 'a1'), at(tree, 'body', 0), tree).kind).toBe('move');

    const locked = effectiveBlockRules(slotted, {
      ...EMPTY_BLOCK_CONFIG,
      version: 1,
      blocks: [{ block: 'section', slots: { items: { locked: true } } }],
    });
    const t = treeOf(fields, { rules: locked, stored: fields });
    expect(canDrag(block(t, 'c3'))).toBe(false);
    expect(judgeDrop(block(t, 'c3'), at(t, 'body[s1].items', 0), t)).toEqual({
      kind: 'refused',
      reason: 'Items is locked: Card keeps its place',
    });
    expect(judgeDrop(block(t, 'h1'), at(t, 'body[s1].items', 0), t)).toMatchObject({
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
    expect(judgeDrop(block(tree, 's1'), at(tree, 'body', 4), tree)).toEqual({
      kind: 'refused',
      reason: 'Section is locked: it keeps its place',
    });
    expect(judgeDrop(block(tree, 'a1'), at(tree, 'body', 2), tree)).toEqual({
      kind: 'refused',
      reason: 'That place is inside a locked region',
    });
    // Outside the run is open.
    expect(judgeDrop(block(tree, 'a1'), at(tree, 'body', 0), tree).kind).toBe('move');
  });

  it('never picks up a block the code removed', () => {
    const fields = pageFields();
    const body = fields.body?.['en-US'] as unknown[];
    body.push({ _type: 'gone', _key: 'g1' });
    const tree = treeOf(fields);
    expect(canDrag(block(tree, 'g1'))).toBe(false);
    expect(judgeDrop(block(tree, 'g1'), at(tree, 'body', 0), tree)).toEqual({
      kind: 'refused',
      reason: 'gone was removed from code, so it can’t move',
    });
  });
});

describe('Move to', () => {
  it('lists every other slot of the field that takes the block, at its end', () => {
    // s1's items hold one of two: room for c2, which s2 can spare.
    const tree = treeOf(twoSections());
    expect(moveTargets(tree, block(tree, 'c2')).map((t) => [t.slot.path, t.ops])).toEqual([
      [
        'body[s1].items',
        [
          {
            op: 'move',
            field: 'body',
            locale: 'en-US',
            key: 'c2',
            to: { parent: { key: 's1', slot: 'items' }, after: 'c1' },
          },
        ],
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
    const verdict = judgeDrop(block(tree, 'c3'), at(tree, 'body[s1].items', 1), tree);
    if (verdict.kind !== 'move') throw new Error('refused');
    const r = applyOps(pageType, fields, verdict.ops, () => 'x', { label: '', at: 0 });
    if (!r.ok) throw new Error('refused');
    const judge = (f: EntryFields) =>
      configIssues(pageType, catalog, rules, fields, f, ['en-US'], []);
    expect(configRefusal(judge, fields, r.fields)).toBeUndefined();
  });
});
