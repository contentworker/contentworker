import { describe, expect, it } from 'vitest';
import { blockIndent } from '~/cms/lib/block-indent';

describe('blocks tree indent', () => {
  it('steps a full rem for the first two levels, then half, so six levels fit a phone', () => {
    expect([0, 1, 2, 3, 4, 5].map(blockIndent)).toEqual([0, 1, 2, 2.5, 3, 3.5]);
    // Layers adds its 0.5rem edge: a block six deep still has most of a 390px sheet's row.
    expect((0.5 + blockIndent(5)) * 16).toBeLessThanOrEqual(64);
  });
});
