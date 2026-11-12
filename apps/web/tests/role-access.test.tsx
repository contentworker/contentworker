// @vitest-environment jsdom
import type { ContentTypeGrant } from '@contentworker/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoleAccessSheet } from '~/cms/components/RoleAccessSheet';
import { ApiError, RequestTimeoutError, type RoleSummary } from '~/cms/lib/management';

afterEach(cleanup);

const role: RoleSummary = {
  id: 'r1',
  name: 'Editor',
  scopes: ['content:write', 'content:publish'],
  contentGrants: [{ contentTypeApiId: 'post', actions: ['read', 'write', 'publish'] }],
  version: 3,
};

function open(
  onSave: (grants: readonly ContentTypeGrant[]) => Promise<void>,
  onReload: () => Promise<void> = async () => {},
) {
  render(
    <RoleAccessSheet
      role={role}
      contentTypes={[
        { apiId: 'post', name: 'Post' },
        { apiId: 'page', name: 'Page' },
      ]}
      open
      onOpenChange={() => {}}
      onSave={onSave}
      onReload={onReload}
    />,
  );
}

describe('a role’s content access', () => {
  it('saves write without delete and publish without unpublish as withheld actions', async () => {
    const onSave = vi.fn(async () => {});
    open(onSave);
    const del = screen.getByRole('checkbox', { name: 'Delete Post' });
    const unpublish = screen.getByRole('checkbox', { name: 'Unpublish Post' });
    expect(del.getAttribute('aria-checked')).toBe('true');
    expect(unpublish.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(del);
    fireEvent.click(unpublish);
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith([
      {
        contentTypeApiId: 'post',
        actions: ['read', 'write', 'publish'],
        deniedActions: ['delete', 'unpublish'],
      },
    ]);
  });

  it('offers delete only with write or publish, and unpublish only with publish', () => {
    open(async () => {});
    fireEvent.change(screen.getByRole('combobox', { name: 'Content type to add' }), {
      target: { value: 'page' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('checkbox', { name: 'Read Page' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(
      (screen.getByRole('checkbox', { name: 'Delete Page' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('checkbox', { name: 'Unpublish Page' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Write Page' }));
    expect(
      (screen.getByRole('checkbox', { name: 'Delete Page' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole('checkbox', { name: 'Unpublish Page' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('keeps the sheet open with the server’s reason when saving is refused', async () => {
    open(async () => {
      throw new Error('Unknown action "destroy"');
    });
    const save = screen.getByRole('button', { name: 'Save access' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Delete Post' }));
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect((await screen.findByText('Unknown action "destroy"')).textContent).toBe(
      'Unknown action "destroy"',
    );
  });

  it('names a stale save as someone else’s change, keeps the edits, and offers a reload', async () => {
    const onReload = vi.fn(async () => {});
    open(async () => {
      throw new ApiError(409, 'PUT → 409', {
        error: { code: 'conflict', message: 'm', details: { version: 4 } },
      });
    }, onReload);
    const del = screen.getByRole('checkbox', { name: 'Delete Post' });
    fireEvent.click(del);
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Someone else changed this role');
    expect(alert.textContent).toContain('Editor was saved after you opened it');
    expect(del.getAttribute('aria-checked')).toBe('false');
    // Save went disabled under the press: the refusal takes focus and is its reason.
    await waitFor(() => expect(document.activeElement).toBe(alert));
    const save = screen.getByRole('button', { name: 'Save access' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.getAttribute('aria-describedby')).toBe(alert.id);
    fireEvent.click(screen.getByRole('button', { name: 'Reload role' }));
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
  });

  it('allows that a save that didn’t confirm may be what moved the role on', async () => {
    const stale = new ApiError(409, 'PUT → 409', {
      error: { code: 'conflict', message: 'm', details: { version: 4 } },
    });
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new RequestTimeoutError(true))
      .mockRejectedValueOnce(stale);
    open(onSave);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Delete Post' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('This role moved on'),
    );
    expect(screen.getByRole('alert').textContent).toContain('perhaps by your own save');
  });

  it('still asks before discarding the kept edits, saying nothing was saved', async () => {
    open(async () => {
      throw new ApiError(409, 'PUT → 409', {
        error: { code: 'conflict', message: 'm', details: { version: 4 } },
      });
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Delete Post' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Discard your changes to Editor’s access?')).toBeTruthy();
    expect(screen.getByText('Nothing has been saved.')).toBeTruthy();
  });

  it('keeps the refusal and the edits when the reload fails, and says why', async () => {
    open(
      async () => {
        throw new ApiError(409, 'PUT → 409', {
          error: { code: 'conflict', message: 'm', details: { version: 4 } },
        });
      },
      async () => {
        throw new ApiError(404, 'GET → 404', {
          error: { code: 'not_found', message: 'Role not found' },
        });
      },
    );
    const del = screen.getByRole('checkbox', { name: 'Delete Post' });
    fireEvent.click(del);
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reload role' }));
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
    expect(screen.getAllByRole('alert')[0]?.textContent).toContain('Someone else changed');
    expect(screen.getAllByRole('alert')[1]?.textContent).toContain('Role not found');
    expect(del.getAttribute('aria-checked')).toBe('false');
  });

  it('shows the last-admin refusal in the server’s words, not as someone else’s change', async () => {
    open(async () => {
      throw new ApiError(409, 'PUT → 409', {
        error: { code: 'last_admin', message: 'This is the last active administrator' },
      });
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Delete Post' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }));
    expect((await screen.findByRole('alert')).textContent).toContain('last active administrator');
    expect(screen.queryByRole('button', { name: 'Reload role' })).toBeNull();
  });

  it('says why a box is disabled, and describes each box by its hint', () => {
    open(async () => {});
    fireEvent.change(screen.getByRole('combobox', { name: 'Content type to add' }), {
      target: { value: 'page' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const describedBy = (name: string) =>
      document.getElementById(
        screen.getByRole('checkbox', { name }).getAttribute('aria-describedby') ?? '',
      )?.textContent;
    expect(describedBy('Delete Page')).toBe('Needs Write or Publish');
    expect(describedBy('Unpublish Page')).toBe('Needs Publish');
    expect(describedBy('Write Page')).toBe('Create and edit drafts');
  });

  it('asks before discarding unsaved changes, and closes at once when there are none', () => {
    const onOpenChange = vi.fn();
    render(
      <RoleAccessSheet
        role={role}
        contentTypes={[{ apiId: 'post', name: 'Post' }]}
        open
        onOpenChange={onOpenChange}
        onSave={async () => {}}
        onReload={async () => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    onOpenChange.mockClear();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Unpublish Post' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).not.toHaveBeenCalled();
    const ask = screen.getByRole('alertdialog');
    expect(ask.textContent).toContain('Discard your changes to Editor’s access?');
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows and removes each row of a role that names a type twice', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onSave = vi.fn(async () => {});
    render(
      <RoleAccessSheet
        role={{
          ...role,
          contentGrants: [
            { contentTypeApiId: 'post', actions: ['read'] },
            { contentTypeApiId: 'post', actions: ['read', 'write'] },
          ],
        }}
        contentTypes={[{ apiId: 'post', name: 'Post' }]}
        open
        onOpenChange={() => {}}
        onSave={onSave}
        onReload={async () => {}}
      />,
    );
    const writes = screen.getAllByRole('checkbox', { name: 'Write Post' });
    expect(writes.map((w) => w.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(error.mock.calls.some((c) => String(c[0]).includes('same key'))).toBe(false);
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Remove access to Post' })[0] as HTMLElement,
    );
    expect(
      screen
        .getAllByRole('checkbox', { name: 'Write Post' })
        .map((w) => w.getAttribute('aria-checked')),
    ).toEqual(['true']);
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith([{ contentTypeApiId: 'post', actions: ['read', 'write'] }]);
    error.mockRestore();
  });
});
