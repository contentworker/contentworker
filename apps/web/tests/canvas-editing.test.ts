/**
 * The canvas editor's model, without a screen: the slot tree, seams from the page's geometry
 * (refs checked, places by key), the dock filtered by slot rules, block-patch ops with their
 * inverses, the undo history and the checks a save needs.
 */
import { applyBlockPatch, type EntryFields } from '@contentworker/domain';
import { describe, expect, it } from 'vitest';
import { canvasChecks } from '~/cms/lib/canvas/checks';
import { dockGroups } from '~/cms/lib/canvas/dock';
import { applyOps, BURST_MS, EMPTY_HISTORY, record, redo, undo } from '~/cms/lib/canvas/history';
import {
  blockPlace,
  canvasAvailable,
  duplicateOp,
  findBlock,
  findSlot,
  flattenBlocks,
  insertOp,
  moveOp,
  newBlock,
  placeAfter,
  removeOp,
  setPropOp,
  slotFill,
} from '~/cms/lib/canvas/model';
import { blockKeyOfRef, blockRects, seamsFrom } from '~/cms/lib/canvas/seams';
import type { FrameGeometry } from '~/cms/lib/live-preview/frame-channel';
import { card, catalog, pageFields, pageType, ref, refCtx, tree } from './canvas-fixture';

const rect = (y: number, h = 10) => ({ x: 0, y, w: 100, h });
const body = (fields: EntryFields) => fields.body?.['en-US'] as Record<string, unknown>[];
let n = 0;
const key = () => `k${++n}`;

describe('the slot tree', () => {
  it('reads every blocks field and every slot a block declares, with its fill', () => {
    const slots = tree();
    expect(slots.map((s) => s.path)).toEqual(['body']);
    const main = slots[0];
    expect(main?.blocks.map((b) => b.key)).toEqual(['h1', 's1', 'a1']);
    expect(slotFill(main as NonNullable<typeof main>)).toBe('Main · 3 of 8');
    const items = findSlot(slots, 'body[s1].items');
    expect(items?.address).toEqual({ field: 'body', parent: { key: 's1', slot: 'items' } });
    expect(items && slotFill(items)).toBe('Items · 1 of 1–2');
    expect(flattenBlocks(slots).map((b) => b.key)).toEqual(['h1', 's1', 'c1', 'a1']);
  });

  it('says how full a slot is, with its least and its most', () => {
    const slot = findSlot(tree(), 'body[s1].items') as NonNullable<ReturnType<typeof findSlot>>;
    const at = (over: Partial<typeof slot>, n: number) =>
      slotFill({
        ...slot,
        ...over,
        blocks: slot.blocks.slice(0, 0).concat(Array(n).fill(slot.blocks[0])),
      });
    expect(at({ name: 'Features', min: 2, max: 4, full: false }, 0)).toBe('Features · 0 of 2–4');
    expect(at({ name: 'Features', min: undefined, max: 4, full: false }, 0)).toBe(
      'Features · 0 of 4',
    );
    expect(at({ name: 'Features', min: 4, max: 4, full: false }, 1)).toBe('Features · 1 of 4');
    expect(at({ name: 'Features', min: 2, max: 4, full: true }, 4)).toBe('Features · full, 4 of 4');
    expect(at({ name: 'Features', min: 2, max: undefined, full: false }, 1)).toBe(
      'Features · 1 block, needs 2',
    );
    expect(at({ name: 'Features', min: 2, max: undefined, full: false }, 2)).toBe(
      'Features · 2 blocks',
    );
    expect(at({ name: 'Features', min: undefined, max: undefined, full: false }, 0)).toBe(
      'Features · 0 blocks',
    );
  });

  it('marks a block whose type the slot no longer takes as removed from code', () => {
    const fields = pageFields();
    body(fields).push({ _type: 'gone', _key: 'g1' });
    const gone = findBlock(tree(fields), 'g1');
    expect(gone?.variant).toBeUndefined();
    expect(gone?.name).toBe('gone');
  });

  it('is only on offer for a type with a preview URL and a blocks field', () => {
    expect(canvasAvailable(pageType)).toBe(true);
    expect(canvasAvailable({ ...pageType, preview: undefined })).toBe(false);
    expect(canvasAvailable({ ...pageType, fields: pageType.fields.slice(0, 1) })).toBe(false);
  });
});

