// Where two long values differ line by line, as the publish review shows them: each changed run
// with a line of context, runs whose context touches as one.
import { describe, expect, it } from 'vitest';
import { lineHunks, MAX_DIFF_LINES } from '~/cms/lib/line-hunks';

const lines = (n: number, edit: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => edit[i + 1] ?? `L${i + 1}`).join('\n');
const said = (side: readonly { text: string; changed: boolean }[]) =>
  side.map((l) => (l.changed ? `*${l.text}` : l.text));

describe('lineHunks', () => {
  it('finds nothing in values that match', () => {
    expect(lineHunks(lines(5), lines(5))).toEqual([]);
  });

  it('gives a changed line with a line of context on each side', () => {
    const [hunk, ...rest] = lineHunks(lines(10), lines(10, { 5: 'five' })) ?? [];
    expect(rest).toEqual([]);
    expect(said(hunk?.before ?? [])).toEqual(['L4', '*L5', 'L6']);
    expect(said(hunk?.after ?? [])).toEqual(['L4', '*five', 'L6']);
  });

  it('keeps distant changes apart and joins ones whose context touches', () => {
    const hunks = lineHunks(lines(20), lines(20, { 2: 'two', 4: 'four', 15: 'fifteen' })) ?? [];
    expect(hunks.map((h) => said(h.after))).toEqual([
      ['L1', '*two', 'L3', '*four', 'L5'],
      ['L14', '*fifteen', 'L16'],
    ]);
  });

  it('shows an inserted line on the draft side alone, and a removed one on the published side', () => {
    const added = lineHunks('a\nb\nc', 'a\nb\nnew\nc') ?? [];
    expect(said(added[0]?.before ?? [])).toEqual(['b', 'c']);
    expect(said(added[0]?.after ?? [])).toEqual(['b', '*new', 'c']);
    const removed = lineHunks('a\nb\nc\nd', 'a\nd') ?? [];
    expect(said(removed[0]?.before ?? [])).toEqual(['a', '*b', '*c', 'd']);
    expect(said(removed[0]?.after ?? [])).toEqual(['a', 'd']);
  });

  it('gives up on values too long to compare', () => {
    expect(lineHunks(lines(MAX_DIFF_LINES + 1), lines(3))).toBeNull();
  });
});
