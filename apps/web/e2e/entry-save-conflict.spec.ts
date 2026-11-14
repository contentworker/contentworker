import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { api, EDITOR_READY, MGMT, openCms, SPACE, seedCms, useCmsScope } from './cms';
import { settle } from './settle';

/**
 * The entry form's save is held to the version it was filled from: someone saving the entry
 * behind it meets the person with Keep editing, Load theirs or Save mine over it, never a silent
 * overwrite. The same dialog the canvas asks.
 */
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.beforeAll(async ({ request }) => {
  await seedCms(request);
});

test.beforeEach(async ({ page }) => {
  await useCmsScope(page);
});

/** An article opened in the form, then saved behind it by someone else (v2). */
async function openedThenSavedBehind(page: Page, request: Parameters<typeof api>[0], n: number) {
  const res = await api(request, 'POST', `${MGMT}/entries`, {
    contentTypeApiId: 'article',
    fields: { title: { 'en-US': `Opened ${n}` } },
  });
  expect(res.ok(), await res.text()).toBe(true);
  const id = ((await res.json()) as { entry: { id: string } }).entry.id;
  await openCms(page, `/content/article/${id}`);
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible(EDITOR_READY);
  const behind = await api(request, 'PUT', `${MGMT}/entries/${id}`, {
    fields: { title: { 'en-US': `Theirs ${n}` } },
  });
  expect(behind.ok(), await behind.text()).toBe(true);
  await page.getByRole('textbox', { name: /^Title/ }).fill(`Mine ${n}`);
  return id;
}

async function titleOf(request: Parameters<typeof api>[0], id: string) {
  const res = await api(request, 'GET', `/preview/${SPACE}/main/entries?sys.id=${id}&limit=1`);
  const { items } = (await res.json()) as {
    items: { fields: { title?: Record<string, string> } }[];
  };
  return items[0]?.fields.title?.['en-US'];
}

test('a save someone beat asks, keeps editing, and saves over theirs when told to', async ({
  page,
  request,
}, testInfo) => {
  const id = await openedThenSavedBehind(page, request, testInfo.workerIndex);
  const save = page.getByRole('button', { name: 'Save draft' });
  await save.click();
  const dialog = page.getByRole('alertdialog', {
    name: 'Someone saved this entry while you worked',
  });
  await expect(dialog).toContainText('It’s at v2 now, and the form started from v1');
  // The safe answer is the one under the hand.
  await expect(dialog.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await settle(page);
  const results = await new AxeBuilder({ page })
    .withTags(WCAG)
    .include('[role="alertdialog"]')
    .analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);

  // Keep editing: nothing saved, the edit still there, focus back on Save draft.
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(save).toBeFocused();
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  expect(await titleOf(request, id)).toBe(`Theirs ${testInfo.workerIndex}`);

  await save.click();
  await dialog.getByRole('button', { name: 'Save mine over it' }).click();
  await expect(page.getByText('Draft updated')).toBeVisible();
  expect(await titleOf(request, id)).toBe(`Mine ${testInfo.workerIndex}`);
});

test('Load theirs fills the form with their version', async ({ page, request }, testInfo) => {
  const id = await openedThenSavedBehind(page, request, testInfo.workerIndex + 100);
  await page.getByRole('button', { name: 'Save draft' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'Load theirs' }).click();
  await expect(page.getByRole('textbox', { name: /^Title/ })).toHaveValue(
    `Theirs ${testInfo.workerIndex + 100}`,
  );
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);
  expect(await titleOf(request, id)).toBe(`Theirs ${testInfo.workerIndex + 100}`);
});
