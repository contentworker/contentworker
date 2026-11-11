import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BlockCatalogPush } from '@contentworker/sdk-management';
import { describe, expect, it } from 'vitest';
import { EXIT } from '../src/output.js';
import { MAX_THUMBNAIL_BYTES } from '../src/thumbnails.js';
import { type Call, harness } from './harness.js';

const M = '/spaces/s1/environments/main';
const PUSH = `POST ${M}/block-catalog`;
const HERO_URL = 'https://cdn.site.test/img/hero.png';
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const plan = (over: Partial<BlockCatalogPush> = {}): BlockCatalogPush => ({
  dryRun: true,
  applied: false,
  unchanged: false,
  previousVersion: 2,
  version: 3,
  hash: 'h',
  changes: { added: [], changed: ['hero'], removed: [], renamed: [] },
  contentTypes: [],
  destructive: false,
  inUse: [],
  staleOverrides: [],
  warnings: [],
  ...over,
});

const block = (id: string, thumbnail?: unknown) => ({
  id,
  name: id,
  fields: [{ apiId: 'title', name: 'Title', type: 'Symbol' }],
  ...(thumbnail ? { thumbnail } : {}),
});

const image = (bytes: Uint8Array, type = 'image/png', headers: Record<string, string> = {}) =>
  new Response(bytes, { status: 200, headers: { 'content-type': type, ...headers } });

/**
 * A deployment whose asset library hashes each upload at once (ingest, in a real one, a few
 * seconds later), an image host, and a blocks file in its own folder.
 */
async function setup(
  blocks: unknown[],
  opts: { answer?: (body: Record<string, unknown>) => unknown; host?: () => Response } = {},
) {
  const pushes: Record<string, unknown>[] = [];
  const assets: { id: string; contentHash: string; kind: string }[] = [];
  const created: Record<string, unknown>[] = [];
  const lookups: string[] = [];
  let next = 0;
  const h = await harness(
    {
      [PUSH]: (call: Call) => {
        const body = JSON.parse(call.body ?? '{}') as Record<string, unknown>;
        pushes.push(body);
        return (opts.answer ?? ((b) => (b.dryRun ? plan() : plan({ applied: true }))))(body);
      },
      [`GET ${M}/assets`]: (call: Call) => {
        const q = new URL(call.url).searchParams;
        lookups.push(q.toString());
        const hash = q.get('contentHash');
        return { items: assets.filter((a) => a.contentHash === hash && a.kind === q.get('kind')) };
      },
      [`POST ${M}/assets`]: (call: Call) => {
        const input = JSON.parse(call.body ?? '{}') as Record<string, unknown>;
        created.push(input);
        const id = `asset-${++next}`;
        return new Response(
          JSON.stringify({
            asset: { id, status: 'draft' },
            upload: { url: `https://media.cms.test/put/${id}?sig=x`, headers: {} },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      },
      [`GET ${HERO_URL}`]: () => (opts.host ?? (() => image(PNG)))(),
    },
    {
      env: {
        CONTENTWORKER_TOKEN: 't',
        CONTENTWORKER_URL: 'https://api.cms.test',
        CONTENTWORKER_SPACE: 's1',
      },
    },
  );
  // The signed PUT carries the bytes; the library "ingests" them there.
  const wrapped = h.io.fetch;
  (h.io as { fetch: typeof fetch }).fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === 'PUT' && url.origin === 'https://media.cms.test') {
      const id = url.pathname.split('/').pop() ?? '';
      assets.push({ id, contentHash: sha(init.body as Uint8Array), kind: 'image' });
      return new Response(null, { status: 200 });
    }
    return wrapped(input, init);
  }) as typeof fetch;
  const dir = await mkdtemp(join(tmpdir(), 'cw-thumbs-'));
  const file = join(dir, 'contentworker.blocks.json');
  await writeFile(
    file,
    JSON.stringify({ targets: [{ contentTypeApiId: 'page', field: 'body' }], blocks }),
  );
  const fetched = () => h.calls.filter((c) => c.url === HERO_URL).length;
  return { h, file, dir, pushes, assets, created, lookups, fetched };
}

const thumbOf = (push: Record<string, unknown> | undefined, id: string) =>
  ((push?.blocks ?? []) as { id: string; thumbnail?: unknown }[]).find((b) => b.id === id)
    ?.thumbnail;

