import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test';
import {
  createDraft,
  openCms,
  seedAsset,
  seedAssetFolder,
  seedCms,
  useCmsScope,
  withoutAssistant,
} from './cms';
import { settle } from './settle';

/*
 * Closing a modal hands focus back to what opened it, however it was opened. WebKit is why this
 * runs in a real browser: a pressed button doesn't take focus there, so `document.activeElement`
 * alone can't say what asked. Runs in Chromium (`cms`) and WebKit (`desktop`).
 */

test.beforeAll(async ({ request }) => {
  await seedCms(request);
});

test.beforeEach(async ({ page }) => {
  await useCmsScope(page);
  await withoutAssistant(page);
});

type Way = 'pointer' | 'keyboard';

async function press(page: Page, control: Locator, way: Way) {
  if (way === 'pointer') return control.click();
  await control.focus();
  await page.keyboard.press('Enter');
}

/** Opens `surface` from `opener` and closes it the same way; focus must be back on `opener`. */
async function roundTrip(page: Page, way: Way, opener: Locator, surface: Locator, out: Locator) {
  await press(page, opener, way);
  await expect(surface).toBeVisible();
  // Radix hands Escape from layer to layer a render after one opens: pressed in that frame, faster
  // than a hand, it would reach the layer underneath as well.
  await settle(page);
  if (way === 'pointer') await out.click();
  else await page.keyboard.press('Escape');
  await expect(surface).toBeHidden();
  await expect(opener).toBeFocused();
}

/** A new asset's card, in a folder of its own: other specs' assets can't push it off the page. */
async function assetCard(page: Page, request: APIRequestContext, way: Way) {
  const title = `Focus ${way} ${Date.now()}`;
  const folderId = await seedAssetFolder(request, title);
  await seedAsset(request, title, { folderId });
  await openCms(page, '/assets');
  await page
    .getByRole('navigation', { name: 'Folders' })
    .getByRole('button', { name: title, exact: true })
    .click();
  return page
    .getByRole('region', { name: 'Asset library' })
    .getByRole('button', { name: `Open “${title}”` });
}

for (const way of ['pointer', 'keyboard'] as const) {
  test.describe(`by ${way}`, () => {
    test('New release goes back to its button', async ({ page }) => {
      await openCms(page, '/releases');
      const dialog = page.getByRole('dialog', { name: 'New release' });
      await roundTrip(
        page,
        way,
        page.getByRole('button', { name: 'New release' }),
        dialog,
        dialog.getByRole('button', { name: 'Close' }),
      );
    });

    test('the palette goes back to Search', async ({ page }) => {
      await openCms(page, '/content');
      const search = page.getByRole('button', { name: 'Search' }).first();
      await press(page, search, way);
      const palette = page.getByRole('dialog');
      await expect(palette).toBeVisible();
      if (way === 'pointer') await page.mouse.click(8, 500);
      else await page.keyboard.press('Escape');
      await expect(palette).toBeHidden();
      await expect(search).toBeFocused();
    });

    test('the asset sheet goes back to its card, and Share over it to Share', async ({
      page,
      request,
    }) => {
      const card = await assetCard(page, request, way);
      await press(page, card, way);
      const sheet = page.getByRole('dialog').first();
      const share = sheet.getByRole('button', { name: 'Share' });
      await expect(share).toBeVisible();

      const dialog = page.getByRole('dialog', { name: /^Share/ });
      await roundTrip(page, way, share, dialog, dialog.getByRole('button', { name: 'Close' }));
      await expect(sheet).toBeVisible();

      if (way === 'pointer') await sheet.getByRole('button', { name: 'Close' }).last().click();
      else await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
      await expect(card).toBeFocused();
    });

    test('an alert over a dialog goes back into the dialog', async ({ page, request }) => {
      const title = `Focus revoke ${way} ${Date.now()}`;
      const folderId = await seedAssetFolder(request, title);
      await seedAsset(request, title, { folderId, publish: true });
      await openCms(page, '/assets');
      await page
        .getByRole('navigation', { name: 'Folders' })
        .getByRole('button', { name: title, exact: true })
        .click();
      await page.getByRole('button', { name: `Open “${title}”` }).click();
      await page.getByRole('dialog').first().getByRole('button', { name: 'Share' }).click();
      const share = page.getByRole('dialog', { name: /^Share/ });
      await share.getByRole('button', { name: 'Create link' }).click();
      const alert = page.getByRole('alertdialog', { name: /Revoke this link/ });
      await roundTrip(
        page,
        way,
        share.getByRole('button', { name: /Revoke the link/ }),
        alert,
        alert.getByRole('button', { name: 'Cancel' }),
      );
      await expect(share).toBeVisible();
    });

    test('Generate, from the ⋯ menu, goes back to ⋯', async ({ page, request }) => {
      const id = await createDraft(request, `Focus generate ${Date.now()}`);
      await openCms(page, `/content/article/${id}`);
      const more = page.getByRole('button', { name: 'More entry actions' });
      await press(page, more, way);
      await press(page, page.getByRole('menuitem', { name: 'Generate with AI' }), way);
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      if (way === 'pointer') await dialog.getByRole('button', { name: 'Close' }).click();
      else await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(more).toBeFocused();
    });

    test("the editor's PublishConfirm goes back to Publish", async ({ page, request }) => {
      const id = await createDraft(request, `Focus publish ${Date.now()}`);
      await openCms(page, `/content/article/${id}`);
      const dialog = page.getByRole('alertdialog');
      await roundTrip(
        page,
        way,
        page.getByRole('button', { name: 'Publish', exact: true }),
        dialog,
        dialog.getByRole('button', { name: 'Keep as draft' }),
      );
    });

    test('once published, focus stays on the action bar, not the page', async ({
      page,
      request,
    }) => {
      const id = await createDraft(request, `Focus published ${Date.now()}`);
      await openCms(page, `/content/article/${id}`);
      await press(page, page.getByRole('button', { name: 'Publish', exact: true }), way);
      const dialog = page.getByRole('alertdialog');
      await press(page, dialog.getByRole('button', { name: 'Publish entry' }), way);
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('button', { name: 'Published', exact: true })).toBeDisabled();
      await expect(page.locator('[data-page-bar] button:focus')).toHaveCount(1);
    });
  });
}
