import { expect, type Page, test } from '@playwright/test';
import {
  api,
  createChanged,
  createDraft,
  EDITOR_READY,
  MGMT,
  openCms,
  SPACE,
  seedAsset,
  seedAssetFolder,
  seedCms,
  seedIngestFindings,
  statusOf,
  uploadAssetBytes,
  useCmsScope,
  withoutAssistant,
} from './cms';

/*
 * The CMS screens end to end against the local stack (web + api + engine on one local D1):
 * author and publish, rich text, the unsaved-changes guards, bulk actions, trash and duplicate,
 * and the settings sections. Ported from the Vite admin's admin.spec.ts. A page's actions go through
 * the assistant (its agent runs in the engine here): they stop at a confirm card in its panel.
 */

test.beforeAll(async ({ request }) => {
  await seedCms(request);
});

test.beforeEach(async ({ page }) => {
  await useCmsScope(page);
});

/** The seeded content type's entries list, from the Content section's own sub-nav. */
/**
 * Confirms a page's action at its card in the assistant's panel; the page waits on the answer. The
 * newest card: the conversation is the one person's, kept across tests.
 */
async function confirmCard(page: Page, title: string) {
  const card = page
    .getByRole('complementary', { name: 'Coworker' })
    .getByRole('region', { name: title })
    .last();
  await card.getByRole('button', { name: 'Confirm' }).click();
}

/**
 * The Article list, from the Content overview's card: the content-type list beside the page gives
 * way while the assistant's column is open.
 */
async function toArticles(page: Page) {
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Content', exact: true })
    .first()
    .click();
  // The seeded space has one content type: Article.
  await page
    .getByRole('main')
    .getByRole('table')
    .getByRole('link', { name: 'Article', exact: true })
    .click();
  await expect(page).toHaveURL(/\/content\/article$/);
  // From md the header says where you are (once a space is in scope).
  await expect(
    page.getByRole('banner').getByRole('navigation', { name: 'breadcrumb' }).getByText('Article'),
  ).toBeVisible();
}

/** A new article's editor. */
async function newArticle(page: Page) {
  await openCms(page, '/content/article/new');
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible(EDITOR_READY);
}

test('the entries list offers New entry for its content type', async ({ page }) => {
  await openCms(page, '/content/article');
  const link = page.getByRole('link', { name: 'New entry', exact: true }).first();
  await expect(link).toHaveAttribute('href', '/content/article/new');
});

test('authors and publishes an entry end-to-end', async ({ page }) => {
  await openCms(page, '/content');
  await toArticles(page);
  await newArticle(page);
  const title = `E2E ${Date.now()}`;
  await page.getByRole('textbox', { name: /Title/ }).fill(title);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Entry created')).toBeVisible();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();

  // Publish from the editor header: confirmed at the assistant's card.
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await confirmCard(page, 'Publish this entry');
  await expect(page.getByText(/Published v\d+/)).toBeVisible();

  // Back on the list, the entry shows as published (in words, not only colour).
  await toArticles(page);
  const row = page.getByRole('row', { name: new RegExp(title) });
  await expect(row).toBeVisible();
  await expect(row.getByText(/published/i)).toBeVisible();
});

