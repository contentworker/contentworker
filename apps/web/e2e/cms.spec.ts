import { expect, type Page, test } from '@playwright/test';
import { api, EDITOR_READY, MGMT, openCms, SPACE, seedCms, useCmsScope } from './cms';

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
  await page.getByRole('main').getByRole('link', { name: 'View entries' }).first().click();
  await expect(page).toHaveURL(/\/content\/article$/);
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
