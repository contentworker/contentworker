import type { ApiConfig } from '@contentworker/platform/config';
import { createDeliveryClient, DeliveryError } from '@contentworker/sdk-core';
import { createManagementClient } from '@contentworker/sdk-management';
import { describe, expect, it } from 'vitest';
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
    locales: ['en-US', 'de'],
    scale: 1,
  },
});

const symbol = (apiId: string, position: number, localized = false) => ({
  apiId,
  name: apiId,
  type: 'Symbol' as const,
  localized,
  required: false,
  position,
});

function setup() {
  const wired = wire(config);
  const app = createApp(wired.ctx, config, wired.rag, wired.blob, wired.ai);
  const fetch = ((url: string | URL | Request, init?: RequestInit) =>
    app.request(String(url), init)) as typeof globalThis.fetch;
  const client = (token: string, preview = false) =>
    createDeliveryClient({
      baseUrl: 'http://localhost',
      space: 's1',
      environment: 'main',
      token,
      fetch,
      ...(preview ? { preview: true } : {}),
    });
  const cma = createManagementClient({
    baseUrl: '',
    space: 's1',
    environment: 'main',
    token: 'admin',
    fetch,
  });
  return { app, cma, cda: client('cda'), cpa: client('cpa', true) };
}

async function statusOf(p: Promise<unknown>): Promise<number> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  return (err as { status?: number } | null)?.status ?? 200;
}

/** Singletons over HTTP and the SDKs: one entry per type, read by the type's apiId. */
describe('singleton types over the API', () => {
  it('holds one entry, served by type from Delivery, Preview and GraphQL', async () => {
    const { app, cma, cda, cpa } = setup();
    await cma.contentTypes.create({
      apiId: 'page',
      name: 'Page',
      displayField: 'title',
      fields: [symbol('title', 0)],
    });
    await cma.contentTypes.publish('page');
    const settings = await cma.contentTypes.create({
      apiId: 'settings',
      name: 'Settings',
      displayField: 'title',
      singleton: true,
      fields: [
        symbol('title', 0, true),
        {
          apiId: 'home',
          name: 'Home',
          type: 'Link',
          linkType: 'Entry',
          localized: false,
          required: false,
          position: 1,
        },
      ],
    });
    expect(settings.singleton).toBe(true);
    await cma.contentTypes.publish('settings');

    const home = await cma.entries.create({
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': 'Home' } },
    });
    await cma.entries.publish(home.entry.id);
    const one = await cma.entries.create({
      contentTypeApiId: 'settings',
      fields: {
        title: { 'en-US': 'Site', de: 'Seite' },
        home: { 'en-US': { id: home.entry.id, linkType: 'Entry' } },
      },
    });
    // A second entry is refused with a conflict naming the first.
    const second = await app.request('/spaces/s1/environments/main/entries', {
      method: 'POST',
      headers: { Authorization: 'Bearer cma', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentTypeApiId: 'settings',
        fields: { title: { 'en-US': 'Again' } },
      }),
    });
    expect(second.status).toBe(409);
    expect(JSON.stringify(await second.json())).toContain(one.entry.id);

    // Preview has the draft; Delivery has nothing until it is published.
    expect((await cpa.getSingleton('settings', { locale: 'de' })).fields.title).toBe('Seite');
    expect(await statusOf(cda.getSingleton('settings'))).toBe(404);
    await cma.entries.publish(one.entry.id);
    const served = await cda.getSingleton<{ title: string; home: { fields: { title: string } } }>(
      'settings',
      { locale: 'en-US', include: 1 },
    );
    expect(served.id).toBe(one.entry.id);
    expect(served.fields.home.fields.title).toBe('Home');

    // An ordinary type is not served as a singleton.
    const ordinary = await cda.getSingleton('page').catch((e: unknown) => e);
    expect(ordinary).toBeInstanceOf(DeliveryError);
    expect((ordinary as DeliveryError).status).toBe(404);

    // GraphQL: the singleton's root takes no id.
    const res = await app.request('/delivery/s1/main/graphql', {
      method: 'POST',
      headers: { Authorization: 'Bearer cda', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ settings(locale: "de") { _sys { id } title } }' }),
    });
    const body = (await res.json()) as { data?: { settings?: { _sys: { id: string } } } };
    expect(body.data?.settings).toEqual({ _sys: { id: one.entry.id }, title: 'Seite' });
  });

  it('refuses turning a type with several entries into a singleton', async () => {
    const { app, cma } = setup();
    const draft = {
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields: [symbol('title', 0)],
    };
    await cma.contentTypes.create(draft);
    for (const t of ['a', 'b']) {
      await cma.entries.create({ contentTypeApiId: 'note', fields: { title: { 'en-US': t } } });
    }
    const res = await app.request('/spaces/s1/environments/main/content-types', {
      method: 'POST',
      headers: { Authorization: 'Bearer cma', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...draft, singleton: true }),
    });
    expect(res.status).toBe(409);
    expect((await cma.contentTypes.get('note')).singleton).toBeUndefined();
  });
});
