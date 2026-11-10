// Locked regions in the editors: what the entry's locks mean for each block on screen (in a region,
// inside one, frozen), the seams and moves they take away on the canvas, who is offered Lock, the
// list a Lock or an Unlock sends, and the words for a refusal.
import type { EntryFields } from '@contentworker/domain';
import { describe, expect, it } from 'vitest';
import {
  canLock,
  inLongRun,
  lockedLine,
  lockRefusal,
  lockSays,
  lockView,
  regionRefusal,
  sameRun,
  withLock,
  withoutLock,
} from '~/cms/lib/block-locks';
import { configIssues } from '~/cms/lib/block-rules';
import { configChecks } from '~/cms/lib/canvas/checks';
import {
  canDuplicate,
  canMove,
  canRemove,
  canvasTree,
  findBlock,
  findSlot,
  placeLockedBy,
  runBetween,
  slotFill,
} from '~/cms/lib/canvas/model';
import { regionRects, seamsFrom } from '~/cms/lib/canvas/seams';
import { ApiError, type EntryBlockLock, type PrincipalInfo } from '~/cms/lib/management';
import { pageFields, pageType, ref, refCtx } from './canvas-fixture';

const lock = (over: Partial<EntryBlockLock> & Pick<EntryBlockLock, 'keys'>): EntryBlockLock => ({
  field: 'body',
  depth: 'subtree',
  freeze: 'structure',
  lockedBy: 'user:1',
  lockedAt: '2026-11-09T10:00:00Z',
  ...over,
});

/** The fixture page with a second section after the first: h1, s1 [c1], s2 [c2], a1. */
function longPage(): EntryFields {
  const fields = pageFields();
  const body = fields.body!['en-US'] as unknown[];
  body.splice(2, 0, {
    _type: 'section',
    _key: 's2',
    heading: 'More',
    items: [{ _type: 'card', _key: 'c2', title: 'Safe' }],
  });
  return fields;
}

const view = (locks: EntryBlockLock[], fields = pageFields()) =>
  lockView(pageType, locks, fields, 'en-US', 'en-US');

const treeWith = (locks: EntryBlockLock[], fields = pageFields()) =>
  canvasTree(pageType, fields, 'en-US', 'en-US', { rules: undefined, stored: fields, locks });

describe('lockView', () => {
  it('marks a region’s blocks, and with `subtree` every block inside them', () => {
    const v = view([lock({ keys: ['s1'] })]);
    expect(v.regions).toHaveLength(1);
    expect(v.marks.get('s1')).toMatchObject({ own: true, sealed: true, frozen: false });
    expect(v.marks.get('c1')).toMatchObject({ own: false, sealed: true, frozen: false });
    expect(v.marks.has('h1')).toBe(false);
  });

  it('leaves the slots of an `Only this block` lock open, and freezes only what it says', () => {
    const v = view([lock({ keys: ['s1'], depth: 'self', freeze: 'all' })]);
    expect(v.marks.get('s1')).toMatchObject({ own: true, sealed: false, frozen: true });
    expect(v.marks.has('c1')).toBe(false);
    const all = view([lock({ keys: ['s1'], freeze: 'all' })]);
    expect(all.marks.get('c1')).toMatchObject({ frozen: true });
  });

  it('marks nothing for a lock whose run isn’t there: stale, broken up, or another locale’s', () => {
    expect(view([lock({ keys: ['gone'] })]).regions).toEqual([]);
    // h1 and a1 aren't neighbours.
    expect(view([lock({ keys: ['h1', 'a1'] })]).regions).toEqual([]);
    expect(view([lock({ field: 'title', keys: ['h1'] })]).regions).toEqual([]);
    expect(lockView(pageType, [lock({ keys: ['h1'] })], {}, 'en-US', 'en-US').regions).toEqual([]);
  });

  it('knows a run’s neighbours, so nothing goes between them', () => {
    const v = view([lock({ keys: ['h1', 's1'] })]);
    expect(sameRun(v, 'h1', 's1')).toBe(true);
    expect(sameRun(v, 's1', 'a1')).toBe(false);
    expect(sameRun(v, undefined, 'h1')).toBe(false);
    expect(inLongRun(v, 'h1')).toBe(true);
    expect(inLongRun(view([lock({ keys: ['h1'] })]), 'h1')).toBe(false);
  });
});

