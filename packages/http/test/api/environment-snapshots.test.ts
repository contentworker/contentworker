import type { ApiConfig } from '@contentworker/platform/config';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

const config: ApiConfig = testConfig({
  role: 'all',
  cmaKey: 'cma',
  cdaKey: 'cda',
  cpaKey: 'cpa',
  adminToken: 'admin',
  seed: {
    spaceId: 's1',
    environmentId: 'main',
    defaultLocale: 'en-US',
    locales: ['en-US'],
    scale: 1,
  },
});
const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
const MAIN = '/spaces/s1/environments/main';
const COPY = '/spaces/s1/environments/copy';

let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  const { ctx, rag, blob, ai } = wire(config);
  app = createApp(ctx, config, rag, blob, ai);
  await app.request(`${MAIN}/content-types`, {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({
      apiId: 'note',
      name: 'Note',
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
      ],
    }),
  });
  await app.request(`${MAIN}/content-types/note/published`, { method: 'POST', headers: admin });
  for (const title of ['One', 'Two']) {
    await app.request(`${MAIN}/entries`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ contentTypeApiId: 'note', fields: { title: { 'en-US': title } } }),
    });
  }
  await app.request('/spaces/s1/environments', {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ id: 'copy' }),
  });
});

type Started = {
  report: { entries: number; dryRun: boolean };
  job: { id: string; action: string; status: string; totalItems: number } | null;
  publishJobId: string | null;
};

describe('environment clone and import over HTTP', () => {
  it('clones entirely as jobs: 202 with the job to follow, nothing written in the request', async () => {
    const res = await app.request(`${MAIN}/clone`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ targetEnvironmentId: 'copy' }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      job: { id: string; action: string; status: string };
      createJobId: string;
      publishJobId: string;
    };
    expect(body.job).toMatchObject({ action: 'import', status: 'running' });
    expect(body.createJobId).toBeTruthy();
    const job = await app.request(`${COPY}/bulk/jobs/${body.job.id}`, { headers: admin });
    expect(job.status).toBe(200);
    // The export, the checks and the model all happen in the job.
    const types = (await (
      await app.request(`${COPY}/content-types`, { headers: admin })
    ).json()) as { items: unknown[] };
    expect(types.items).toEqual([]);
  });

  it('refuses at once a clone into an environment that already has content types', async () => {
    const res = await app.request(`${MAIN}/clone`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ targetEnvironmentId: 'main' }),
    });
    expect(res.status).toBe(422);
  });

  it('imports a snapshot as a job, and still answers a dry run synchronously', async () => {
    const snapshot = await (await app.request(`${MAIN}/export`, { headers: admin })).json();
    const dry = await app.request(`${COPY}/import?dryRun=true`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify(snapshot),
    });
    expect(dry.status).toBe(200);
    expect(((await dry.json()) as Started['report']).dryRun).toBe(true);
    const res = await app.request(`${COPY}/import`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify(snapshot),
    });
    expect(res.status).toBe(202);
    expect(((await res.json()) as Started).job?.status).toBe('running');
  });
});
