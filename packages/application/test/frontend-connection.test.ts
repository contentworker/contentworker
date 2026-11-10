import {
  type ContentTypeDraft,
  type Principal,
  SCOPES,
  scopesForKind,
  ValidationError,
} from '@contentworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  authenticate,
  connectFrontend,
  createContentType,
  createRole,
  createSpace,
  listApiKeys,
  presetRoleId,
  SYSTEM_CALLER,
  setContentTypePreview,
} from '../src/index';

const hasher = { hash: (v: string) => `h:${v}` };
const S = 's1';
const TEMPLATE = 'https://site.example/blog/{field:slug}?entry={id}&token={token}';
const operator: Principal = { spaceId: S, kind: 'cma', scopes: [...scopesForKind('cma')] };

const type = (apiId: string): ContentTypeDraft => ({
  apiId,
  name: apiId[0]?.toUpperCase() + apiId.slice(1),
  displayField: 'title',
  fields: [
    {
      apiId: 'title',
      name: 'Title',
      type: 'Symbol',
      localized: false,
      required: true,
      position: 0,
    },
    { apiId: 'slug', name: 'Slug', type: 'Slug', localized: false, required: false, position: 1 },
  ],
});

let ctx: AppContext;

beforeEach(async () => {
  ctx = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('k'),
  };
  await createSpace(ctx, { spaceId: S, name: 'Site', defaultLocale: 'en-US' });
  await createSpace(ctx, { spaceId: 's2', name: 'Other', defaultLocale: 'en-US' });
  const scope = { spaceId: S, environmentId: 'main' };
  await createContentType(ctx, SYSTEM_CALLER, scope, type('post'));
  await createContentType(ctx, SYSTEM_CALLER, scope, type('page'));
  await setContentTypePreview(ctx, SYSTEM_CALLER, scope, 'post', TEMPLATE);
});

describe('connecting a frontend', () => {
  it('mints a Delivery key whose token reads, and answers the config once', async () => {
    const c = await connectFrontend(ctx, hasher, {
      spaceId: S,
      environment: 'main',
      name: 'Marketing site',
      adminOrigin: 'https://acme.contentworker.app',
      issuer: operator,
    });
    expect(c).toMatchObject({ space: S, environment: 'main' });
    expect(c.previewKey).toBeUndefined();
    expect(c.endpoints?.delivery).toBe('https://cdn.acme.contentworker.app');
    expect(c.previewUrls).toEqual(
      expect.arrayContaining([
        { contentType: 'post', name: 'Post', urlTemplate: TEMPLATE },
        { contentType: 'page', name: 'Page', urlTemplate: null },
      ]),
    );
    const principal = await authenticate(ctx, hasher, c.deliveryKey.token);
    expect(principal).toMatchObject({ kind: 'cda', spaceId: S });
    expect(principal.scopes).toContain(SCOPES.deliveryRead);
    expect(principal.scopes).not.toContain(SCOPES.previewRead);
    const keys = await listApiKeys(ctx, S);
    expect(keys.map((k) => k.name)).toEqual(['Marketing site (delivery)']);
    // Only the hash is kept.
    expect(keys[0]?.hashedToken).toBe(hasher.hash(c.deliveryKey.token));
  });

  it('adds a Preview key when asked, each key bound to a role that fits its kind', async () => {
    const reader = await createRole(ctx, S, {
      name: 'Site reader',
      scopes: [SCOPES.deliveryRead, SCOPES.searchRead],
      contentGrants: [{ contentTypeApiId: 'post', actions: ['read'] }],
    });
    const viewer = await presetRoleId(ctx, S, 'viewer');
    const c = await connectFrontend(ctx, hasher, {
      spaceId: S,
      environment: 'main',
      preview: true,
      roleId: reader.id,
      previewRoleId: viewer,
      issuer: operator,
    });
    expect(c.previewKey?.token).toMatch(/^cwk_cpa_/);
    expect(c.deliveryKey.token).toMatch(/^cwk_cda_/);
    const keys = await listApiKeys(ctx, S);
    expect(keys.map((k) => [k.name, k.kind, k.roleId])).toEqual([
      ['Frontend (delivery)', 'cda', reader.id],
      ['Frontend (preview)', 'cpa', viewer],
    ]);
    // The Delivery key, role-bound, still reads no drafts.
    const delivery = await authenticate(ctx, hasher, c.deliveryKey.token);
    expect(delivery.scopes).not.toContain(SCOPES.previewRead);
    expect(delivery.contentGrants).toEqual([{ contentTypeApiId: 'post', actions: ['read'] }]);
    // Without an admin origin there are no endpoints to print.
    expect(c.endpoints).toBeUndefined();
  });

  it('refuses a role that would widen a key beyond its kind, minting nothing', async () => {
    const viewer = await presetRoleId(ctx, S, 'viewer');
    const editor = await presetRoleId(ctx, S, 'editor');
    // Viewer reads drafts: a Delivery key bound to it would too.
    const widened = await connectFrontend(ctx, hasher, {
      spaceId: S,
      environment: 'main',
      roleId: viewer,
      issuer: operator,
    }).catch((e: unknown) => e);
    expect(widened).toBeInstanceOf(ValidationError);
    expect(JSON.stringify((widened as ValidationError).issues)).toContain('preview:read');
    // Editor writes: not even a Preview key may hold that.
    await expect(
      connectFrontend(ctx, hasher, {
        spaceId: S,
        environment: 'main',
        preview: true,
        previewRoleId: editor,
        issuer: operator,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      connectFrontend(ctx, hasher, {
        spaceId: S,
        environment: 'main',
        roleId: 'nope',
        issuer: operator,
      }),
    ).rejects.toThrow(/not found/i);
    expect(await listApiKeys(ctx, S)).toEqual([]);
  });

  it('refuses an environment that doesn’t exist, minting nothing', async () => {
    await expect(
      connectFrontend(ctx, hasher, { spaceId: S, environment: 'mian', issuer: operator }),
    ).rejects.toThrow(/not found/i);
    expect(await listApiKeys(ctx, S)).toEqual([]);
  });

  it('refuses a delegated bearer, as minting any key does', async () => {
    const pat: Principal = { ...operator, kind: 'user', subject: 'ada', issuance: 'pat' };
    await expect(
      connectFrontend(ctx, hasher, { spaceId: S, environment: 'main', issuer: pat }),
    ).rejects.toThrow(/can't mint an API key/);
    expect(await listApiKeys(ctx, S)).toEqual([]);
  });

  it('lists only the types the caller reads', async () => {
    const narrow: Principal = {
      ...operator,
      contentGrants: [{ contentTypeApiId: 'page', actions: ['read'] }],
    } as Principal;
    const c = await connectFrontend(ctx, hasher, {
      spaceId: S,
      environment: 'main',
      issuer: narrow,
    });
    expect(c.previewUrls.map((p) => p.contentType)).toEqual(['page']);
  });

  it('keeps each space’s keys and types to itself', async () => {
    const c = await connectFrontend(ctx, hasher, {
      spaceId: 's2',
      environment: 'main',
      issuer: 'system',
    });
    expect(c.previewUrls).toEqual([]);
    expect(await listApiKeys(ctx, S)).toEqual([]);
    expect((await authenticate(ctx, hasher, c.deliveryKey.token)).spaceId).toBe('s2');
  });
});
