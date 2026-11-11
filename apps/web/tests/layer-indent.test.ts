import { describe, expect, it } from 'vitest';
import { layerIndent } from '~/cms/components/canvas/Layers';

describe('Layers indent', () => {
  it('steps a full rem for the first levels, then half, so six levels fit a phone', () => {
    expect([1, 2, 3, 4, 5, 6].map(layerIndent)).toEqual([0.5, 1.5, 2.5, 3, 3.5, 4]);
    // A block six deep in a 390px sheet still has most of its row for its name.
    expect(layerIndent(6) * 16).toBeLessThanOrEqual(64);
  });
});