describe('seams from the page’s geometry', () => {
  const geometry = (slots: FrameGeometry['slots'], blocks: FrameGeometry['blocks'] = []) => ({
    blocks,
    slots,
    truncated: false,
  });

  it('places each gap by the keys either side, and drops what the entry doesn’t have', () => {
    const slots = tree();
    const seams = seamsFrom(
      geometry([
        {
          ref: ref('body'),
          rect: rect(0, 300),
          gaps: [
            { index: 0, axis: 'y', before: 'h1', rect: rect(0, 0) },
            { index: 1, axis: 'y', after: 'h1', before: 's1', rect: rect(50) },
            // A block the page renders that the entry doesn't hold: no place to put it.
            { index: 2, axis: 'y', after: 'ghost', rect: rect(150) },
            { index: 3, axis: 'y', after: 'a1', rect: rect(290) },
          ],
        },
        {
          ref: ref('body[s1].items'),
          rect: rect(60, 80),
          gaps: [{ index: 1, axis: 'y', after: 'c1', rect: rect(130) }],
        },
      ]),
      slots,
      refCtx,
    );
    expect(seams.map((s) => s.id)).toEqual(['body#0', 'body#1', 'body#3', 'body[s1].items#1']);
    expect(blockPlace(seams[1] as (typeof seams)[number])).toEqual({ after: 'h1' });
    expect(blockPlace(seams[3] as (typeof seams)[number])).toEqual({
      parent: { key: 's1', slot: 'items' },
      after: 'c1',
    });
  });

  it('draws nothing for a slot ref naming another entry, space, type or locale, or no slot', () => {
    const slots = tree();
    const gap = { index: 0, axis: 'y' as const, before: 'h1', rect: rect(0) };
    for (const r of [
      ref('body', { entryId: 'other' }),
      ref('body', { space: 'other' }),
      ref('body', { environment: 'staging' }),
      ref('body', { contentType: 'post' }),
      ref('body', { locale: 'de-DE' }),
      ref('title'),
      ref('body[s1].nope'),
      'not a ref',
    ]) {
      expect(seamsFrom(geometry([{ ref: r, rect: rect(0), gaps: [gap] }]), slots, refCtx)).toEqual(
        [],
      );
    }
  });

  it('finds the block a click or a box names, through the fields inside it', () => {
    const slots = tree();
    expect(blockKeyOfRef(ref('body[s1].items[c1].title'), slots, refCtx)).toBe('c1');
    expect(blockKeyOfRef(ref('body[h1]'), slots, refCtx)).toBe('h1');
    expect(blockKeyOfRef(ref('body[nope]'), slots, refCtx)).toBeUndefined();
    expect(blockKeyOfRef(ref('body[h1]', { entryId: 'x' }), slots, refCtx)).toBeUndefined();
    const rects = blockRects(
      geometry([], [{ ref: ref('body[a1]'), rect: rect(200) }]),
      slots,
      refCtx,
    );
    expect(rects.get('a1')).toEqual(rect(200));
  });
});

describe('the dock', () => {
  it('offers exactly what the slot takes, grouped and described by the catalog', () => {
    const groups = dockGroups(tree()[0] as ReturnType<typeof tree>[number], catalog);
    expect(groups.map((g) => [g.group, g.items.map((i) => i.name)])).toEqual([
      [undefined, ['Section']],
      ['Headers', ['Hero banner']],
      ['Actions', ['Call to action']],
    ]);
    expect(groups[1]?.items[0]?.description).toBe('A big opening');
    // Cards go only in a section's items: never offered at the top level.
    expect(groups.flatMap((g) => g.items.map((i) => i.variant.apiId))).not.toContain('card');
    const items = findSlot(tree(), 'body[s1].items');
    expect(dockGroups(items as NonNullable<typeof items>, catalog)).toEqual([
      { items: [{ variant: card, name: 'Card' }] },
    ]);
  });

  it('names each block by its variant when there is no catalog', () => {
    const groups = dockGroups(tree()[0] as ReturnType<typeof tree>[number], null);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map((i) => i.name)).toEqual(['Hero', 'Call to action', 'Section']);
  });

  it('offers nothing in a full slot', () => {
    const fields = pageFields();
    const section = body(fields)[1] as { items: unknown[] };
    section.items.push({ _type: 'card', _key: 'c2', title: 'Kind' });
    const items = findSlot(tree(fields), 'body[s1].items');
    expect(items?.full).toBe(true);
    expect(items && slotFill(items)).toBe('Items · full, 2 of 2');
    expect(dockGroups(items as NonNullable<typeof items>, catalog)).toEqual([]);
  });
});