test('authors rich text with marks and persists it across a reload', async ({ page }) => {
  await newArticle(page);
  const title = `Rich ${Date.now()}`;
  await page.getByRole('textbox', { name: /Title/ }).fill(title);

  // Select the word only once ProseMirror has accepted the selection (it re-asserts the caret
  // after digesting typed input, which can wipe a selection made in the gap).
  const editor = page.locator('.rich-text-editor');
  const selectLeft = async (word: string) => {
    const read = () => page.evaluate(() => window.getSelection()?.toString() ?? '');
    for (let i = 0; i < word.length; i++) await page.keyboard.press('Shift+ArrowLeft');
    const deadline = Date.now() + 8000;
    let stable = 0;
    while (Date.now() < deadline) {
      const sel = await read();
      if (sel === word) {
        stable += 1;
        if (stable >= 2) return;
        await page.waitForTimeout(75);
        continue;
      }
      stable = 0;
      if (sel.length < word.length && word.endsWith(sel)) {
        await page.keyboard.press('Shift+ArrowLeft');
      } else {
        await page.waitForTimeout(50);
      }
    }
    expect(await read()).toBe(word);
  };
  await editor.click();
  await page.keyboard.type('Plain then bolded');
  await selectLeft('bolded');
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(editor.locator('strong')).toHaveText('bolded');

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Entry created')).toBeVisible();

  // Reopen the entry from the list: the stored document round-trips back.
  await toArticles(page);
  const row = page.getByRole('row', { name: new RegExp(title) });
  await row.getByRole('link', { name: title, exact: true }).click();
  const reopened = page.locator('.rich-text-editor');
  await expect(reopened).toContainText('Plain then bolded');
  await expect(reopened.locator('strong')).toHaveText('bolded');
});

test('publishing with unsaved edits saves first, then confirms', async ({ page }) => {
  await newArticle(page);
  const title = `Chain ${Date.now()}`;
  await page.getByRole('textbox', { name: /Title/ }).fill(title);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Entry created')).toBeVisible();
  await page.getByRole('textbox', { name: /Title/ }).fill(`${title} v2`);
  await expect(page.getByText('Unsaved changes')).toBeVisible();

  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Draft updated')).toBeVisible();
  await confirmCard(page, 'Publish this entry');
  await expect(page.getByText(/Published v\d+/)).toBeVisible();

  // Publish with an INVALID form: feedback at the button, no confirm.
  await page.getByRole('textbox', { name: /Title/ }).fill('');
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Fix 1 field error to publish')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish entry' })).not.toBeVisible();
});

test('navigating away from unsaved edits asks before discarding', async ({ page }, info) => {
  test.skip(info.project.name.startsWith('iphone'), 'the editor is review-only on a phone');
  await newArticle(page);
  await page.getByRole('textbox', { name: /Title/ }).fill(`Guard ${Date.now()}`);

  const overview = page.getByRole('navigation', { name: 'Main' }).getByRole('link', {
    name: 'Overview',
  });
  await overview.first().click();
  await expect(page.getByText('Discard unsaved changes?')).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.getByRole('textbox', { name: /Title/ })).toBeVisible();

  await overview.first().click();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
});

test('bulk unpublish confirms once and surfaces per-entry failures by title', async ({
  page,
  request,
}) => {
  // Two fresh drafts (unpublishing a draft fails server-side: the failure path).
  const stamp = Date.now();
  for (const n of [1, 2]) {
    const res = await api(request, 'POST', `${MGMT}/entries`, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': `Bulk ${stamp} ${n}` } },
    });
    expect(res.ok(), await res.text()).toBe(true);
  }
  await openCms(page, '/content/article');
  for (const n of [1, 2]) {
    await page
      .getByRole('row', { name: new RegExp(`Bulk ${stamp} ${n}`) })
      .getByRole('checkbox')
      .check();
  }
  await page.getByRole('button', { name: 'Unpublish selected' }).click();
  await confirmCard(page, 'Change these entries');

  const failures = page.getByRole('alert').filter({ hasText: 'entries failed' });
  await expect(failures).toBeVisible();
  await expect(failures.getByText(`Bulk ${stamp} 1`)).toBeVisible();
  await expect(failures.getByText(`Bulk ${stamp} 2`)).toBeVisible();
  await failures.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByText('2 entries failed')).not.toBeVisible();
});

