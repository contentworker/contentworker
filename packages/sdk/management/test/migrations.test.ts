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

  it('sends each authoring, load and driver call to its route', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(
        `${init?.method ?? 'GET'} ${String(input).replace('https://cms.test/spaces/s1/environments/main/migrations/runs', '')}${init?.body ? ` ${init.body}` : ''}`,
      );
      return Response.json({});
    }) as unknown as typeof fetch;
    const m = createManagementClient({ ...base, fetch: fetchImpl }).migrations;
    const model = { apiId: 'a', name: 'A', displayField: 't', fields: [] };
    await m.template('r1', 't 1');
    await m.proposeModel('r1', 't1', model);
    await m.script('r1', 't1');
    await m.setScript('r1', 't1', 'export default () => ({})');
    await m.tryScript('r1', 't1', { pageIds: ['p1'] });
    await m.approve('r1', 't1', 'd'.repeat(64));
    await m.reopen('r1', 't1', 'd'.repeat(64));
    await m.transform('r1', 't1', { after: 'p9' });
    await m.load('r1', 't1', { includeNeedsFix: true });
    await m.relink('r1');
    await m.redirects('r1', { template: 't1' });
    await m.publish('r1', { viaRelease: true, releaseTitle: 'Launch' });
    await m.start('r1');
    await m.approvePublish('r1');
    expect(calls).toEqual([
      'GET /r1/templates/t%201',
      `POST /r1/templates/t1/proposal ${JSON.stringify({ model })}`,
      'GET /r1/templates/t1/script',
      'PUT /r1/templates/t1/script {"script":"export default () => ({})"}',
      'POST /r1/templates/t1/try {"pageIds":["p1"]}',
      `POST /r1/templates/t1/approve {"reviewed":"${'d'.repeat(64)}"}`,
      `POST /r1/templates/t1/reopen {"reviewed":"${'d'.repeat(64)}"}`,
      'POST /r1/templates/t1/transform {"after":"p9"}',
      'POST /r1/templates/t1/load {"includeNeedsFix":true}',
      'POST /r1/relink {}',
      'POST /r1/redirects {"template":"t1"}',
      'POST /r1/publish {"viaRelease":true,"releaseTitle":"Launch"}',
      'POST /r1/start',
      'POST /r1/publish-approval {}',
    ]);
  });

  it('surfaces a stale review as a 409', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { error: { code: 'conflict', message: 'The template’s model or script changed' } },
        { status: 409 },
      ),
    ) as unknown as typeof fetch;
    const m = createManagementClient({ ...base, fetch: fetchImpl }).migrations;
    const err = await m.approve('r1', 't1', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManagementError);
    expect(err).toMatchObject({ status: 409, code: 'conflict' });
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
