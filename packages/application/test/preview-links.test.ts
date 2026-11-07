import { ForbiddenError, NotFoundError, SCOPES, ValidationError } from '@contentworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  createPreviewLink,
  createSpace,
  principalFromPreviewToken,
} from '../src/index';

const scope = { spaceId: 'site', environmentId: 'main' };
const other = { spaceId: 'other', environmentId: 'main' };
const hasher = { hash: (s: string) => `h:${s}` };
const BASE = { previewBaseUrl: 'https://api.example/' };

const field = (apiId: string, type: 'Symbol' | 'Slug', localized: boolean, position: number) => ({
  apiId,
  name: apiId,
  type,
  localized,
  required: false,
  position,
});

let ctx: AppContext;
let clock: FixedClock;

async function article(urlTemplate?: string) {
  await createContentType(ctx, scope, {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [field('title', 'Symbol', false, 0), field('slug', 'Slug', true, 1)],
    ...(urlTemplate ? { preview: { urlTemplate } } : {}),
  });
}

const entry = async (slug: Record<string, string>) =>
  (
    await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Hello' }, slug },
    })
  ).entry.id;

beforeEach(async () => {
  clock = new FixedClock();
  ctx = { store: new InMemoryContentStore(), clock, ids: new SequenceIdGenerator('p') };
  await createSpace(ctx, {
    spaceId: 'site',
    name: 'Site',
    defaultLocale: 'en-US',
    locales: ['en-US', 'fr'],
  });
  await createSpace(ctx, { spaceId: 'other', name: 'Other', defaultLocale: 'en-US' });
});

describe('preview links', () => {
  it('returns only the Preview API URL when the type has no preview template', async () => {
    await article();
    const id = await entry({ 'en-US': 'hello' });
    const link = await createPreviewLink(ctx, hasher, scope, id, BASE);
    expect(link.url).toBe(
      `https://api.example/preview/site/main/entries/${id}?preview_token=${link.token}`,
    );
    expect(link).not.toHaveProperty('frontendUrl');
  });

  it('fills the type’s template with the entry, the token and the locale', async () => {
    await article(
      'https://site.example/{locale}/blog/{field:slug}?entry={id}&token={token}&s={space}&e={environment}',
    );
    const id = await entry({ 'en-US': 'hello world', fr: 'bonjour' });
    const en = await createPreviewLink(ctx, hasher, scope, id, BASE);
    expect(en.frontendUrl).toBe(
      `https://site.example/en-US/blog/hello-world?entry=${id}&token=${en.token}&s=site&e=main`,
    );
    const fr = await createPreviewLink(ctx, hasher, scope, id, { ...BASE, locale: 'fr' });
    expect(fr.frontendUrl).toBe(
      `https://site.example/fr/blog/bonjour?entry=${id}&token=${fr.token}&s=site&e=main`,
    );
    // Each link mints its own token, and the frontend URL's reads the entry, as the API URL's does.
    expect(fr.token).not.toBe(en.token);
    const principal = await principalFromPreviewToken(ctx, hasher, scope, id, fr.token);
    expect(principal?.contentGrants).toEqual([{ contentTypeApiId: 'article', actions: ['read'] }]);
  });

  it('leaves the frontend URL out while a localized field it names is empty in the locale', async () => {
    await article('https://site.example/blog/{field:slug}?token={token}');
    const id = await entry({ 'en-US': 'hello' });
    // A localized slug never borrows the default locale's value: that is another page.
    const fr = await createPreviewLink(ctx, hasher, scope, id, { ...BASE, locale: 'fr' });
    expect(fr).not.toHaveProperty('frontendUrl');
    expect(fr.url).toContain(fr.token);
  });

  it('refuses a locale the space doesn’t have', async () => {
    await article('https://site.example/{locale}?token={token}');
    const id = await entry({ 'en-US': 'hello' });
    await expect(
      createPreviewLink(ctx, hasher, scope, id, { ...BASE, locale: 'de' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('keeps the token to its entry and scope', async () => {
    await article('https://site.example/p?entry={id}&token={token}');
    const id = await entry({ 'en-US': 'hello' });
    const second = await entry({ 'en-US': 'second' });
    const link = await createPreviewLink(ctx, hasher, scope, id, BASE);
    expect(await principalFromPreviewToken(ctx, hasher, scope, second, link.token)).toBeNull();
    expect(await principalFromPreviewToken(ctx, hasher, other, id, link.token)).toBeNull();
    await expect(createPreviewLink(ctx, hasher, other, id, BASE)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('expires the token, the frontend URL’s with it', async () => {
    await article('https://site.example/p?entry={id}&token={token}');
    const id = await entry({ 'en-US': 'hello' });
    const link = await createPreviewLink(ctx, hasher, scope, id, { ...BASE, ttlHours: 1 });
    expect(await principalFromPreviewToken(ctx, hasher, scope, id, link.token)).not.toBeNull();
    clock.advance(60 * 60 * 1000 + 1);
    expect(await principalFromPreviewToken(ctx, hasher, scope, id, link.token)).toBeNull();
  });
});

describe('who may set a type’s preview URL', () => {
  const modeller = {
    spaceId: 'site',
    kind: 'cma' as const,
    scopes: [SCOPES.contentManage],
    contentGrants: [{ contentTypeApiId: 'page', actions: ['read' as const] }],
  };
  const draft = (urlTemplate?: string | null) => ({
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [field('title', 'Symbol', false, 0)],
    ...(urlTemplate !== undefined
      ? { preview: urlTemplate === null ? null : { urlTemplate } }
      : {}),
  });
  const T = 'https://site.example/p?entry={id}&token={token}';

  it('holds a caller without read on the type to the stored value', async () => {
    await expect(createContentType(ctx, scope, draft(T), modeller)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await createContentType(ctx, scope, draft(T));
    await expect(
      createContentType(ctx, scope, draft('https://elsewhere.example/?t={token}'), modeller),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Unchanged (trimmed), left out, or cleared: nothing more to authorize.
    await createContentType(ctx, scope, draft(` ${T}`), modeller);
    await createContentType(ctx, scope, draft(), modeller);
    expect((await createContentType(ctx, scope, draft(null), modeller)).preview).toBeUndefined();
    // Read on the type is enough.
    const reader = {
      ...modeller,
      contentGrants: [{ contentTypeApiId: 'article', actions: ['read' as const] }],
    };
    expect((await createContentType(ctx, scope, draft(T), reader)).preview).toEqual({
      urlTemplate: T,
    });
  });

  it('takes a plain-http dev server only on a local stack', async () => {
    const local = 'http://localhost:3000/p?token={token}';
    await expect(createContentType(ctx, scope, draft(local))).rejects.toBeInstanceOf(
      ValidationError,
    );
    const dev = { ...ctx, previewLoopback: true };
    expect((await createContentType(dev, scope, draft(local))).preview).toEqual({
      urlTemplate: local,
    });
  });
});
