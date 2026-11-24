import { describe, expect, it, vi } from 'vitest';
import { createManagementClient, ManagementError } from '../src/index.js';

const base = { baseUrl: 'https://cms.test', space: 's1', environment: 'main', token: 'cma' };

describe('@contentworker/sdk-management migrations', () => {
  it('sends each call to its route', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(
        `${init?.method ?? 'GET'} ${String(input).replace('https://cms.test/spaces/s1/environments/main', '')}${init?.body ? ` ${init.body}` : ''}`,
      );
      return Response.json({ items: [], more: false });
    }) as unknown as typeof fetch;
    const client = createManagementClient({ ...base, fetch: fetchImpl });
    await client.migrations.create({ source: { kind: 'sitemap', url: 'https://old.test/' } });
    await client.migrations.list({ limit: 5 });
    await client.migrations.get('r 1');
    await client.migrations.inventory('r1');
    await client.migrations.fetchPages('r1', { limit: 10 });
    await client.migrations.fetchPages('r1');
    await client.migrations.cluster('r1', { threshold: 0.5 });
    await client.migrations.pages('r1', { stage: 'discovered', limit: 2, cursor: 'p9' });
    await client.migrations.templates('r1');
    expect(calls).toEqual([
      'POST /migrations/runs {"source":{"kind":"sitemap","url":"https://old.test/"}}',
      'GET /migrations/runs?limit=5',
      'GET /migrations/runs/r%201',
      'POST /migrations/runs/r1/inventory',
      'POST /migrations/runs/r1/fetch {"limit":10}',
      'POST /migrations/runs/r1/fetch {}',
      'POST /migrations/runs/r1/cluster {"threshold":0.5}',
      'GET /migrations/runs/r1/pages?stage=discovered&limit=2&cursor=p9',
      'GET /migrations/runs/r1/templates',
    ]);
  });

  it('surfaces a refusal as a ManagementError with the API’s status and code', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        {
          error: {
            code: 'site_unavailable',
            message: 'The site can’t be read now',
            retryable: true,
          },
        },
        { status: 503 },
      ),
    ) as unknown as typeof fetch;
    const client = createManagementClient({ ...base, fetch: fetchImpl });
    const err = await client.migrations.inventory('r1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManagementError);
    expect(err).toMatchObject({ status: 503 });
  });
});