describe('the canvas under a lock', () => {
  it('keeps a region’s blocks in place: no move, duplicate or remove', () => {
    const tree = treeWith([lock({ keys: ['s1'] })]);
    const s1 = findBlock(tree, 's1');
    const c1 = findBlock(tree, 'c1');
    expect(s1 && (canMove(s1, -1) || canMove(s1, 1) || canRemove(s1) || canDuplicate(s1))).toBe(
      false,
    );
    // Inside it, the slot holds as a locked one does.
    expect(c1 && (canRemove(c1) || canDuplicate(c1))).toBe(false);
    expect(c1?.slot.sealedBy?.index).toBe(0);
    expect(slotFill(findSlot(tree, 'body[s1].items')!)).toBe('Items · 1 of 1–2 · locked');
    // The blocks around it still move, but not past it into a run.
    const h1 = findBlock(tree, 'h1');
    expect(h1 && canRemove(h1)).toBe(true);
    expect(h1 && canMove(h1, 1)).toBe(true);
  });

  it('won’t move a neighbour past a run’s end, which would put it inside the run', () => {
    const tree = treeWith([lock({ keys: ['s1', 's2'] })], longPage());
    expect(canMove(findBlock(tree, 'h1')!, 1)).toBe(false);
    expect(canMove(findBlock(tree, 'a1')!, -1)).toBe(false);
  });

  it('draws no seam between a run’s blocks or in a slot inside the region; around it, it does', () => {
    const fields = longPage();
    const tree = treeWith([lock({ keys: ['s1', 's2'] })], fields);
    const rect = { x: 0, y: 0, w: 10, h: 10 };
    const seams = seamsFrom(
      {
        truncated: false,
        blocks: [],
        slots: [
          {
            ref: ref('body'),
            rect,
            gaps: [
              { index: 1, axis: 'y', after: 'h1', before: 's1', rect },
              { index: 2, axis: 'y', after: 's1', before: 's2', rect },
              { index: 3, axis: 'y', after: 's2', before: 'a1', rect },
            ],
          },
          {
            ref: ref('body[s1].items'),
            rect,
            gaps: [{ index: 1, axis: 'y', after: 'c1', rect }],
          },
        ],
      },
      tree,
      refCtx,
    );
    expect(seams.map((s) => s.id)).toEqual(['body#1', 'body#3']);
    const main = findSlot(tree, 'body')!;
    expect(placeLockedBy({ slot: main, index: 2 })?.lock.keys).toEqual(['s1', 's2']);
    expect(placeLockedBy({ slot: main, index: 1 })).toBeUndefined();
    expect(placeLockedBy({ slot: findSlot(tree, 'body[s1].items')!, index: 1 })).toBeDefined();
  });

  it('draws one outline around a run, from its blocks’ boxes', () => {
    const tree = treeWith([lock({ keys: ['s1', 's2'] })], longPage());
    const rects = new Map([
      ['h1', { x: 0, y: 0, w: 100, h: 40 }],
      ['s1', { x: 0, y: 50, w: 100, h: 100 }],
      ['s2', { x: 10, y: 160, w: 80, h: 50 }],
    ]);
    expect(regionRects(tree, rects)).toEqual([
      { id: 'region-0', rect: { x: 0, y: 50, w: 100, h: 160 } },
    ]);
  });

  it('selects a run between two blocks of one slot, and the focused one alone across slots', () => {
    const tree = treeWith([], longPage());
    expect(runBetween(tree, 'a1', 's1').map((b) => b.key)).toEqual(['s1', 's2', 'a1']);
    expect(runBetween(tree, 'c1', 's1').map((b) => b.key)).toEqual(['s1']);
    expect(runBetween(tree, null, 'h1').map((b) => b.key)).toEqual(['h1']);
    expect(runBetween(tree, 'h1', null)).toEqual([]);
  });
});

describe('who is offered Lock', () => {
  const access = (over: Partial<PrincipalInfo>): PrincipalInfo => ({
    spaceId: 'sp',
    kind: 'user',
    scopes: ['content:write'],
    contentActions: { types: {}, others: ['read', 'write', 'lock'] },
    ...over,
  });
  it('someone holding `lock` on the type, by its own grant or the `*` one', () => {
    expect(canLock(access({}), 'page')).toBe(true);
    expect(
      canLock(
        access({ contentActions: { types: { page: ['read', 'write'] }, others: ['lock'] } }),
        'page',
      ),
    ).toBe(false);
    expect(
      canLock(access({ contentActions: { types: { page: ['lock'] }, others: [] } }), 'page'),
    ).toBe(true);
  });
  it('reads a type named like an object’s own property by the `*` grant', () => {
    expect(canLock(access({}), 'constructor')).toBe(true);
    expect(canLock(access({ contentActions: { types: {}, others: [] } }), 'toString')).toBe(false);
  });
  it('nobody without content:write, and nobody until the api has said', () => {
    expect(canLock(access({ scopes: ['preview:read'] }), 'page')).toBe(false);
    expect(canLock(access({ contentActions: undefined }), 'page')).toBe(false);
    expect(canLock(undefined, 'page')).toBe(false);
  });
});

