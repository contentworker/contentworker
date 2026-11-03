import { describe, expect, it } from 'vitest';
import { actionAvailable, describeGrants, heldActions, setAction } from '~/cms/lib/role-grants';

const editor = { contentTypeApiId: '*', actions: ['read', 'write', 'publish'] as const };

describe('the role editor’s content actions', () => {
  it('shows a grant stored before delete and unpublish existed as holding both', () => {
    expect([...heldActions({ ...editor, actions: [...editor.actions] })]).toEqual([
      'read',
      'write',
      'publish',
      'delete',
      'unpublish',
    ]);
  });

  it('withholds a finer action when it is unticked, and gives it back when ticked', () => {
    const noDelete = setAction({ ...editor, actions: [...editor.actions] }, 'delete', false);
    expect(noDelete).toEqual({ ...editor, deniedActions: ['delete'] });
    expect(heldActions(noDelete).has('delete')).toBe(false);
    expect(setAction(noDelete, 'delete', true)).toEqual(editor);
  });

  it('brings delete and unpublish with publish, unless withheld, and drops a moot withhold', () => {
    const reader = { contentTypeApiId: 'post', actions: ['read' as const] };
    expect(actionAvailable(heldActions(reader), 'delete')).toBe(false);
    const publisher = setAction(reader, 'publish', true);
    expect([...heldActions(publisher)]).toEqual(['read', 'publish', 'delete', 'unpublish']);
    const keepsLive = setAction(publisher, 'unpublish', false);
    // Taking publish away leaves nothing to withhold unpublish from.
    expect(setAction(keepsLive, 'publish', false)).toEqual(reader);
  });

  it('describes each grant for the roles table', () => {
    expect(
      describeGrants([
        { contentTypeApiId: 'post', actions: ['read', 'write'], deniedActions: ['delete'] },
        { contentTypeApiId: '*', actions: ['read'] },
      ]),
    ).toBe('post: read, write · Every type: read');
    expect(describeGrants([])).toBe('No content');
  });
});
