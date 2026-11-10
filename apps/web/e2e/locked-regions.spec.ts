import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, expect, type Page, type TestInfo, test } from '@playwright/test';
import { api, openCms, SPACE, seedCms } from './cms';
import { guestPort } from './live-guest/port';
import { settle } from './settle';

/**
 * Locked regions on the canvas, end to end, in an environment of its own (the other specs share
 * `main`): a section locked from the inspector draws no seams inside it, an outline with a lock and
 * "Locked by" in Layers, and keeps its place; a save through the api that would remove it is
 * refused (422 `region_locked`); unlocked, it moves and removes again, and the draft saves. Below
 * md the canvas is review-only: the lock shows, and nothing offers to lock or unlock.
 */
const GUEST = `http://localhost:${guestPort()}`;
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const sym = (apiId: string, name: string, position = 0) => ({
  apiId,
  name,
  type: 'Symbol',
  localized: false,
  required: false,
  position,
});

test.beforeAll(async ({ request }) => {
  await seedCms(request);
});

/** An environment with a page type framed on the guest page, and one entry of it. */
async function lockedPage(page: Page, request: APIRequestContext, tag: string) {
  const env = `locks${tag}${Date.now().toString(36)}`;
  const mgmt = `/spaces/${SPACE}/environments/${env}`;
  const made = await api(request, 'POST', `/spaces/${SPACE}/environments`, { id: env });
  expect(made.status(), await made.text()).toBe(201);
  const type = await api(request, 'POST', `${mgmt}/content-types`, {
    apiId: 'lockPage',
    name: 'Lock page',
    displayField: 'title',
    fields: [
      sym('title', 'Title'),
      {
        apiId: 'body',
        name: 'Main',
        type: 'Array',
        localized: false,
        required: false,
        position: 1,
        items: {
          type: 'Component',
          variants: [
            { apiId: 'hero', name: 'Hero', fields: [sym('heading', 'Heading')] },
            { apiId: 'cta', name: 'Call to action', fields: [sym('label', 'Label')] },
            {
              apiId: 'section',
              name: 'Section',
              fields: [
                sym('heading', 'Heading'),
                {
                  apiId: 'items',
                  name: 'Cards',
                  type: 'Array',
                  localized: false,
                  required: false,
                  position: 1,
                  items: {
                    type: 'Component',
                    variants: [{ apiId: 'card', name: 'Card', fields: [sym('title', 'Title')] }],
                  },
                },
              ],
            },
          ],
        },
      },
    ],
    preview: {
      urlTemplate: `${GUEST}/?entry={id}&type=lockPage&space={space}&env={environment}#token={token}`,
    },
  });
  expect([200, 201], await type.text()).toContain(type.status());
  const entry = await api(request, 'POST', `${mgmt}/entries`, {
    contentTypeApiId: 'lockPage',
    fields: {
      title: { 'en-US': 'Locked page' },
      body: {
        'en-US': [
          { _type: 'hero', _key: 'h1', heading: 'Welcome' },
          {
            _type: 'section',
            _key: 's1',
            heading: 'Legal',
            items: [{ _type: 'card', _key: 'c1', title: 'Terms' }],
          },
          { _type: 'cta', _key: 'a1', label: 'Start' },
        ],
      },
    },
  });
  expect(entry.ok(), await entry.text()).toBe(true);
  const id = ((await entry.json()) as { entry: { id: string } }).entry.id;
  await page.addInitScript(
    ([space, environment]) =>
      localStorage.setItem(
        'contentworker-scope',
        JSON.stringify({ space, environment, locale: 'en-US' }),
      ),
    [SPACE, env],
  );
  return { id, mgmt };
}

async function openCanvas(page: Page, id: string) {
  await openCms(page, `/content/lockPage/${id}/canvas`);
  const site = page
    .frameLocator('iframe[title="Site preview"]')
    .frameLocator('iframe[title="The entry on your site"]');
  await expect(site.getByRole('heading', { level: 1 })).toHaveText('Locked page', {
    timeout: 15_000,
  });
  return site;
}

/** axe over the whole canvas, WCAG 2.1 A/AA. */
async function scan(page: Page, testInfo: TestInfo, name: string) {
  await settle(page);
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  if (results.violations.length > 0) {
    await testInfo.attach(`axe-${name}.json`, {
      body: JSON.stringify(results.violations, null, 2),
      contentType: 'application/json',
    });
  }
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    name,
  ).toEqual([]);
}

