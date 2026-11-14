import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import {
  api,
  createDraft,
  EDITOR_READY,
  MGMT,
  openCms,
  seedAsset,
  seedCms,
  useCmsScope,
} from './cms';
import { settle } from './settle';

/**
 * AI projects in the admin: a project made over the API shows in Settings → AI projects with its
 * reference, its editor sheet passes the axe sweep, and Generate, under mock AI, works in the
 * project picked and says so on the draft. The space is shared with the other specs, so the
 * project is never the default (every AI call would take it) and is deleted after.
 */
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.beforeAll(async ({ request }) => {
  await seedCms(request);
});

test.beforeEach(async ({ page }) => {
  await useCmsScope(page);
});

async function axe(page: Page, include: string) {
  await settle(page);
  const results = await new AxeBuilder({ page }).withTags(WCAG).include(include).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.target}`)).toEqual([]);
}

test('a project is listed, edited in a sheet, and picked in Generate with provenance', async ({
  page,
  request,
}, testInfo) => {
  const name = `Brand voice ${testInfo.project.name} ${Date.now()}`;
  const guide = await seedAsset(request, `Brand guide ${Date.now()}`, {
    contentType: 'application/pdf',
  });
  const created = await api(request, 'POST', `${MGMT}/ai-projects`, {
    name,
    description: 'How we sound',
    instructions: 'Say “spec sheet”, never “datasheet”.',
    reader: { name: 'Procurement lead', description: 'Busy; wants numbers.' },
    references: [{ assetId: guide }],
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { id } = (await created.json()) as { id: string };
  try {
    await openCms(page, '/settings/ai-projects');
    const open = page.getByRole('button', { name: `Edit ${name}` });
    await expect(open).toBeVisible();
    await axe(page, 'main');

    await open.click();
    const sheet = page.getByRole('dialog', { name: 'Edit AI project' });
    await expect(sheet.getByLabel('Name', { exact: true })).toHaveValue(name);
    await expect(sheet.getByRole('list', { name: 'References' })).toContainText('Brand guide');
    await expect(sheet.getByText(/^\d+ of 4,000 characters$/)).toBeVisible();
    await axe(page, '[role="dialog"]');
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    await expect(sheet).toHaveCount(0);

    const entry = await createDraft(request, `Project draft ${Date.now()}`);
    await openCms(page, `/content/article/${entry}`);
    await page.getByRole('button', { name: 'AI', exact: true }).click(EDITOR_READY);
    await page.getByRole('menuitem', { name: 'Generate with AI' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Project', { exact: true }).click();
    await page.getByRole('option', { name: new RegExp(`^${name}`) }).click();
    await dialog.getByLabel('Prompt', { exact: true }).fill('A short launch note');
    await dialog.getByRole('button', { name: 'Generate draft' }).click();
    await expect(
      dialog.getByText(new RegExp(`^Used project: ${name} · 1 reference`)),
    ).toBeVisible();
    await axe(page, '[role="dialog"]');
  } finally {
    await api(request, 'DELETE', `${MGMT}/ai-projects/${id}`);
  }
});
