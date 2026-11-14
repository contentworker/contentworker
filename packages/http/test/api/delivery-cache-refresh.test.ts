import type { ApiConfig } from '@contentworker/platform/config';
import type { InMemoryContentStore } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

/**
 * `POST /spaces/:space/environments/:env/delivery-cache/refresh`: with `content:publish`, records
 * the refresh for the engine and answers 202 (the once-a-minute limit is the use-case's own test).
 */
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

function makeApp() {
  const wired = wire(config);
  const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
  const send = (path: string, token: string) =>
    app.request(path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
  return { wired, send };
}

const PATH = '/spaces/s1/environments/main/delivery-cache/refresh';

describe('Delivery cache refresh over HTTP', () => {
  it('accepts a refresh and records it for the engine', async () => {
    const { wired, send } = makeApp();
    const store = wired.ctx.store as InMemoryContentStore;
    const before = store.allEvents().length;
    const res = await send(PATH, 'admin');
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ enqueued: true, environmentId: 'main' });
    expect(store.allEvents().slice(before)).toMatchObject([
      { type: 'delivery.refresh_requested', scope: { spaceId: 's1', environmentId: 'main' } },
    ]);
  });

  it('refuses keys that cannot publish', async () => {
    const { send } = makeApp();
    expect((await send(PATH, 'cda')).status).toBe(403);
    expect((await send(PATH, 'cpa')).status).toBe(403);
  });

  it('answers 404 for an environment that does not exist', async () => {
    const { send } = makeApp();
    expect(
      (await send('/spaces/s1/environments/nope/delivery-cache/refresh', 'admin')).status,
    ).toBe(404);
  });
});
