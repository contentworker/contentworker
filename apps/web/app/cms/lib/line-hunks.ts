/**
 * Where two long values differ, line by line, for a review that must show what changed rather
 * than the first lines of each (a rich text reads a line per block, a Text field a line per line).
 * Each hunk is a run of changed lines with a line of unchanged context either side, as the
 * published side and the draft side read it.
 */

export interface HunkLine {
  readonly text: string;
  /** Removed (on the published side) or added (on the draft side); context otherwise. */
  readonly changed: boolean;
}

export interface Hunk {
  readonly before: readonly HunkLine[];
  readonly after: readonly HunkLine[];
}

/** Past this many lines a side the table isn't built: the values are shown whole instead. */
export const MAX_DIFF_LINES = 1000;

type Op = { readonly kind: 'same' | 'removed' | 'added'; readonly text: string };

/** The longest common subsequence of lines, as an edit script. */
function lineOps(a: readonly string[], b: readonly string[]): Op[] {
  // A shared head and tail are matched outright; only what's between them is compared.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const n = x.length;
  const m = y.length;
  // lcs[i][j]: the common length of x[i..] and y[j..], one flat row-major table.
  const lcs = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * (m + 1) + j] =
        x[i] === y[j]
          ? (lcs[(i + 1) * (m + 1) + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * (m + 1) + j] ?? 0, lcs[i * (m + 1) + j + 1] ?? 0);
  const ops: Op[] = a.slice(0, head).map((text) => ({ kind: 'same', text }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      ops.push({ kind: 'same', text: x[i] as string });
      i++;
      j++;
    } else if (
      j < m &&
      (i >= n || (lcs[i * (m + 1) + j + 1] ?? 0) >= (lcs[(i + 1) * (m + 1) + j] ?? 0))
    ) {
      ops.push({ kind: 'added', text: y[j] as string });
      j++;
    } else {
      ops.push({ kind: 'removed', text: x[i] as string });
      i++;
    }
  }
  for (const text of a.slice(a.length - tail)) ops.push({ kind: 'same', text });
  return ops;
}

/**
 * The changed runs between `before` and `after`, each with `context` unchanged lines either side;
 * runs whose context would touch are one hunk. `null` when either side is too long to compare.
 */
export function lineHunks(before: string, after: string, context = 1): Hunk[] | null {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null;
  const ops = lineOps(a, b);
  const changedAt = ops.flatMap((op, k) => (op.kind === 'same' ? [] : [k]));
  // Ranges of ops to show, widened by the context and merged where they meet.
  const ranges: [number, number][] = [];
  for (const k of changedAt) {
    const from = Math.max(0, k - context);
    const to = Math.min(ops.length - 1, k + context);
    const last = ranges[ranges.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }
  return ranges.map(([from, to]) => {
    const run = ops.slice(from, to + 1);
    return {
      before: run
        .filter((op) => op.kind !== 'added')
        .map((op) => ({ text: op.text, changed: op.kind === 'removed' })),
      after: run
        .filter((op) => op.kind !== 'removed')
        .map((op) => ({ text: op.text, changed: op.kind === 'added' })),
    };
  });
}
