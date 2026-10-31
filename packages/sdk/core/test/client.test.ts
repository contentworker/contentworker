import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryClient, DeliveryError } from '../src/index.js';

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
