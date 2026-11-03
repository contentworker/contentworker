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

  it('brings delete and unpublish with publish, unless withheld, and keeps every withhold', () => {
    const reader = { contentTypeApiId: 'post', actions: ['read' as const] };
    expect(actionAvailable(heldActions(reader), 'delete')).toBe(false);
    const publisher = setAction(reader, 'publish', true);
    expect([...heldActions(publisher)]).toEqual(['read', 'publish', 'delete', 'unpublish']);
    const keepsLive = setAction(publisher, 'unpublish', false);
    // Unticking and re-ticking Publish doesn't hand back the Unpublish that was taken away.
    const without = setAction(keepsLive, 'publish', false);
    expect(without).toEqual({ ...reader, deniedActions: ['unpublish'] });
    expect(heldActions(setAction(without, 'publish', true)).has('unpublish')).toBe(false);
  });

  it('keeps a withhold the boxes can’t show when another action changes', () => {
    // Write-only, withholding unpublish: what stops it trashing a live entry.
    const writer = {
      contentTypeApiId: 'post',
      actions: ['read' as const, 'write' as const],
      deniedActions: ['unpublish' as const],
    };
    expect(setAction(writer, 'delete', false).deniedActions).toEqual(['unpublish', 'delete']);
    expect(setAction(writer, 'read', false).deniedActions).toEqual(['unpublish']);
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
