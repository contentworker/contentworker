import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import {
  type AppContext,
  authenticate,
  cloneRole,
  createApiKey,
  createRole,
  deleteRole,
  getRole,
  listRoles,
  revokeApiKey,
  updateRole,
} from '../src/index';

const hasher = { hash: (v: string) => `h:${v}` };

function ctx(): AppContext {
  return {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('r'),
  };
}

describe('granular RBAC: roles', () => {
  it('creates, lists, updates, and deletes a role', async () => {
    const c = ctx();
    const role = await createRole(c, 's1', {
      name: 'Blog editor',
      scopes: ['content:write', 'preview:read'],
      contentGrants: [{ contentTypeApiId: 'post', actions: ['read', 'write'] }],
    });
    expect((await listRoles(c, 's1')).map((r) => r.id)).toEqual([role.id]);

    const updated = await updateRole(
      c,
      's1',
      role.id,
      {
        name: 'Blog editor',
        scopes: ['content:write', 'content:publish', 'preview:read'],
        contentGrants: [{ contentTypeApiId: 'post', actions: ['read', 'write', 'publish'] }],
      },
      { sso: false },
      'system',
    );
    expect(updated.scopes).toContain('content:publish');
    expect((await getRole(c, 's1', role.id)).contentGrants[0]?.actions).toContain('publish');

    await deleteRole(c, 's1', role.id);
    expect(await listRoles(c, 's1')).toEqual([]);
  });

  it('rejects unknown scopes and actions', async () => {
    const c = ctx();
    await expect(
      createRole(c, 's1', { name: 'Bad', scopes: ['not:a:scope'] }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ message: expect.stringContaining('Unknown scope') })],
    });
    await expect(
      createRole(c, 's1', {
        name: 'Bad',
        scopes: ['content:write'],
        contentGrants: [{ contentTypeApiId: 'post', actions: ['destroy' as unknown as 'read'] }],
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ message: expect.stringContaining('Unknown action') })],
    });
  });

  it('withholds delete and unpublish with deniedActions, never by listing them', async () => {
    const c = ctx();
    // Listed, they would say nothing a grant doesn't already hold: refused, naming the way.
    await expect(
      createRole(c, 's1', {
        name: 'Listed',
        scopes: ['content:write'],
        contentGrants: [{ contentTypeApiId: 'post', actions: ['delete' as unknown as 'read'] }],
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ message: expect.stringContaining('deniedActions') })],
    });
    await expect(
      createRole(c, 's1', {
        name: 'Withholds read',
        scopes: ['content:write'],
        contentGrants: [
          { contentTypeApiId: 'post', actions: ['read'], deniedActions: ['read' as 'delete'] },
        ],
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ message: expect.stringContaining('"read"') })],
    });
    const role = await createRole(c, 's1', {
      name: 'Writer, no deletes',
      scopes: ['content:write'],
      contentGrants: [
        { contentTypeApiId: '*', actions: ['read', 'write'], deniedActions: ['delete'] },
      ],
    });
    expect((await getRole(c, 's1', role.id)).contentGrants[0]?.deniedActions).toEqual(['delete']);
  });

  it('refuses grants that name a content type more than once, two wildcards included', async () => {
    const c = ctx();
    await expect(
      createRole(c, 's1', {
        name: 'Two posts',
        scopes: ['content:write'],
        contentGrants: [
          { contentTypeApiId: 'post', actions: ['read'] },
          { contentTypeApiId: 'post', actions: ['read', 'write'] },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      issues: [
        {
          field: 'contentGrants',
          message: 'More than one grant names "post"; merge them into one',
        },
      ],
    });
    const role = await createRole(c, 's1', {
      name: 'Reader',
      scopes: ['preview:read'],
      contentGrants: [{ contentTypeApiId: '*', actions: ['read'] }],
    });
    await expect(
      updateRole(
        c,
        's1',
        role.id,
        {
          name: 'Reader',
          scopes: ['preview:read'],
          contentGrants: [
            { contentTypeApiId: '*', actions: ['read'] },
            { contentTypeApiId: '*', actions: ['read', 'write'] },
          ],
        },
        { sso: false },
        'system',
      ),
    ).rejects.toMatchObject({
      issues: [
        {
          field: 'contentGrants',
          message: 'More than one grant covers every type ("*"); merge them into one',
        },
      ],
    });
    // Refused before anything is written: the role is as it was.
    expect(await getRole(c, 's1', role.id)).toEqual(role);
  });

  it('a role stored with repeated grants still resolves, but saves only once merged', async () => {
    const c = ctx();
    // Stored before role saves refused a repeated grant: written straight to the store.
    const legacy = {
      id: 'legacy',
      spaceId: 's1',
      name: 'Legacy',
      scopes: ['content:write'],
      contentGrants: [
        { contentTypeApiId: '*', actions: ['read', 'write'] as const },
        { contentTypeApiId: '*', actions: ['read'] as const },
      ],
      version: 1,
    };
    await c.store.roles.save(legacy);
    expect((await getRole(c, 's1', 'legacy')).contentGrants).toHaveLength(2);
    const { token } = await createApiKey(c, hasher, {
      issuer: 'system',
      spaceId: 's1',
      kind: 'cma',
      roleId: 'legacy',
    });
    expect((await authenticate(c, hasher, token)).contentGrants).toEqual(legacy.contentGrants);

    // Saved back unchanged (a rename, say): refused, naming the type to merge.
    const unchanged = {
      name: 'Renamed',
      scopes: legacy.scopes,
      contentGrants: legacy.contentGrants,
    };
    await expect(
      updateRole(c, 's1', 'legacy', unchanged, { sso: false }, 'system'),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ message: expect.stringContaining('("*")') })],
    });
    // Nor copied into a new role.
    await expect(cloneRole(c, 's1', 'legacy')).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect((await listRoles(c, 's1')).map((r) => r.id)).toEqual(['legacy']);

    const merged = await updateRole(
      c,
      's1',
      'legacy',
      { ...unchanged, contentGrants: [{ contentTypeApiId: '*', actions: ['read', 'write'] }] },
      { sso: false },
      'system',
    );
    expect(merged.version).toBe(2);
    expect((await cloneRole(c, 's1', 'legacy')).contentGrants).toEqual(merged.contentGrants);
  });

  it('a role-bound key resolves the role live on authenticate', async () => {
    const c = ctx();
    const role = await createRole(c, 's1', {
      name: 'Reader',
      scopes: ['preview:read'],
      contentGrants: [{ contentTypeApiId: 'post', actions: ['read'] }],
    });
    const { token } = await createApiKey(c, hasher, {
      issuer: 'system',
      spaceId: 's1',
      kind: 'cpa',
      roleId: role.id,
    });

    const principal = await authenticate(c, hasher, token);
    expect(principal.scopes).toEqual(['preview:read']);
    expect(principal.contentGrants).toEqual([{ contentTypeApiId: 'post', actions: ['read'] }]);

    // Editing the role changes what existing keys can do — no re-mint needed.
    await updateRole(
      c,
      's1',
      role.id,
      {
        name: 'Reader+',
        scopes: ['preview:read', 'search:read'],
        contentGrants: [{ contentTypeApiId: '*', actions: ['read'] }],
      },
      { sso: false },
      'system',
    );
    const after = await authenticate(c, hasher, token);
    expect(after.scopes).toContain('search:read');
    expect(after.contentGrants?.[0]?.contentTypeApiId).toBe('*');
  });

  it('minting a key against a missing role fails', async () => {
    const c = ctx();
    await expect(
      createApiKey(c, hasher, { issuer: 'system', spaceId: 's1', kind: 'cma', roleId: 'nope' }),
    ).rejects.toThrow(/Role/);
  });

  it('refuses to delete a role still held by an active key, allows after revoke', async () => {
    const c = ctx();
    const role = await createRole(c, 's1', { name: 'Held', scopes: ['preview:read'] });
    const { apiKey } = await createApiKey(c, hasher, {
      issuer: 'system',
      spaceId: 's1',
      kind: 'cpa',
      roleId: role.id,
    });
    await expect(deleteRole(c, 's1', role.id)).rejects.toMatchObject({
      issues: [expect.objectContaining({ message: expect.stringContaining('assigned') })],
    });
    await revokeApiKey(c, 's1', apiKey.id);
    await deleteRole(c, 's1', role.id);
    expect(await listRoles(c, 's1')).toEqual([]);
  });
});