describe('ops and their inverses', () => {
  const meta = { label: 'test', at: 0 };
  const run = (fields: EntryFields, ops: Parameters<typeof applyOps>[2]) => {
    const r = applyOps(pageType, fields, ops, key, meta);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    // The inverse, applied to the result, gives the fields back.
    const back = applyBlockPatch(pageType, r.fields, r.step.inverse, () => {
      throw new Error('an inverse never mints a key');
    });
    expect(back.ok && back.fields.body).toEqual(fields.body);
    return r;
  };

  it('inserts a new block at a seam, keyed, in the applied form', () => {
    const fields = pageFields();
    const slots = tree(fields);
    const made = newBlock(card, key);
    const items = findSlot(slots, 'body[s1].items');
    const r = run(fields, [insertOp({ slot: items as NonNullable<typeof items>, index: 1 }, made)]);
    const section = body(r.fields)[1] as { items: { _key: string }[] };
    expect(section.items.map((b) => b._key)).toEqual(['c1', made._key]);
    expect(r.step.ops[0]).toMatchObject({ op: 'insert', block: { _key: made._key } });
  });

  it('inserts at the top of a slot, and after the selected block with /', () => {
    const fields = pageFields();
    const slots = tree(fields);
    const hero = findBlock(slots, 'h1');
    expect(placeAfter(slots, hero)).toMatchObject({ index: 1 });
    expect(placeAfter(slots, undefined)).toMatchObject({ index: 3 });
    const made = newBlock(card, key);
    const items = findSlot(slots, 'body[s1].items') as NonNullable<ReturnType<typeof findSlot>>;
    expect(blockPlace({ slot: items, index: 0 })).toEqual({
      parent: { key: 's1', slot: 'items' },
      before: 'c1',
    });
    const r = run(fields, [insertOp({ slot: items, index: 0 }, made)]);
    expect((body(r.fields)[1] as { items: { _key: string }[] }).items[0]?._key).toBe(made._key);
  });

  it('moves a block up and down its slot, and not past either end', () => {
    const fields = pageFields();
    const slots = tree(fields);
    const hero = findBlock(slots, 'h1') as NonNullable<ReturnType<typeof findBlock>>;
    expect(moveOp(hero, -1)).toBeUndefined();
    const down = run(fields, [moveOp(hero, 1) as NonNullable<ReturnType<typeof moveOp>>]);
    expect(body(down.fields).map((b) => b._key)).toEqual(['s1', 'h1', 'a1']);
    const cta = findBlock(slots, 'a1') as NonNullable<ReturnType<typeof findBlock>>;
    expect(moveOp(cta, 1)).toBeUndefined();
  });

  it('removes and duplicates a block, the copy keyed afresh', () => {
    const fields = pageFields();
    const slots = tree(fields);
    const section = findBlock(slots, 's1') as NonNullable<ReturnType<typeof findBlock>>;
    const removed = run(fields, [removeOp(section)]);
    expect(body(removed.fields).map((b) => b._key)).toEqual(['h1', 'a1']);
    const copied = run(fields, [duplicateOp(section)]);
    const keys = body(copied.fields).map((b) => b._key);
    expect(keys).toHaveLength(4);
    expect(keys[2]).not.toBe('s1');
    // Its card is copied under a new key too.
    const copy = body(copied.fields)[2] as { items: { _key: string }[] };
    expect(copy.items[0]?._key).not.toBe('c1');
  });

  it('sets and clears a prop', () => {
    const fields = pageFields();
    const hero = findBlock(tree(fields), 'h1') as NonNullable<ReturnType<typeof findBlock>>;
    const dark = run(fields, [setPropOp(hero, 'tone', 'dark')]);
    expect(body(dark.fields)[0]).toMatchObject({ tone: 'dark' });
    const cleared = run(fields, [setPropOp(hero, 'tone', undefined)]);
    expect(body(cleared.fields)[0]).not.toHaveProperty('tone');
  });

  it('refuses an op that can’t apply, with the domain’s issue', () => {
    const fields = pageFields();
    const r = applyOps(
      pageType,
      fields,
      [{ op: 'remove', field: 'body', locale: 'en-US', key: 'nope' }],
      key,
      meta,
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.issues[0]?.code).toBe('unknown_key');
  });
});