describe('blocks push imports URL and file thumbnails as assets', () => {
  it('uploads an https image once, pushes { assetId }, and reuses it on the next push', async () => {
    const s = await setup([block('hero', { url: HERO_URL }), block('banner', { url: HERO_URL })]);
    const first = await s.h.run('blocks', 'push', s.file, '--yes', '--json');
    expect(first.code).toBe(EXIT.ok);
    // Two blocks, one image: fetched once, uploaded once, as a draft named for the first block.
    expect(s.fetched()).toBe(1);
    expect(s.created).toEqual([{ fileName: 'hero-thumbnail.png', contentType: 'image/png' }]);
    expect(s.lookups[0]).toContain(`contentHash=${sha(PNG)}`);
    // The plan was shown with the URL (nothing uploaded before the go-ahead); the push has the asset.
    expect(thumbOf(s.pushes[0], 'hero')).toEqual({ url: HERO_URL });
    expect(thumbOf(s.pushes[1], 'hero')).toEqual({ assetId: 'asset-1' });
    expect(thumbOf(s.pushes[1], 'banner')).toEqual({ assetId: 'asset-1' });
    expect(s.h.json().thumbnails).toEqual([
      {
        block: 'hero',
        source: HERO_URL,
        contentHash: sha(PNG),
        action: 'imported',
        assetId: 'asset-1',
      },
      {
        block: 'banner',
        source: HERO_URL,
        contentHash: sha(PNG),
        action: 'imported',
        assetId: 'asset-1',
      },
    ]);

    // The second push finds the bytes in the library: no upload, and the plan already has the asset.
    s.pushes.length = 0;
    const second = await s.h.run('blocks', 'push', s.file, '--yes');
    expect(second.code).toBe(EXIT.ok);
    expect(s.created).toHaveLength(1);
    expect(thumbOf(s.pushes[0], 'hero')).toEqual({ assetId: 'asset-1' });
    expect(thumbOf(s.pushes[1], 'hero')).toEqual({ assetId: 'asset-1' });
    expect(second.stderr).toContain(`thumbnail hero: ${HERO_URL} is asset asset-1`);
  });

  it('--dry-run reads and looks up, uploads nothing, and says what it would import', async () => {
    const s = await setup([block('hero', { url: HERO_URL })]);
    const out = await s.h.run('blocks', 'push', s.file, '--dry-run');
    expect(out.code).toBe(EXIT.ok);
    expect(out.stdout).toContain(`thumbnail hero: would import ${HERO_URL}`);
    expect(s.created).toHaveLength(0);
    expect(s.pushes).toHaveLength(1);
    expect(thumbOf(s.pushes[0], 'hero')).toEqual({ url: HERO_URL });
  });

  it('uploads nothing when the plan is refused', async () => {
    const s = await setup([block('hero', { url: HERO_URL })], {
      answer: () => plan({ destructive: true }),
    });
    const out = await s.h.run('blocks', 'push', s.file, '--yes');
    expect(out.code).toBe(EXIT.refused);
    expect(s.created).toHaveLength(0);
  });

  it('imports even when the catalog otherwise matches (a URL thumbnail pushed before)', async () => {
    const s = await setup([block('hero', { url: HERO_URL })], {
      answer: (b) => (b.dryRun ? plan({ unchanged: true }) : plan({ applied: true })),
    });
    expect((await s.h.run('blocks', 'push', s.file, '--yes')).code).toBe(EXIT.ok);
    expect(s.pushes).toHaveLength(2);
    expect(thumbOf(s.pushes[1], 'hero')).toEqual({ assetId: 'asset-1' });
  });

  it('imports { file } from the blocks file’s folder, and leaves { assetId } as it is', async () => {
    const s = await setup([
      block('hero', { file: 'thumbs/hero.webp' }),
      block('quote', { assetId: 'kept' }),
    ]);
    await mkdir(join(s.dir, 'thumbs'));
    await writeFile(join(s.dir, 'thumbs', 'hero.webp'), PNG);
    expect((await s.h.run('blocks', 'push', s.file, '--yes')).code).toBe(EXIT.ok);
    expect(s.created).toEqual([{ fileName: 'hero-thumbnail.webp', contentType: 'image/webp' }]);
    // Before the upload the plan has no thumbnail for it: a path means nothing to the server.
    expect(thumbOf(s.pushes[0], 'hero')).toBeUndefined();
    expect(thumbOf(s.pushes[1], 'hero')).toEqual({ assetId: 'asset-1' });
    expect(thumbOf(s.pushes[1], 'quote')).toEqual({ assetId: 'kept' });
  });

  it.each([
    [
      'a plain http URL',
      { url: 'http://cdn.site.test/hero.png' },
      undefined,
      EXIT.usage,
      'blocks[hero].thumbnail: http:// is not imported: the URL must be https',
    ],
    [
      'a page, not an image',
      { url: HERO_URL },
      () => image(new TextEncoder().encode('<html>'), 'text/html; charset=utf-8'),
      EXIT.failure,
      `${HERO_URL} is text/html, not an image the admin draws`,
    ],
    [
      'an image declared too large',
      { url: HERO_URL },
      () => image(PNG, 'image/png', { 'content-length': String(MAX_THUMBNAIL_BYTES + 1) }),
      EXIT.failure,
      `the image is larger than ${MAX_THUMBNAIL_BYTES} bytes`,
    ],
    [
      'an image that streams past the cap with no length',
      { url: HERO_URL },
      () => image(new Uint8Array(MAX_THUMBNAIL_BYTES + 1)),
      EXIT.failure,
      `the image is larger than ${MAX_THUMBNAIL_BYTES} bytes`,
    ],
    [
      'a missing image',
      { url: HERO_URL },
      () => new Response('gone', { status: 404 }),
      EXIT.failure,
      `fetching ${HERO_URL} answered 404`,
    ],
    [
      'a local file that is not an image',
      { file: 'notes.txt' },
      undefined,
      EXIT.usage,
      'notes.txt is not an image the admin draws',
    ],
    [
      'a local file that is not there',
      { file: 'missing.png' },
      undefined,
      EXIT.usage,
      'missing.png: no such file',
    ],
  ])(
    'refuses %s, naming the block, before anything is pushed or uploaded',
    async (_, thumbnail, host, code, message) => {
      const s = await setup([block('hero', thumbnail)], host ? { host } : {});
      const out = await s.h.run('blocks', 'push', s.file, '--yes', '--json');
      expect(out.code).toBe(code);
      const error = JSON.parse(out.stderr).error;
      expect(error.code).toBe('thumbnail_refused');
      expect(error.message).toContain('blocks[hero].thumbnail: ');
      expect(error.message).toContain(message);
      expect(s.pushes).toHaveLength(0);
      expect(s.created).toHaveLength(0);
    },
  );
});