test('trashes an entry, restores it, then deletes it permanently', async ({ page, request }) => {
  const title = `Trash ${Date.now()}`;
  await api(request, 'POST', `${MGMT}/entries`, {
    contentTypeApiId: 'article',
    fields: { title: { 'en-US': title } },
  });
  await openCms(page, '/content/article');

  const row = page.getByRole('row', { name: new RegExp(title) });
  await row.getByRole('button', { name: /^More actions for / }).click();
  await page.getByRole('menuitem', { name: 'Move to trash' }).click();
  await confirmCard(page, 'Move this entry to the trash');
  await expect(page.getByRole('row', { name: new RegExp(title) })).toBeHidden();

  await page.getByRole('button', { name: 'View trash' }).click();
  const trashed = page.getByRole('row', { name: new RegExp(title) });
  await expect(trashed).toBeVisible();
  await trashed.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByRole('row', { name: new RegExp(title) })).toBeHidden();
  await page.getByRole('button', { name: 'Back to entries' }).click();
  await expect(page.getByRole('row', { name: new RegExp(title) })).toBeVisible();

  await page
    .getByRole('row', { name: new RegExp(title) })
    .getByRole('button', { name: /^More actions for / })
    .click();
  await page.getByRole('menuitem', { name: 'Move to trash' }).click();
  await confirmCard(page, 'Move this entry to the trash');
  await expect(page.getByRole('row', { name: new RegExp(title) })).toBeHidden();
  await page.getByRole('button', { name: 'View trash' }).click();
  await page
    .getByRole('row', { name: new RegExp(title) })
    .getByRole('button', { name: /^More actions for / })
    .click();
  await page.getByRole('menuitem', { name: 'Delete permanently…' }).click();
  await confirmCard(page, 'Delete this entry for good');
  await expect(page.getByRole('row', { name: new RegExp(title) })).toBeHidden();
});

test('duplicates an entry into a new draft marked as a copy', async ({ page, request }) => {
  const title = `Dup ${Date.now()}`;
  await api(request, 'POST', `${MGMT}/entries`, {
    contentTypeApiId: 'article',
    fields: { title: { 'en-US': title } },
  });
  await openCms(page, '/content/article');
  await page
    .getByRole('row', { name: new RegExp(title) })
    .getByRole('button', { name: /^More actions for / })
    .click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(page.getByRole('heading', { name: `${title} (copy)` })).toBeVisible();
  await toArticles(page);
  const list = page.getByRole('table');
  await expect(list.getByRole('link', { name: `${title} (copy)`, exact: true })).toBeVisible();
  await expect(list.getByRole('link', { name: title, exact: true })).toBeVisible();
});

test('settings lists the space’s API keys, and the space access section', async ({
  page,
  request,
}) => {
  const name = `e2e-key-${Date.now()}`;
  const minted = await api(request, 'POST', `/spaces/${SPACE}/api-keys`, { kind: 'cda', name });
  expect(minted.ok(), await minted.text()).toBe(true);
  await openCms(page, '/settings/team');
  await expect(page.getByRole('heading', { name: 'People in this space' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'API keys' })
    .click();
  await expect(page.getByRole('heading', { name: 'API keys' })).toBeVisible();
  await expect(page.getByText(name)).toBeVisible();
});

test('an unknown settings section lands on the first one', async ({ page }) => {
  await openCms(page, '/settings/connection');
  await expect(page).toHaveURL(/\/settings\/team$/);
});

test('API calls go to the same origin and carry the read-your-writes bookmark', async ({
  page,
}) => {
  const seen: { url: string; bookmark: string | null; auth: string | null }[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (!url.pathname.startsWith('/spaces')) return;
    seen.push({
      url: url.origin,
      bookmark: req.headers()['x-cw-bookmark'] ?? null,
      auth: req.headers().authorization ?? null,
    });
  });
  await openCms(page, '/content/article');
  await expect(page.getByRole('table')).toBeVisible();
  const origin = new URL(page.url()).origin;
  expect(seen.length).toBeGreaterThan(1);
  for (const s of seen) {
    expect(s.url).toBe(origin);
    // No bearer token: the gateway signs the session into the forwarded request.
    expect(s.auth).toBeNull();
  }
  // Once the api has answered with a bookmark, later requests send it back.
  expect(seen.slice(1).some((s) => s.bookmark)).toBe(true);
});