describe('what Lock and Unlock send', () => {
  const held = lock({ keys: ['h1'] });
  it('the whole list, a new lock added or one left out, without who and when', () => {
    const next = { field: 'body', keys: ['a1'], depth: 'self' as const, freeze: 'all' as const };
    expect(withLock([held], next)).toEqual([
      { field: 'body', keys: ['h1'], depth: 'subtree', freeze: 'structure' },
      next,
    ]);
    expect(withoutLock([held, lock({ keys: ['a1'] })], held)).toEqual([
      { field: 'body', keys: ['a1'], depth: 'subtree', freeze: 'structure' },
    ]);
  });
});

describe('the words', () => {
  it('says who locked it and when, or only when for a reader who isn’t shown who', () => {
    expect(lockedLine(lock({ keys: ['h1'], lockedBy: 'user:1' }), { me: 'user:1' })).toMatch(
      /^Locked by you · Nov 9, 2026$/,
    );
    const { lockedBy: _who, ...anonymous } = lock({ keys: ['h1'] });
    expect(lockedLine(anonymous)).toMatch(/^Locked · Nov 9, 2026$/);
  });

  it('says what a lock keeps, without jargon', () => {
    const v = view([lock({ keys: ['s1'], freeze: 'all' })]);
    expect(lockSays(v.marks.get('s1')!, 'Section')).toBe(
      'Section is locked: it keeps its place, and so does everything inside it, and its content can’t be edited.',
    );
    expect(lockSays(v.marks.get('c1')!, 'Card')).toBe(
      'Card is inside a locked region: it keeps its place, and its content can’t be edited.',
    );
    const self = view([lock({ keys: ['h1'], depth: 'self' })]);
    expect(lockSays(self.marks.get('h1')!, 'Hero')).toBe(
      'Hero is locked: it keeps its place. Its settings can still be edited.',
    );
  });

  it('turns a refused lock set into the inspector’s words, and nothing else', () => {
    const refused = (code: string) =>
      new ApiError(422, 'Validation failed', {
        error: { issues: [{ field: 'locks[0].keys', code, message: 'raw' }] },
      });
    expect(lockRefusal(refused('lock_overlaps'))).toEqual([
      'Part of this is already in a locked region. Unlock that first.',
    ]);
    expect(lockRefusal(refused('lock_not_a_run'))[0]).toMatch(/aren’t neighbours/);
    expect(lockRefusal(refused('lock_not_found'))[0]).toMatch(/Save the draft/);
    expect(lockRefusal(refused('lock_ambiguous'))[0]).toMatch(/same key/);
    expect(lockRefusal(new ApiError(409, 'stale'))).toEqual([]);
    expect(lockRefusal(new Error('boom'))).toEqual([]);
  });
});

describe('a save under a lock', () => {
  const stored = pageFields();
  const removed = (): EntryFields => {
    const f = pageFields();
    (f.body!['en-US'] as unknown[]).shift();
    return f;
  };

  it('is judged against the regions before it is sent, with or without a catalog', () => {
    const issues = configIssues(
      pageType,
      null,
      null,
      stored,
      removed(),
      ['en-US'],
      [lock({ keys: ['h1'] })],
    );
    expect(issues.map((i) => i.code)).toEqual(['region_locked']);
    expect(regionRefusal(issues)).toBe(true);
    expect(configIssues(pageType, null, null, stored, removed(), ['en-US'])).toEqual([]);
  });

  it('is said on the locked block, in plain words', () => {
    const fields = pageFields();
    const tree = treeWith([lock({ keys: ['s1'], freeze: 'all' })], fields);
    const checks = configChecks(
      [
        { field: 'body[1]', locale: 'en-US', code: 'region_frozen', key: 's1', message: 'x' },
        { field: 'body', locale: 'en-US', code: 'region_locked', key: 'gone', message: 'x' },
      ],
      fields,
      tree,
      { locale: 'en-US', defaultLocale: 'en-US' },
    );
    expect(checks[0]).toMatchObject({
      message: 'Section is locked and its content can’t be edited. Undo the change to save',
      blockKey: 's1',
    });
    expect(checks[1]?.message).toBe(
      'A locked block is locked: its blocks can’t be added, removed or moved. Undo the change to save',
    );
  });
});
