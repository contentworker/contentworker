import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assetUrl,
  createDeliveryClient,
  type DeliveredAsset,
  DeliveryError,
  srcset,
} from '../src/index.js';

function fakeFetch(handler: (url: string, init?: RequestInit) => unknown) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = handler(url, init);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const base = { baseUrl: 'https://cms.test', space: 's1', environment: 'main', token: 'cda-tok' };

describe('@contentworker/sdk-core delivery client', () => {
  let calls: { url: string; init?: RequestInit }[];
  beforeEach(() => {
    calls = [];
  });

  it('builds scoped URLs, sends the bearer token, and passes query params', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      calls.push({ url, init });
      return { id: 'e1', contentType: 'article', fields: { title: 'Hi' }, publishedAt: 'now' };
    });
    const client = createDeliveryClient({ ...base, fetch: fetchImpl });

    const entry = await client.getEntry('e1', { locale: 'de-DE', include: 2 });
    expect(entry.fields.title).toBe('Hi');
    const call = calls[0];
    expect(call?.url).toBe('https://cms.test/delivery/s1/main/entries/e1?locale=de-DE&include=2');
    expect((call!.init!.headers as Record<string, string>).authorization).toBe('Bearer cda-tok');
  });

  it('lists entries via the query builder', async () => {
    const fetchImpl = fakeFetch((url) => {
      calls.push({ url });
      return {
        items: [{ id: 'a', contentType: 'article', fields: {}, publishedAt: 'now' }],
        total: 1,
      };
    });
    const client = createDeliveryClient({ ...base, fetch: fetchImpl });
    const res = await client.query().contentType('article').locale('en-US').limit(5).fetch();
    expect(res.total).toBe(1);
    expect(calls[0]?.url).toContain('content_type=article');
    expect(calls[0]?.url).toContain('locale=en-US');
    expect(calls[0]?.url).toContain('limit=5');
  });

  it('caches responses within the TTL', async () => {
    const fetchImpl = fakeFetch(() => ({
      id: 'e1',
      contentType: 'a',
      fields: {},
      publishedAt: 'now',
    }));
    const client = createDeliveryClient({ ...base, fetch: fetchImpl, cacheTtlMs: 1000 });
    await client.getEntry('e1');
    await client.getEntry('e1');
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1); // second served from cache
  });

  it('maps non-2xx responses to DeliveryError with the status', async () => {
    const fetchImpl = fakeFetch(() => new Response('nope', { status: 404 }));
    const client = createDeliveryClient({ ...base, fetch: fetchImpl });
    await expect(client.getEntry('missing')).rejects.toBeInstanceOf(DeliveryError);
    await expect(client.getEntry('missing')).rejects.toMatchObject({ status: 404 });
  });

  it('hits the search endpoint and unwraps hits', async () => {
    const fetchImpl = fakeFetch((url) => {
      calls.push({ url });
      return { hits: [{ entryId: 'e1', score: 0.9, snippet: 'x' }] };
    });
    const client = createDeliveryClient({ ...base, fetch: fetchImpl });
    const hits = await client.search('database', { topK: 3 });
    expect(hits[0]?.entryId).toBe('e1');
    expect(calls[0]?.url).toContain('/search?q=database&top_k=3');
  });
});

const image: DeliveredAsset = {
  id: 'a1',
  title: 'Hero',
  description: null,
  altText: 'A hill',
  focalPoint: { x: 0.5, y: 0.25 },
  contentType: 'image/jpeg',
  size: 1000,
  width: 1000,
  height: 600,
  kind: 'image',
  url: 'https://media.test/s1/main/a1/v1/Q2p8kT1vXn4bR7sW0yZa3c/o/hero.jpg',
  renditions: { thumb: 'https://media.test/s1/main/a1/v1/Q2p8kT1vXn4bR7sW0yZa3c/r-thumb/hero.jpg' },
  srcset: [
    {
      width: 320,
      url: 'https://media.test/s1/main/a1/v1/Q2p8kT1vXn4bR7sW0yZa3c/w320/hero.jpg?fm=auto',
    },
    {
      width: 640,
      url: 'https://media.test/s1/main/a1/v1/Q2p8kT1vXn4bR7sW0yZa3c/w640/hero.jpg?fm=auto',
    },
    {
      width: 960,
      url: 'https://media.test/s1/main/a1/v1/Q2p8kT1vXn4bR7sW0yZa3c/w960/hero.jpg?fm=auto',
    },
  ],
  file: { url: 'https://media.test/s1/main/a1/v1/Q2p8kT1vXn4bR7sW0yZa3c/o/hero.jpg' },
};

