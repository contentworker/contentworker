import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo, test } from '@playwright/test';
import { api, EDITOR_READY, MGMT, openCms, SPACE, seedCms, useCmsScope } from './cms';
import { guestPort } from './live-guest/port';
import { settle } from './settle';

/**
 * Live preview, end to end: a type whose preview URL points at the guest page (`e2e/live-guest`,
 * served by the config beside the admin, running the SDK's `startLivePreview`), an entry of it
 * opened in the editor, and the Site pane framing it. Typing re-renders the framed page before
 * anything is saved; clicking in the page focuses that field (or block) in the form.
 */
const GUEST = `http://localhost:${guestPort()}`;
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.beforeAll(async ({ request }) => {
  await seedCms(request);
  const type = await api(request, 'POST', `${MGMT}/content-types`, {
    apiId: 'landing',
    name: 'Landing',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: false,
        position: 0,
      },
      {
        apiId: 'body',
        name: 'Body',
        type: 'Array',
        localized: false,
        required: false,
        position: 1,
        items: {
          type: 'Component',
          variants: [
            {
              apiId: 'cta',
              name: 'Call to action',
              fields: [
                {
                  apiId: 'label',
                  name: 'Label',
                  type: 'Symbol',
                  localized: false,
                  required: false,
                  position: 0,
                },
              ],
            },
          ],
        },
      },
    ],
    preview: {
      urlTemplate: `${GUEST}/?entry={id}&space={space}&env={environment}#token={token}`,
    },
  });
  expect([200, 201], await type.text()).toContain(type.status());
  await api(request, 'POST', `${MGMT}/content-types/landing/published`);
  // A frontend without the SDK: it loads, and never answers.
  const silent = await api(request, 'POST', `${MGMT}/content-types`, {
    apiId: 'silentPage',
    name: 'Silent page',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: false,
        position: 0,
      },
    ],
    preview: { urlTemplate: `${GUEST}/silent.html?entry={id}#token={token}` },
  });
  expect([200, 201], await silent.text()).toContain(silent.status());
  await api(request, 'POST', `${MGMT}/content-types/silentPage/published`);
});

/** axe over the side pane (and the frames in it), WCAG 2.1 A/AA. */
async function scanPane(page: Page, testInfo: TestInfo) {
  await settle(page);
  const results = await new AxeBuilder({ page }).withTags(WCAG).include('#entry-pane').analyze();
  if (results.violations.length > 0) {
    await testInfo.attach('axe-violations.json', {
      body: JSON.stringify(results.violations, null, 2),
      contentType: 'application/json',
    });
  }
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await useCmsScope(page);
});

async function landing(request: Parameters<typeof api>[0], title: string) {
  const res = await api(request, 'POST', `${MGMT}/entries`, {
    contentTypeApiId: 'landing',
    fields: {
      title: { 'en-US': title },
      body: { 'en-US': [{ _type: 'cta', _key: 'k1', label: 'Read the guide' }] },
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { entry: { id: string } }).entry.id;
}

test('the Site pane re-renders the framed page as you type, and a click there focuses the field', async ({
  page,
  request,
}, testInfo) => {
  const id = await landing(request, `Live ${testInfo.workerIndex}`);
  await openCms(page, `/content/landing/${id}`);
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible(EDITOR_READY);
  await page.getByRole('radio', { name: 'Site' }).click();

  const site = page
    .frameLocator('iframe[title="Site preview"]')
    .frameLocator('iframe[title="The entry on your site"]');
  await expect(site.getByRole('heading', { level: 1 })).toHaveText(`Live ${testInfo.workerIndex}`);
  await expect(page.getByText(`On ${GUEST}`)).toBeVisible();

  // Unsaved: the form says so, and the page shows it anyway.
  await page.locator('#field-title').fill('Typed, not saved');
  await expect(site.getByRole('heading', { level: 1 })).toHaveText('Typed, not saved');
  await expect(page.getByText('Unsaved changes')).toBeVisible();

  await page.getByRole('textbox', { name: /^Label/ }).fill('Start here');
  await expect(site.locator('[data-cw-block="k1"]')).toHaveText('Start here');

  // A click on the block selects it: its item in the blocks field takes focus.
  await site.locator('[data-cw-block="k1"]').click();
  await expect(page.getByRole('group', { name: 'Call to action block 1' })).toBeFocused();
  // A click on the title focuses the title field.
  await site.getByRole('heading', { level: 1 }).click();
  await expect(page.locator('#field-title')).toBeFocused();

  // Nothing typed reached the API.
  const saved = await api(request, 'GET', `/preview/${SPACE}/main/entries?sys.id=${id}&limit=1`);
  const { items } = (await saved.json()) as { items: { fields: { title?: string } }[] };
  expect(JSON.stringify(items[0]?.fields)).not.toContain('Typed, not saved');

  await scanPane(page, testInfo);
});

test('a site that never answers is shown as saved, with the guide to set it up', async ({
  page,
  request,
}, testInfo) => {
  const res = await api(request, 'POST', `${MGMT}/entries`, {
    contentTypeApiId: 'silentPage',
    fields: { title: { 'en-US': `Silent ${testInfo.workerIndex}` } },
  });
  expect(res.ok(), await res.text()).toBe(true);
  const { entry } = (await res.json()) as { entry: { id: string } };
  await openCms(page, `/content/silentPage/${entry.id}`);
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible(EDITOR_READY);
  await page.getByRole('radio', { name: 'Site' }).click();
  // The handshake's five seconds, then the plain state; the page itself still shows.
  await expect(page.getByRole('alert')).toContainText('This site doesn’t speak live preview yet', {
    timeout: 15_000,
  });
  await expect(page.getByRole('link', { name: 'Set up live preview' })).toBeVisible();
  const site = page
    .frameLocator('iframe[title="Site preview"]')
    .frameLocator('iframe[title="The entry on your site"]');
  await expect(site.getByRole('heading', { level: 1 })).toHaveText(
    'This page doesn’t run live preview',
  );
  await expect(
    page
      .getByRole('radiogroup', { name: 'Clicks in the page' })
      .getByRole('radio', { name: 'View' }),
  ).toBeChecked();
  await scanPane(page, testInfo);
});
