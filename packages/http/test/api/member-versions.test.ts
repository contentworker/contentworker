import type { ApiConfig } from '@contentworker/platform/config';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

/**
 * `PATCH /members/:id` held to the version the person was read at: adding and changing someone
 * answers `version` (and the team lists it), a stale `expectedVersion` is a 409 naming the version
 * in force with nothing written, and a body without one changes only the fields it names.
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

const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
type Person = { id: string; name?: string; disabled: boolean; version: number };

function makeApp() {
  const wired = wire(config);
  return createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
}
type App = ReturnType<typeof makeApp>;
const send = (app: App, method: string, path: string, body?: unknown) =>
  app.request(`/spaces/s1${path}`, {
    method,
    headers: admin,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('a person’s version over HTTP', () => {
  it('answers the version on add, change and the team list', async () => {
    const app = makeApp();
    const added = await send(app, 'POST', '/members', {
      email: 'ada@example.com',
      name: 'Ada',
      role: 'editor',
    });
    expect(added.status).toBe(201);
    const ada = (await added.json()) as Person;
    expect(ada.version).toBe(1);
    const changed = await send(app, 'PATCH', `/members/${ada.id}`, { disabled: true });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ disabled: true, version: 2 });
    const team = (await (await send(app, 'GET', '/team')).json()) as { people: Person[] };
    expect(team.people.find((p) => p.id === ada.id)?.version).toBe(2);
  });

  it('refuses a stale expectedVersion with 409 and the version in force, writing nothing', async () => {
    const app = makeApp();
    const ada = (await (
      await send(app, 'POST', '/members', { email: 'ada@example.com', role: 'editor' })
    ).json()) as Person;
    await send(app, 'PATCH', `/members/${ada.id}`, { disabled: true });

    const stale = await send(app, 'PATCH', `/members/${ada.id}`, {
      name: 'Mine',
      expectedVersion: 1,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: 'conflict', details: { version: 2 } },
    });
    const team = (await (await send(app, 'GET', '/team')).json()) as { people: Person[] };
    expect(team.people.find((p) => p.id === ada.id)).toMatchObject({
      disabled: true,
      version: 2,
    });
    expect(team.people.find((p) => p.id === ada.id)?.name).toBeUndefined();

    // At the version in force it goes through, and keeps what the other change did.
    const matched = await send(app, 'PATCH', `/members/${ada.id}`, {
      name: 'Mine',
      expectedVersion: 2,
    });
    expect(await matched.json()).toMatchObject({ name: 'Mine', disabled: true, version: 3 });
  });

  it('validates expectedVersion', async () => {
    const app = makeApp();
    const ada = (await (
      await send(app, 'POST', '/members', { email: 'ada@example.com', role: 'editor' })
    ).json()) as Person;
    for (const expectedVersion of [0, 1.5, 'one']) {
      const res = await send(app, 'PATCH', `/members/${ada.id}`, { name: 'X', expectedVersion });
      expect(res.status).toBe(422);
    }
  });

  it('answers 404 for a change to someone removed, and never brings them back', async () => {
    const app = makeApp();
    const ada = (await (
      await send(app, 'POST', '/members', { email: 'ada@example.com', role: 'editor' })
    ).json()) as Person;
    expect((await send(app, 'DELETE', `/members/${ada.id}`)).status).toBe(204);
    const late = await send(app, 'PATCH', `/members/${ada.id}`, {
      name: 'Late',
      expectedVersion: 1,
    });
    expect(late.status).toBe(404);
    const team = (await (await send(app, 'GET', '/team')).json()) as { people: Person[] };
    expect(team.people).toEqual([]);
  });
});