test('a section locked on the canvas keeps its place, refuses a save that breaks it, and unlocks', async ({
  page,
  request,
}, testInfo) => {
  const { id, mgmt } = await lockedPage(page, request, String(testInfo.workerIndex));
  const site = await openCanvas(page, id);
  const settings = page.getByRole('complementary', { name: 'Block settings' });

  // Unlocked, the section's cards take a seam.
  await expect(page.locator('[data-seam^="body[s1].items"]')).not.toHaveCount(0);
  await page.getByRole('button', { name: 'Layers' }).click();
  const tree = page.getByRole('tree', { name: 'Main blocks' });
  await tree.getByRole('treeitem', { name: /^Section/ }).click();
  await expect(settings.getByRole('button', { name: 'Remove Section' })).toBeVisible();
  await expect(
    settings.getByRole('radio', { name: 'This block and everything inside' }),
  ).toBeChecked();
  await expect(
    settings.getByRole('checkbox', { name: 'Also freeze the content' }),
  ).not.toBeChecked();
  await scan(page, testInfo, 'lock-panel');

  // Lock it: no seams inside it, an outline with a lock, who locked it, and no move or remove.
  await settings.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(page.getByText('Locked', { exact: true }).first()).toBeVisible();
  await expect(page.locator('[data-seam^="body[s1].items"]')).toHaveCount(0);
  await expect(page.locator('[data-seam="body#1"]')).toHaveCount(1);
  await expect(page.locator('[data-region-outline]')).toHaveCount(1);
  await expect(tree.getByRole('treeitem', { name: /^Section/ })).toContainText(/Locked by you/);
  await expect(settings.getByText(/^Section is locked: it keeps its place/)).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Remove Section' })).toHaveCount(0);
  await expect(settings.getByRole('button', { name: 'Move Section up' })).toHaveCount(0);
  await expect(settings.getByRole('button', { name: 'Unlock' })).toBeVisible();
  await scan(page, testInfo, 'locked');

  // A save through the api that removes it is refused, naming the region.
  const held = (await (await api(request, 'GET', `${mgmt}/entries/${id}/block-locks`)).json()) as {
    version: number;
    locks: { keys: string[]; lockedBy?: string }[];
  };
  expect(held.locks.map((l) => l.keys)).toEqual([['s1']]);
  const refused = await api(request, 'PUT', `${mgmt}/entries/${id}`, {
    expectedVersion: held.version,
    fields: {
      title: { 'en-US': 'Locked page' },
      body: {
        'en-US': [
          { _type: 'hero', _key: 'h1', heading: 'Welcome' },
          { _type: 'cta', _key: 'a1', label: 'Start' },
        ],
      },
    },
  });
  expect(refused.status(), await refused.text()).toBe(422);
  const body = (await refused.json()) as { error: { issues: { code: string; key?: string }[] } };
  expect(body.error.issues).toContainEqual(
    expect.objectContaining({ code: 'region_locked', key: 's1' }),
  );

  // Unlocked, it moves and removes again, and the draft saves.
  await settings.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByText('Unlocked', { exact: true }).first()).toBeVisible();
  await expect(page.locator('[data-region-outline]')).toHaveCount(0);
  await expect(page.locator('[data-seam^="body[s1].items"]')).not.toHaveCount(0);
  await settings.getByRole('button', { name: 'Remove Section' }).click();
  await expect(site.locator('#app > [data-cw-slot] > section')).toHaveText(['Welcome', 'Start']);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft updated')).toBeVisible();
});

test('neighbours shift-selected in Layers lock together: nothing goes between them', async ({
  page,
  request,
}, testInfo) => {
  const { id, mgmt } = await lockedPage(page, request, `r${testInfo.workerIndex}`);
  await openCanvas(page, id);
  await expect(page.locator('[data-seam="body#1"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Layers' }).click();
  const tree = page.getByRole('tree', { name: 'Main blocks' });
  await tree.getByRole('treeitem', { name: /^Hero/ }).click();
  await page.keyboard.press('Shift+ArrowDown');
  await expect(tree.getByRole('treeitem', { name: /^Section/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const settings = page.getByRole('complementary', { name: 'Block settings' });
  await expect(settings.getByText('2 blocks together: Hero, Section.')).toBeVisible();
  await scan(page, testInfo, 'run');
  await settings.getByRole('button', { name: 'Lock 2 blocks' }).click();
  await expect(page.getByText('Locked 2 blocks', { exact: true }).first()).toBeVisible();
  // No seam between them; after them, yes.
  await expect(page.locator('[data-seam="body#1"]')).toHaveCount(0);
  await expect(page.locator('[data-seam="body#2"]')).toHaveCount(1);
  const held = (await (await api(request, 'GET', `${mgmt}/entries/${id}/block-locks`)).json()) as {
    locks: { keys: string[]; depth: string }[];
  };
  expect(held.locks).toEqual([expect.objectContaining({ keys: ['h1', 's1'], depth: 'subtree' })]);
});

test('below md the canvas reviews a locked region: the lock shows, nothing offers to lock', async ({
  page,
  request,
}, testInfo) => {
  const { id, mgmt } = await lockedPage(page, request, `n${testInfo.workerIndex}`);
  const read = (await (await api(request, 'GET', `${mgmt}/entries/${id}/block-locks`)).json()) as {
    version: number;
  };
  const set = await api(request, 'PUT', `${mgmt}/entries/${id}/block-locks`, {
    expectedVersion: read.version,
    locks: [{ field: 'body', keys: ['h1', 's1'] }],
  });
  expect(set.status(), await set.text()).toBe(200);
  await page.setViewportSize({ width: 700, height: 900 });
  await openCanvas(page, id);
  await expect(page.getByText(/Arranging blocks needs a wider screen/)).toBeVisible();
  await expect(page.locator('[data-seam]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Layers' }).click();
  const layers = page.getByRole('dialog', { name: 'Layers' });
  // A run of two: who locked it is said once, on its first block.
  await expect(layers.getByRole('treeitem', { name: /^Hero/ })).toContainText(/Locked by you/);
  await expect(layers.getByRole('treeitem', { name: /^Section/ })).toContainText(/locked/);
  await expect(page.getByRole('button', { name: 'Unlock' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Lock', exact: true })).toHaveCount(0);
  await scan(page, testInfo, 'narrow-locked');
});
