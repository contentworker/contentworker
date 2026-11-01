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

describe('@contentworker/sdk-core read-your-writes (preview)', () => {
  // Real D1 bookmarks: hex groups joined by dashes, newer sorts later.
  const OLD = '00000001-00000010-00004f9b-0c3e87bb37b3db5cc52eedb93cd3b96b';
  const NEW = '00000001-00000033-00004f9b-0c3e87bb37b3db5cc52eedb93cd3b96b';
  const NEWER = '00000001-00000040-00004f9b-0c3e87bb37b3db5cc52eedb93cd3b96b';

  /** Answers each request with the next bookmark in `answers` (none once they run out). */
  function bookmarking(answers: (string | undefined)[], from?: string) {
    const sent: (string | undefined)[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sent.push((init?.headers as Record<string, string> | undefined)?.['x-cw-bookmark']);
      const answer = answers.shift();
      const res = new Response(JSON.stringify({ items: [], total: 0 }), {
        status: 200,
        headers: answer ? { 'x-cw-bookmark': answer } : {},
      });
      // What a redirect to another host leaves on the Response it resolves to.
      if (from) Object.defineProperty(res, 'url', { value: from });
      return res;
    }) as unknown as typeof fetch;
    return { sent, fetchImpl };
  }

  it('sends nothing first, then the bookmark of the last response', async () => {
    const { sent, fetchImpl } = bookmarking([OLD, NEW]);
    const client = createDeliveryClient({ ...base, preview: true, fetch: fetchImpl });

    await client.listEntries();
    await client.listEntries();
    await client.listEntries();
    expect(sent).toEqual([undefined, OLD, NEW]);
    expect(client.bookmark).toBe(NEW);
  });

  it('keeps the newest bookmark when concurrent responses arrive out of order', async () => {
    const { fetchImpl } = bookmarking([NEW, OLD]);
    const client = createDeliveryClient({ ...base, preview: true, fetch: fetchImpl });

    await client.listEntries();
    await client.listEntries();
    expect(client.bookmark).toBe(NEW);
  });

  it('starts from a seeded bookmark and can be handed one explicitly', async () => {
    const { sent, fetchImpl } = bookmarking([]);
    const client = createDeliveryClient({
      ...base,
      preview: true,
      bookmark: NEW,
      fetch: fetchImpl,
    });

    await client.listEntries();
    // Explicit replaces, even with an older one; garbage is dropped; undefined clears.
    client.bookmark = OLD;
    await client.listEntries();
    client.bookmark = 'not-a-bookmark';
    await client.listEntries();
    client.bookmark = NEWER;
    client.bookmark = undefined;
    await client.listEntries();
    expect(sent).toEqual([NEW, OLD, undefined, undefined]);
  });

  it('never sends or keeps one with readYourWrites: false', async () => {
    const { sent, fetchImpl } = bookmarking([NEW, NEW]);
    const client = createDeliveryClient({
      ...base,
      preview: true,
      readYourWrites: false,
      bookmark: OLD,
      fetch: fetchImpl,
    });

    await client.listEntries();
    client.bookmark = NEWER;
    await client.listEntries();
    expect(sent).toEqual([undefined, undefined]);
    expect(client.bookmark).toBeUndefined();
  });

  it('a Delivery client never sends one: the cached CDN ignores it and refuses the header', async () => {
    const { sent, fetchImpl } = bookmarking([NEW, NEW]);
    const client = createDeliveryClient({ ...base, bookmark: OLD, fetch: fetchImpl });

    await client.listEntries();
    await client.listEntries();
    expect(sent).toEqual([undefined, undefined]);
    expect(client.bookmark).toBeUndefined();
  });

  it('ignores a bookmark from a response that was redirected to another origin', async () => {
    const { sent, fetchImpl } = bookmarking([NEW, NEWER], 'https://elsewhere.test/x');
    const client = createDeliveryClient({
      ...base,
      preview: true,
      bookmark: OLD,
      fetch: fetchImpl,
    });

    await client.listEntries();
    await client.listEntries();
    expect(sent).toEqual([OLD, OLD]);
    expect(client.bookmark).toBe(OLD);
  });

  it('keeps the bookmark of a failed request', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{}', { status: 404, headers: { 'x-cw-bookmark': NEW } }),
    ) as unknown as typeof fetch;
    const client = createDeliveryClient({ ...base, preview: true, fetch: fetchImpl });

    await expect(client.getEntry('missing')).rejects.toBeInstanceOf(DeliveryError);
    expect(client.bookmark).toBe(NEW);
  });
});

describe('@contentworker/sdk-core read-your-writes on a relative baseUrl', () => {
  it('treats a relative baseUrl as same-origin', async () => {
    const BM = '00000001-00000033-00004f9b-0c3e87bb37b3db5cc52eedb93cd3b96b';
    const sent: (string | undefined)[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sent.push((init?.headers as Record<string, string> | undefined)?.['x-cw-bookmark']);
      return new Response('{"items":[],"total":0}', { headers: { 'x-cw-bookmark': BM } });
    }) as unknown as typeof fetch;
    const client = createDeliveryClient({ ...base, baseUrl: '', preview: true, fetch: fetchImpl });

    await client.listEntries();
    await client.listEntries();
    expect(sent).toEqual([undefined, BM]);
  });
});