test('the editor’s side pane sits beside the form, resizes, and previews the draft as typed', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await newArticle(page);
  // A new entry's pane is its preview alone.
  const preview = page.getByRole('article', { name: 'Preview' });
  await expect(preview.getByRole('heading', { name: 'Untitled' })).toBeVisible();
  const title = `Pane ${Date.now()}`;
  await page.getByRole('textbox', { name: /Title/ }).fill(title);
  await expect(preview.getByRole('heading', { name: title })).toBeVisible();

  // Beside the form behind a splitter, which the keyboard moves.
  const divider = page.getByRole('separator', { name: 'Resize the side pane' });
  const before = Number(await divider.getAttribute('aria-valuenow'));
  await divider.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(divider).toHaveAttribute('aria-valuenow', String(before + 2));
  await page.keyboard.press('Enter');
  await expect(divider).toHaveAttribute('aria-valuenow', String(before));

  // Saved, the pane switches between the entry's panels and the preview.
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Entry created')).toBeVisible();
  const pane = page.getByRole('complementary', { name: 'Side pane' });
  await pane.getByRole('radio', { name: 'Preview' }).click();
  await expect(preview.getByRole('heading', { name: title })).toBeVisible();
  await pane.getByRole('radio', { name: 'Details' }).click();
  await expect(preview).toHaveCount(0);
});

test('typing right after creating an entry lands in the created entry, never a form being replaced', async ({
  page,
}) => {
  await newArticle(page);
  // Hold the swap from /new to the created entry's URL open, as a slow runner does: the new route's
  // module arrives late.
  await page.route('**/*content-entry*', async (route) => {
    await new Promise((r) => setTimeout(r, 2000));
    await route.continue();
  });
  const title = `Swap ${Date.now()}`;
  const box = page.getByRole('textbox', { name: /Title/ });
  await box.fill(title);
  await page.getByRole('button', { name: 'Save draft' }).click();
  // The new form is gone while it is replaced, so this waits for the created entry's editor.
  await box.fill(`${title} v2`, { timeout: 15_000 });
  await expect(page).toHaveURL(/\/content\/article\/(?!new)[^/]+$/);
  await expect(box).toHaveValue(`${title} v2`);
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft updated')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: `${title} v2` })).toBeVisible();
});

test('the asset library searches: a match by name, facet chips, and back to the library on clear', async ({
  page,
  request,
}) => {
  // Waits on ingest, which a cold engine takes a while to start.
  test.setTimeout(120_000);
  const stamp = Date.now();
  // Shares no word with the search below (its stamp in base 36), so neither leg can match it.
  const other = `Ordinary ${stamp.toString(36)}`;
  await seedAsset(request, other);

  await openCms(page, '/assets');
  const library = page.getByRole('region', { name: 'Asset library' });
  await expect(library.getByRole('button', { name: `Open “${other}”` })).toBeVisible();

  // Uploaded through the signed PUT, which hands the file to ingest; ingest indexes it.
  const wanted = `heliotrope-${stamp}.txt`;
  await page
    .getByLabel('Upload asset files')
    .setInputFiles([
      { name: wanted, mimeType: 'text/plain', buffer: Buffer.from('a heliotrope field guide') },
    ]);
  const uploads = page.getByRole('region', { name: 'Uploads' });
  await expect(uploads.getByRole('status')).toHaveText('Uploaded 1 file', { timeout: 30_000 });

  const box = library.getByRole('searchbox', { name: 'Search assets' });
  const query = `heliotrope ${stamp}`;
  // Ingest runs on the engine after the upload: search again until the index has caught up. The
  // summary names the query, so the library shown before the debounced search can't pass.
  await expect(async () => {
    await box.fill('');
    await box.fill(query);
    await expect(library.getByText(new RegExp(`match(es)? for “${query}”`))).toBeVisible({
      timeout: 3_000,
    });
    await expect(library.getByRole('button', { name: `Open “${wanted}”` })).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 90_000 });
  await expect(library.getByRole('button', { name: `Open “${other}”` })).toHaveCount(0);
  const kinds = library.getByRole('group', { name: 'Kind' });
  await expect(kinds.getByRole('button', { name: /^Documents \d+ match/ })).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  await library.getByRole('button', { name: 'Clear search' }).click();
  await expect(library.getByRole('button', { name: `Open “${other}”` })).toBeVisible();
  await expect(library.getByRole('group', { name: 'Kind' })).toHaveCount(0);
});