describe('assets', () => {
  it('gets and lists assets on the delivery surface, with paging and filters', async () => {
    const calls: string[] = [];
    const fetchImpl = fakeFetch((url) => {
      calls.push(url);
      return url.includes('/assets/') ? image : { items: [image], total: 1, nextCursor: 'c2' };
    });
    const client = createDeliveryClient({ ...base, fetch: fetchImpl });

    expect((await client.getAsset('a1', { locale: 'de-DE' })).id).toBe('a1');
    expect(calls[0]).toBe('https://cms.test/delivery/s1/main/assets/a1?locale=de-DE');

    const page = await client.listAssets({
      limit: 10,
      cursor: 'c1',
      skip: 5,
      kind: 'image',
      tag: 't1',
      folder: 'root',
      locale: 'en-US',
    });
    expect(page.nextCursor).toBe('c2');
    // A cursor wins over an offset.
    expect(calls[1]).toBe(
      'https://cms.test/delivery/s1/main/assets?limit=10&cursor=c1&kind=image&tag=t1&folder=root&locale=en-US',
    );
    await client.listAssets({ skip: 20 });
    expect(calls[2]).toBe('https://cms.test/delivery/s1/main/assets?skip=20');
  });

  it('searches published assets with ?q= and the filters', async () => {
    const calls: string[] = [];
    const client = createDeliveryClient({
      ...base,
      fetch: fakeFetch((url) => {
        calls.push(url);
        return { items: [image], total: 1, facets: { kind: { image: 1 }, tag: {}, folder: {} } };
      }),
    });
    const page = await client.searchAssets('red mug', { kind: 'image', folder: 'root', limit: 5 });
    expect(page.facets.kind).toEqual({ image: 1 });
    expect(calls[0]).toBe(
      'https://cms.test/delivery/s1/main/assets?q=red+mug&limit=5&kind=image&folder=root',
    );
  });

  it('reads drafts from the preview surface', async () => {
    const calls: string[] = [];
    const client = createDeliveryClient({
      ...base,
      preview: true,
      fetch: fakeFetch((url) => {
        calls.push(url);
        return image;
      }),
    });
    await client.getAsset('a1');
    expect(calls[0]).toBe('https://cms.test/preview/s1/main/assets/a1');
  });

  it('picks a rendition, the width step at or above, or the original', () => {
    expect(assetUrl(image)).toBe(image.url);
    expect(assetUrl(image, { rendition: 'thumb' })).toBe(image.renditions.thumb);
    expect(assetUrl(image, { rendition: 'nope' })).toBeUndefined();
    expect(assetUrl(image, { width: 500 })).toBe(image.srcset[1]?.url);
    expect(assetUrl(image, { width: 640 })).toBe(image.srcset[1]?.url);
    // Past the ladder: its largest step.
    expect(assetUrl(image, { width: 5000 })).toBe(image.srcset[2]?.url);
    // No ladder (a PDF, a video): the original.
    expect(assetUrl({ ...image, srcset: [] }, { width: 500 })).toBe(image.url);
    const client = createDeliveryClient(base);
    expect(client.assetUrl(image, { width: 1 })).toBe(image.srcset[0]?.url);
  });

  it('formats the ladder as an srcset value', () => {
    expect(srcset(image)).toBe(
      `${image.srcset[0]?.url} 320w, ${image.srcset[1]?.url} 640w, ${image.srcset[2]?.url} 960w`,
    );
    expect(srcset({ srcset: [] })).toBe('');
  });
});
