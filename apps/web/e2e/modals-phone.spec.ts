import { expect, type Locator, type Page, test } from '@playwright/test';
import { createDraft, EDITOR_READY, openCms, seedCms, useCmsScope, withoutAssistant } from './cms';
import { settle } from './settle';

/*
 * Dialogs on a phone: from the bottom, every way out and every action in reach, at the height an
 * on-screen keyboard leaves. Layout is what jsdom can't judge, so it is measured here in WebKit.
 */

test.beforeAll(async ({ request }) => {
  await seedCms(request);
});

test.beforeEach(async ({ page }) => {
  await useCmsScope(page);
});

/** Wholly inside the viewport, and the top thing at its centre: a finger reaches it. */
async function expectReachable(page: Page, control: Locator) {
  const box = await control.boundingBox();
  const size = page.viewportSize();
  expect(box).not.toBeNull();
  if (!box || !size) return;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(size.height);
  const hit = await control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  });
  expect(hit).toBe(true);
}

/** The target a finger gets: the control, or its `hit-area` box where that is bigger. */
const targetHeight = (control: Locator) =>
  control.evaluate((el) => {
    const after = getComputedStyle(el, '::after');
    const inset = Number.parseFloat(after.inset) || 0;
    return el.getBoundingClientRect().height - 2 * inset;
  });

async function openGenerate(page: Page, request: Parameters<typeof createDraft>[0]) {
  const id = await createDraft(request, `Phone modal ${Date.now()}`);
  await openCms(page, `/content/article/${id}`);
  await page.getByRole('button', { name: 'More entry actions' }).click(EDITOR_READY);
  await page.getByRole('menuitem', { name: 'Generate with AI' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

test('a form dialog comes from the bottom of a phone, its targets a finger wide', async ({
  page,
  request,
}) => {
  await withoutAssistant(page);
  const dialog = await openGenerate(page, request);
  await expect
    .poll(async () => {
      const box = await dialog.boundingBox();
      return box ? Math.round(box.y + box.height) : 0;
    })
    .toBe(page.viewportSize()?.height);

  const close = dialog.getByRole('button', { name: 'Close' });
  expect(await targetHeight(close)).toBeGreaterThanOrEqual(44);
  expect(await targetHeight(dialog.getByRole('button', { name: 'Cancel' }))).toBeGreaterThanOrEqual(
    44,
  );
});

test('at keyboard height the way out and the action stay in reach', async ({ page, request }) => {
  await withoutAssistant(page);
  const dialog = await openGenerate(page, request);
  await page.setViewportSize({ width: 390, height: 370 });
  await dialog.getByRole('textbox', { name: 'Prompt' }).fill('A launch post');

  await expectReachable(page, dialog.getByRole('button', { name: 'Close' }));
  await expect(dialog.getByRole('button', { name: 'Generate draft' })).toBeEnabled();
  await expectReachable(page, dialog.getByRole('button', { name: 'Generate draft' }));
  await expectReachable(page, dialog.getByRole('button', { name: 'Cancel' }));
});

test('the palette keeps its search box still as the results shrink', async ({ page }) => {
  await openCms(page, '/content');
  await page.getByRole('button', { name: 'Search' }).first().click();
  const input = page.getByRole('combobox', { name: 'Command palette search' });
  await expect(input).toBeVisible();
  await expect(page.getByRole('option').first()).toBeVisible();
  await settle(page);
  const before = await input.boundingBox();
  await input.fill('nothing is called this');
  await expect(page.getByRole('option')).toHaveCount(0);
  const after = await input.boundingBox();
  expect(after?.y).toBe(before?.y);
});