test('the asset library: a folder, uploads into it, a move, a bulk archive, a restore and a guarded delete', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const seeded = [`Seed ${stamp} 1`, `Seed ${stamp} 2`];
  for (const title of seeded) await seedAsset(request, title);

  await openCms(page, '/assets');
  const library = page.getByRole('region', { name: 'Asset library' });
  await expect(library.getByRole('button', { name: `Open “${seeded[0]}”` })).toBeVisible();

  // A folder, created in the tree: it opens, and takes focus.
  const folderName = `Folder ${stamp}`;
  const folders = page.getByRole('navigation', { name: 'Folders' });
  await folders.getByRole('button', { name: 'New folder' }).click();
  await folders.getByRole('textbox', { name: 'New folder name' }).fill(folderName);
  await folders.getByRole('button', { name: 'Create folder' }).click();
  await expect(folders.getByRole('button', { name: folderName, exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: `Upload to “${folderName}”` })).toBeVisible();

  // Several files uploaded into it; the queue says how the batch went.
  const files = [1, 2, 3].map((n) => ({
    name: `upload-${stamp}-${n}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from(`file ${n}`),
  }));
  await page.getByLabel('Upload asset files').setInputFiles(files);
  const uploads = page.getByRole('region', { name: 'Uploads' });
  await expect(uploads.getByRole('status')).toHaveText('Uploaded 3 files', { timeout: 30_000 });
  for (const f of files) {
    await expect(library.getByRole('button', { name: `Open “${f.name}”` })).toBeVisible();
  }

  // The seeded assets, selected from everything and moved into the folder.
  await folders.getByRole('button', { name: 'All assets' }).click();
  for (const title of seeded) {
    await library.getByRole('checkbox', { name: `Select “${title}”` }).check();
  }
  const bar = page.getByRole('group', { name: 'Selected assets' });
  await expect(bar.getByText('2 selected')).toBeVisible();
  await bar.getByRole('combobox', { name: 'Move to folder' }).selectOption({ label: folderName });
  await bar.getByRole('button', { name: 'Move selected' }).click();
  await expect(page.getByText(`Moved 2 assets to “${folderName}”`)).toBeVisible();

  // In the folder: all five, archived together after an in-place confirm.
  await folders.getByRole('button', { name: folderName, exact: true }).click();
  await library.getByRole('radio', { name: 'List' }).click();
  await expect(library.getByRole('row')).toHaveCount(6); // the header and five assets
  await library.getByRole('checkbox', { name: 'Select all shown' }).check();
  await expect(bar.getByText('5 selected')).toBeVisible();
  await bar.getByRole('button', { name: 'Archive selected' }).click();
  await bar
    .getByRole('alertdialog', { name: /Archive 5 assets\?/ })
    .getByRole('button', { name: 'Archive 5 assets' })
    .click();
  await expect(page.getByText('Archived 5 assets')).toBeVisible();
  await expect(library.getByText('Nothing here')).toBeVisible();

  // One restored, from the archived filter: it comes back as a draft.
  await library.getByRole('combobox', { name: 'Status' }).selectOption('archived');
  await library.getByRole('button', { name: `Restore “${seeded[0]}”` }).click();
  await expect(page.getByText(`Restored “${seeded[0]}” as a draft`)).toBeVisible();
  await library.getByRole('combobox', { name: 'Status' }).selectOption('draft');
  await expect(library.getByRole('button', { name: `Open “${seeded[0]}”` })).toBeVisible();
});

test('deleting an asset an entry uses names that entry and links to it', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const assetTitle = `Hero ${stamp}`;
  const assetId = await seedAsset(request, assetTitle, { publish: true });
  const entryTitle = `Uses hero ${stamp}`;
  const created = await api(request, 'POST', `${MGMT}/entries`, {
    contentTypeApiId: 'article',
    fields: {
      title: { 'en-US': entryTitle },
      content: {
        'en-US': {
          nodeType: 'document',
          data: {},
          content: [
            {
              nodeType: 'embedded-asset-block',
              data: { target: { id: assetId, linkType: 'Asset' } },
              content: [],
            },
          ],
        },
      },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { entry } = (await created.json()) as { entry: { id: string } };
  const published = await api(request, 'POST', `${MGMT}/entries/${entry.id}/published`);
  expect(published.ok(), await published.text()).toBe(true);

  await openCms(page, '/assets');
  const library = page.getByRole('region', { name: 'Asset library' });
  await library.getByRole('button', { name: `Delete “${assetTitle}”` }).click();
  await library
    .getByRole('alertdialog', { name: new RegExp(`Delete “${assetTitle}”`) })
    .getByRole('button', { name: 'Delete' })
    .click();

  const notice = library
    .getByRole('alert')
    .filter({ hasText: `“${assetTitle}” is used by 1 entry` });
  await expect(notice).toBeVisible();
  await expect(notice).toBeFocused();
  const link = notice.getByRole('link', { name: entryTitle });
  await expect(link).toHaveAttribute('href', `/content/article/${entry.id}`);
  // Still there: the delete was refused.
  await expect(library.getByRole('button', { name: `Open “${assetTitle}”` })).toBeVisible();
});

test.describe('publishing from a row, without the assistant', () => {
  test.beforeEach(async ({ page }) => {
    await withoutAssistant(page);
  });

  test('a changed entry confirms what goes live; Keep as draft publishes nothing, Publish entry publishes', async ({
    page,
    request,
  }) => {
    const title = `Revised ${Date.now()}`;
    const id = await createChanged(request, title);
    await openCms(page, '/content/article');
    const row = page.getByRole('row', { name: new RegExp(title) });
    await expect(row.getByText('Changed', { exact: true })).toBeVisible();

    await row.getByRole('button', { name: `Publish “${title}”` }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByRole('heading', { name: `Publish “${title}”?` })).toBeVisible();
    // Only the body differs from what's live: it is listed as changed, the title is not.
    await expect(dialog.getByText('1 field changed')).toBeVisible();
    const changed = dialog.getByRole('row', { name: /^body Changed/ });
    await expect(changed.getByText('Live body')).toBeVisible();
    await expect(changed.getByText('Edited body')).toBeVisible();
    await expect(dialog.getByRole('row', { name: /^title/ }).getByText('Changed')).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Keep as draft' }).click();
    await expect(dialog).toBeHidden();
    expect(await statusOf(request, id)).toBe('changed');
    await expect(row.getByRole('button', { name: `Publish “${title}”` })).toBeVisible();

    await row.getByRole('button', { name: `Publish “${title}”` }).click();
    await dialog.getByRole('button', { name: 'Publish entry' }).click();
    await expect(page.getByText(`“${title}” published`)).toBeVisible();
    await expect(row.getByRole('button', { name: `Publish “${title}”` })).toHaveCount(0);
    expect(await statusOf(request, id)).toBe('published');
  });

  test('a draft publishes at once with an Undo that returns it to draft', async ({
    page,
    request,
  }) => {
    const title = `Fresh ${Date.now()}`;
    const id = await createDraft(request, title);
    await openCms(page, '/content/article');
    const row = page.getByRole('row', { name: new RegExp(title) });
    await row.getByRole('button', { name: `Publish “${title}”` }).click();

    // No confirmation for a first publish: it is live, and the toast offers the way back.
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    const toast = page.getByText(`“${title}” published`);
    await expect(toast).toBeVisible();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByText(`“${title}” is back to draft`)).toBeVisible();
    expect(await statusOf(request, id)).toBe('draft');
    await expect(row.getByText('Draft', { exact: true })).toBeVisible();
  });
});

test('the asset library shows what ingest found: a duplicate opens its original, and a failed ingest retries', async ({
  page,
  request,
}) => {
  // Waits for ingest to find the twin and to give up on the missing file (after its retries).
  test.setTimeout(240_000);
  const stamp = Date.now();
  const { original, copy, broken } = await seedIngestFindings(request, stamp);

  await openCms(page, '/assets');
  const library = page.getByRole('region', { name: 'Asset library' });
  const duplicateBadge = `Possible duplicate: open the asset “${copy}” duplicates`;

  // From the grid: the badge opens the original's sheet.
  await library.getByRole('button', { name: duplicateBadge }).click();
  let sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('heading', { name: original })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  // From the copy's sheet with an edit in it: asked in place first, then the original.
  await library.getByRole('button', { name: `Open “${copy}”` }).click();
  sheet = page.getByRole('dialog');
  await sheet.getByLabel('Alt text (en-US)').fill('Not saved yet');
  await sheet.getByRole('button', { name: duplicateBadge }).click();
  const ask = sheet.getByRole('alertdialog', {
    name: 'Open the original and discard your changes?',
  });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Keep editing' }).click();
  await expect(sheet.getByLabel('Alt text (en-US)')).toHaveValue('Not saved yet');
  await sheet.getByRole('button', { name: duplicateBadge }).click();
  await sheet.getByRole('button', { name: 'Discard and open' }).click();
  await expect(sheet.getByRole('heading', { name: original })).toBeVisible();
  await page.keyboard.press('Escape');

  // The failure's reason is on the card, in sight; Retry sends the asset through ingest again.
  await expect(library.getByText('The file is not in storage').first()).toBeVisible();
  await library.getByRole('button', { name: `Retry processing “${broken}”` }).click();
  await expect(page.getByText(`Processing “${broken}” again`)).toBeVisible();
  await expect(library.getByRole('button', { name: `Retry processing “${broken}”` })).toHaveCount(
    0,
  );
});

test('an asset’s file is replaced, republished and restored from its Versions tab', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const name = `versions-${stamp}.txt`;
  const id = await uploadAssetBytes(request, name, Buffer.from(`first ${stamp}`));
  const pub = await api(request, 'POST', `${MGMT}/assets/${id}/published`);
  expect(pub.ok(), await pub.text()).toBe(true);

  await openCms(page, '/assets');
  const library = page.getByRole('region', { name: 'Asset library' });
  await library.getByRole('button', { name: `Open “${name}”` }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('tab', { name: 'Versions' }).click();
  const versions = sheet.getByRole('list', { name: 'File versions' });
  await expect(versions.getByRole('listitem')).toHaveCount(1);

  // Replace: the signed PUT, then the commit; the new file is v2 and current.
  const next = `versions-${stamp}-new.txt`;
  await sheet.getByLabel('Replacement file').setInputFiles({
    name: next,
    mimeType: 'text/plain',
    buffer: Buffer.from(`second ${stamp}`),
  });
  await expect(page.getByText(`Replaced the file with “${next}” (version 2)`)).toBeVisible();
  await expect(versions.getByRole('listitem')).toHaveCount(2);
  const top = versions.getByRole('listitem').first();
  await expect(top.getByText('v2', { exact: true })).toBeVisible();
  await expect(top.getByText(next)).toBeVisible();
  await expect(top.getByText('Current')).toBeVisible();

  // Delivery keeps v1 until the asset is published again.
  await expect(sheet.getByText('Delivery serves version 1')).toBeVisible();
  await sheet.getByRole('button', { name: 'Publish v2' }).click();
  await expect(sheet.getByText('Delivery serves version 1')).toHaveCount(0);
  await expect(top.getByText('Published')).toBeVisible();

  // Restore v1: asked in place, then its file is current again as v3.
  await sheet.getByRole('button', { name: 'Restore version 1' }).click();
  await sheet
    .getByRole('alertdialog', { name: /Restore version 1\?/ })
    .getByRole('button', { name: 'Restore v1' })
    .click();
  await expect(page.getByText('Restored version 1 as version 3')).toBeVisible();
  await expect(versions.getByRole('listitem')).toHaveCount(3);
  const restored = versions.getByRole('listitem').first();
  await expect(restored.getByText('v3', { exact: true })).toBeVisible();
  await expect(restored.getByText('Restored from v1')).toBeVisible();
  await expect(restored.getByText(name)).toBeVisible();
});

test('publishing more assets than a page shows runs as a job and names the one it refused', async ({
  page,
  request,
}) => {
  // 51 assets seeded, then a job the engine works through in batches.
  test.setTimeout(180_000);
  const stamp = Date.now();
  const folderName = `Bulk ${stamp}`;
  const folderId = await seedAssetFolder(request, folderName);
  const titles = Array.from(
    { length: 51 },
    (_, i) => `Bulk ${stamp} ${String(i + 1).padStart(2, '0')}`,
  );
  const ids: string[] = [];
  for (let i = 0; i < titles.length; i += 10) {
    ids.push(
      ...(await Promise.all(
        titles.slice(i, i + 10).map((title) => seedAsset(request, title, { folderId })),
      )),
    );
  }
  // One under embargo: the job refuses it, and says which.
  const embargoed = titles[6] as string;
  const rights = await api(request, 'PUT', `${MGMT}/assets/${ids[6]}/rights`, {
    embargoUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  });
  expect(rights.ok(), await rights.text()).toBe(true);

  await openCms(page, '/assets');
  const library = page.getByRole('region', { name: 'Asset library' });
  await page
    .getByRole('navigation', { name: 'Folders' })
    .getByRole('button', { name: folderName, exact: true })
    .click();
  await library.getByRole('radio', { name: 'List' }).click();
  await expect(library.getByRole('row')).toHaveCount(51); // the header and the first page of 50
  await expect(library.getByText('Embargoed')).toBeVisible();
  await library.getByRole('button', { name: 'Load more' }).click();
  await expect(library.getByRole('row')).toHaveCount(52);
  await library.getByRole('checkbox', { name: 'Select all shown' }).check();
  const bar = page.getByRole('group', { name: 'Selected assets' });
  await expect(bar.getByText('51 selected')).toBeVisible();

  await bar.getByRole('button', { name: 'Publish selected', exact: true }).click();
  const job = page.getByRole('region', { name: 'Bulk job' });
  await expect(job.getByRole('progressbar', { name: 'Bulk job progress' })).toBeVisible();
  await expect(job.getByRole('status')).toHaveText('Published 50 of 51 assets; 1 failed', {
    timeout: 120_000,
  });
  const failures = page.getByRole('alert').filter({ hasText: '1 asset not published' });
  await expect(failures.getByText(embargoed, { exact: true })).toBeVisible();
  await expect(failures.getByText(/under embargo/)).toBeVisible();
  await expect(bar.getByText('1 selected')).toBeVisible();
  await expect(library.getByRole('checkbox', { name: `Select “${embargoed}”` })).toBeChecked();
});
