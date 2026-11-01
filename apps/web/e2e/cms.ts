import type { APIRequestContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * The CMS specs' world: one space, `e2e`, with a published "article" content type, created
 * through the web app's own gateway (same origin, as the browser does) while sign-in is still
 * open (local development, nobody added yet: the person is a deployment admin). Every CMS spec
 * opens the admin scoped to it.
 */
export const SPACE = 'e2e';
export const MGMT = `/spaces/${SPACE}/environments/main`;
const JSON_HEADERS = { 'content-type': 'application/json' };

/** Same-origin API calls the way the CMS screens make them. */
export async function api(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  data?: unknown,
) {
  return request.fetch(path, {
    method,
    headers: JSON_HEADERS,
    ...(data === undefined ? {} : { data }),
  });
}

/** Creates the e2e space and its article type, once; a 409 (already there) is fine. */
export async function seedCms(request: APIRequestContext) {
  const space = await api(request, 'POST', '/spaces', {
    spaceId: SPACE,
    name: 'E2E',
    defaultLocale: 'en-US',
  });
  expect([200, 201, 409], await space.text()).toContain(space.status());
  const type = await api(request, 'POST', `${MGMT}/content-types`, {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: true,
        required: true,
        position: 0,
      },
      { apiId: 'body', name: 'Body', type: 'Text', localized: false, required: false, position: 1 },
      {
        apiId: 'content',
        name: 'Content',
        type: 'RichText',
        localized: false,
        required: false,
        position: 2,
      },
      // A repeater, so the nested editor has something to render.
      {
        apiId: 'callouts',
        name: 'Callouts',
        type: 'Array',
        localized: false,
        required: false,
        position: 3,
        items: {
          type: 'Component',
          fields: [
            {
              apiId: 'heading',
              name: 'Heading',
              type: 'Symbol',
              localized: false,
              required: true,
              position: 0,
            },
            {
              apiId: 'body',
              name: 'Body',
              type: 'Text',
              localized: false,
              required: false,
              position: 1,
            },
          ],
        },
      },
    ],
  });
  expect([200, 201, 409], await type.text()).toContain(type.status());
  await api(request, 'POST', `${MGMT}/content-types/article/published`);
}

/**
 * Scopes the admin to the e2e space before the page loads, and fails the test on React's own
 * rendering complaints (duplicate keys and the like) rather than letting them scroll past.
 */
export async function useCmsScope(page: Page) {
  await page.addInitScript((space) => {
    localStorage.setItem(
      'contentworker-scope',
      JSON.stringify({ space, environment: 'main', locale: 'en-US' }),
    );
  }, SPACE);
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (!/same key|Each child in a list|Warning: React/i.test(text)) return;
    throw new Error(`React reported a rendering error:\n${text}`);
  });
}

/**
 * Waiting for the editor to mount also guards against it failing to. Kept modest: if the editor
 * is not up in 15s something is wrong.
 */
export const EDITOR_READY = { timeout: 15_000 };

/**
 * Opens a CMS page and waits until it is hydrated and styled. Not `networkidle` (helpers' `open`):
 * the overview holds the Live Content API's event stream open, so the network never goes idle.
 */
export async function openCms(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'load' });
  await page.waitForFunction(
    () =>
      getComputedStyle(document.body).overscrollBehaviorY === 'none' &&
      Boolean((window as unknown as { __reactRouterDataRouter?: object }).__reactRouterDataRouter),
  );
}

/**
 * Shows the admin a deployment with no spaces but `keep`: the e2e database is shared by specs
 * running side by side, so instead of a database of its own, a spec that needs the first-run
 * screens filters `GET /spaces` down to the spaces it creates itself.
 */
export async function asFreshDeployment(page: Page, keep: (id: string) => boolean) {
  await page.route(
    (url) => url.pathname === '/spaces',
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const body = (await res.json()) as { items: { id: string }[] };
      await route.fulfill({ response: res, json: { items: body.items.filter((s) => keep(s.id)) } });
    },
  );
}