describe('the undo history', () => {
  it('undoes and redoes through inverse ops, keys and all', () => {
    const start = pageFields();
    const hero = findBlock(tree(start), 'h1') as NonNullable<ReturnType<typeof findBlock>>;
    const r = applyOps(pageType, start, [removeOp(hero)], key, { label: 'Removed Hero', at: 0 });
    if (!r.ok) throw new Error('remove');
    const history = record(EMPTY_HISTORY, r.step);
    const back = undo(pageType, r.fields, history);
    if (!back.ok) throw new Error('undo');
    expect(back.fields.body).toEqual(start.body);
    expect(back.history).toEqual({ past: [], future: [r.step] });
    const again = redo(pageType, back.fields, back.history);
    if (!again.ok) throw new Error('redo');
    expect(again.fields.body).toEqual(r.fields.body);
    expect(undo(pageType, start, EMPTY_HISTORY).ok).toBe(false);
    expect(redo(pageType, start, EMPTY_HISTORY).ok).toBe(false);
  });

  it('keeps typing in one prop as one step, and a new edit forgets redo', () => {
    const start = pageFields();
    let fields = start;
    let history = EMPTY_HISTORY;
    for (const [i, text] of ['W', 'Wo', 'Wow'].entries()) {
      const hero = findBlock(tree(fields), 'h1') as NonNullable<ReturnType<typeof findBlock>>;
      const r = applyOps(pageType, fields, [setPropOp(hero, 'heading', text)], key, {
        label: 'Edited Hero',
        burst: 'h1:heading',
        at: i * 100,
      });
      if (!r.ok) throw new Error('set');
      fields = r.fields;
      history = record(history, r.step);
    }
    expect(history.past).toHaveLength(1);
    const back = undo(pageType, fields, history);
    expect(back.ok && back.fields.body).toEqual(start.body);

    // Past the burst, a new step; and a new edit after an undo clears what could be redone.
    const hero = findBlock(tree(fields), 'h1') as NonNullable<ReturnType<typeof findBlock>>;
    const later = applyOps(pageType, fields, [setPropOp(hero, 'heading', 'Hi')], key, {
      label: 'Edited Hero',
      burst: 'h1:heading',
      at: 200 + BURST_MS + 1,
    });
    if (!later.ok) throw new Error('later');
    expect(record(history, later.step).past).toHaveLength(2);
    expect(record({ past: [], future: [later.step] }, later.step).future).toEqual([]);
  });
});

describe('checks before a save', () => {
  const config = { locales: ['en-US'], defaultLocale: 'en-US', locale: 'en-US' };

  it('says what only the form can fix, for the form', () => {
    const titled = {
      ...pageType,
      fields: pageType.fields.map((f) => (f.apiId === 'title' ? { ...f, required: true } : f)),
    };
    const fields = pageFields();
    delete fields.title;
    expect(canvasChecks(titled, fields, tree(fields), config)).toEqual([
      { id: 'issue:0', message: 'Title (en-US): Field is required', inForm: true },
    ]);
  });

  it('says nothing of a page that would save', () => {
    expect(canvasChecks(pageType, pageFields(), tree(), config)).toEqual([]);
  });

  it('lists a required slot left empty once, by name, pointing at the block that holds it', () => {
    const fields = pageFields();
    (body(fields)[1] as { items: unknown[] }).items = [];
    const checks = canvasChecks(pageType, fields, tree(fields), config);
    expect(checks).toEqual([
      { id: 'min:body[s1].items', message: 'Items needs a block', blockKey: 's1' },
    ]);
  });

  it('lists a block removed from code, and an empty required prop on its block', () => {
    const fields = pageFields();
    body(fields).push({ _type: 'gone', _key: 'g1' });
    (body(fields)[0] as Record<string, unknown>).heading = undefined;
    const checks = canvasChecks(pageType, fields, tree(fields), config);
    expect(checks.map((c) => [c.blockKey, c.message])).toEqual([
      ['g1', 'gone in Main was removed from code: remove it to save'],
      ['h1', expect.stringMatching(/^Hero: /)],
    ]);
  });
});
