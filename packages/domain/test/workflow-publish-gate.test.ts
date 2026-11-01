import { describe, expect, it } from 'vitest';
import { gatesCovering, type PublishGate, PublishGatedError } from '../src/index';

const gate = (workflowId: string, contentTypes: string[]): PublishGate => ({
  workflowId,
  name: workflowId.toUpperCase(),
  version: 1,
  contentTypes,
});

describe('publish gates', () => {
  it('covers the listed content types, and every type when the list is empty', () => {
    const gates = [gate('posts', ['post']), gate('all', []), gate('pages', ['page'])];
    expect(gatesCovering(gates, 'post').map((g) => g.workflowId)).toEqual(['posts', 'all']);
    expect(gatesCovering(gates, 'event').map((g) => g.workflowId)).toEqual(['all']);
    expect(gatesCovering([gate('posts', ['post'])], 'page')).toEqual([]);
  });

  it('names the entry and its workflows in the refusal, with a stable code', () => {
    const err = new PublishGatedError([
      {
        entryId: 'e1',
        workflows: [
          { id: 'a', name: 'Legal' },
          { id: 'b', name: 'Brand' },
        ],
      },
    ]);
    expect(err.code).toBe('publish_gated');
    expect(err.message).toBe(
      'Entry "e1" publishes only through a run of the workflow "Legal" or "Brand". Start a run of it, or turn off its publish gating.',
    );
  });

  it('names the release and every refused entry for a release', () => {
    const err = new PublishGatedError(
      [
        { entryId: 'e1', workflows: [{ id: 'a', name: 'Legal' }] },
        { entryId: 'e2', workflows: [{ id: 'a', name: 'Legal' }] },
      ],
      { releaseId: 'r1' },
    );
    expect(err.message).toContain('Release "r1" holds 2 entries');
    expect(err.message).toContain('"e1" ("Legal"), "e2" ("Legal")');
    expect(err.details).toMatchObject({ releaseId: 'r1' });
  });
});
