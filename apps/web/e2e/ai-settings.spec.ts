import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { api, openCms, SPACE, seedCms, useCmsScope } from './cms';
import { settle } from './settle';

/**
 * Settings → AI: a row per capability, saved with one Save against the version read, and a save
 * someone else beat keeps the edits and offers Load the latest. The space is shared with the other
 * specs, so this one only changes a tier and guidance (the mock model ignores both) and turns a
 * capability off only through a stubbed read. Desktop Chrome with the axe sweep.
 */
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

type Settings = {
  version: number;
  capabilities: Record<string, { enabled: boolean; tier: string | null; guidance: string | null }>;
};

const read = async (request: Parameters<typeof api>[0]) =>
  (await (await api(request, 'GET', `/spaces/${SPACE}/ai-settings`)).json()) as Settings;

test.beforeAll(async ({ request }) => {
  await seedCms(request);
});

test.beforeEach(async ({ page }) => {
  await useCmsScope(page);
});

test('saves a tier and guidance, and a save someone beat keeps the edits', async ({
  page,
  request,
}, testInfo) => {
  const guidance = `House style ${testInfo.project.name} ${Date.now()}`;
  await openCms(page, '/settings/ai');
  const translation = page.getByRole('listitem').filter({
    has: page.getByRole('heading', { name: 'Translation', exact: true }),
  });
  await expect(page.getByRole('switch', { name: 'Translation', exact: true })).toBeChecked();
  await settle(page);
  const results = await new AxeBuilder({ page }).withTags(WCAG).include('main').analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.target}`)).toEqual([]);

  await translation.getByLabel('Guidance').fill(guidance);
  await expect(translation.getByText(`${guidance.length} of 2,000 characters`)).toBeVisible();
  await translation.getByLabel('Model tier').click();
  await page.getByRole('option', { name: /^Fast/ }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('AI settings saved')).toBeVisible();
  const saved = await read(request);
  expect(saved.capabilities.translation).toMatchObject({ enabled: true, tier: 'fast', guidance });

  // Someone else saves behind the page, then this one tries to.
  const behind = await api(request, 'PUT', `/spaces/${SPACE}/ai-settings`, {
    expectedVersion: saved.version,
    capabilities: { translation: { enabled: true, tier: 'balanced', guidance } },
  });
  expect(behind.ok(), await behind.text()).toBe(true);
  await translation.getByLabel('Guidance').fill(`${guidance}!`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'changed since you opened them' });
  await expect(alert).toBeVisible();
  await expect(translation.getByLabel('Guidance')).toHaveValue(`${guidance}!`);
  await settle(page);
  const stale = await new AxeBuilder({ page }).withTags(WCAG).include('main').analyze();
  expect(stale.violations.map((v) => v.id)).toEqual([]);

  await alert.getByRole('button', { name: 'Load the latest' }).click();
  await expect(alert).toHaveCount(0);
  await expect(translation.getByLabel('Guidance')).toHaveValue(guidance);
  await expect(translation.getByLabel('Model tier')).toContainText('Balanced');

  // Leave the shared space as the other specs expect it.
  const now = await read(request);
  await api(request, 'PUT', `/spaces/${SPACE}/ai-settings`, {
    expectedVersion: now.version,
    capabilities: { translation: { enabled: true } },
  });
});

test('an entry offers no drafting where drafting is off', async ({ page }) => {
  // Read as off for this page only: the shared space stays as it is.
  await page.route(`**/spaces/${SPACE}/ai-settings`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const body = (await res.json()) as Settings;
    body.capabilities.drafting = { enabled: false, tier: null, guidance: null };
    await route.fulfill({ response: res, json: body });
  });
  await openCms(page, '/content/article/new');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate with AI' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Draft from prose' })).toHaveCount(0);
});
