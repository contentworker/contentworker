import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo, test } from '@playwright/test';
import {
  api,
  asFreshDeployment,
  createChanged,
  MGMT,
  openCms,
  PROPOSAL_TARGET,
  seedAsset,
  seedAssetFolder,
  seedCms,
  seedIngestFindings,
  uploadAssetBytes,
  useCmsScope,
  withoutAssistant,
} from './cms';
import { settle } from './settle';

/**
 * Accessibility sweep over the CMS screens, WCAG 2.1 A/AA (PRODUCT.md's bar). jsdom is not a
 * credible authority on computed accessibility (a Radix checkbox named by a wrapping label in
 * jsdom is unnamed in a real browser), so axe runs here, over every screen and the dialogs a
 * route sweep can't reach.
 */
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.beforeAll(async ({ request }) => {
  await seedCms(request);
});

test.beforeEach(async ({ page }) => {
  await useCmsScope(page);
});

async function scan(page: Page, testInfo: TestInfo) {
  await settle(page);
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  if (results.violations.length > 0) {
    await testInfo.attach('axe-violations.json', {
      body: JSON.stringify(results.violations, null, 2),
      contentType: 'application/json',
    });
  }
  const summary = results.violations.map(
    (v) =>
      `${v.id} (${v.impact}) × ${v.nodes.length}: ${v.help}\n${v.nodes
        .map((n) => `    ${n.target.join(' ')}\n      ${n.html.slice(0, 160)}`)
        .join('\n')}`,
  );
  expect(summary, `accessibility violations:\n${summary.join('\n')}`).toEqual([]);
}

/** Every CMS screen, plus each settings section (each a different component tree). */
const ROUTES: readonly (readonly [name: string, path: string])[] = [
  ['overview', '/dashboard'],
  ['content types', '/content'],
  ['entries', '/content/article'],
  ['new entry', '/content/article/new'],
  ['import', '/content/article/import'],
  ['approvals', '/approvals'],
  ['releases', '/releases'],
  ['workflows', '/workflows'],
  ['taxonomy', '/taxonomy'],
  ['settings: space access', '/settings/team'],
  ['settings: api keys', '/settings/api-keys'],
  ['settings: connected apps', '/settings/connected-apps'],
  ['settings: roles', '/settings/roles'],
  ['settings: webhooks', '/settings/webhooks'],
  ['settings: environments', '/settings/environments'],
  ['settings: ai actions', '/settings/ai-actions'],
  ['settings: functions', '/settings/functions'],
  ['settings: extensions', '/settings/extensions'],
  ['settings: plugins', '/settings/plugins'],
  ['settings: audit log', '/settings/audit-log'],
];

for (const [name, path] of ROUTES) {
  test(`${name} has no accessibility violations`, async ({ page }, testInfo) => {
    await openCms(page, path);
    // Wait for the route's own content (these screens render after a fetch): a card, a table, a
    // tablist, or at least its h1 and a button.
    await expect(
      page
        .locator('main [data-slot="card"], main table, main [role="tablist"]')
        .or(page.getByRole('main').getByRole('button'))
        .first(),
    ).toBeVisible();
    // The inbox holds the seeded agent proposal: scan it once its diff has loaded and the decision
    // buttons are enabled, not while they are still dimmed and fading in.
    if (path === '/approvals') {
      await expect(page.getByRole('button', { name: 'Approve and apply' }).first()).toBeEnabled();
    }
    await scan(page, testInfo);
  });
}

// With assets and a folder in it, so the scan sees cards, the tree's nesting, the list's rows and
// the bulk bar, not an empty library.
test('the asset library, its list view and its bulk bar have no accessibility violations', async ({
  page,
  request,
}, testInfo) => {
  const stamp = Date.now();
  const folderId = await seedAssetFolder(request, `A11y ${stamp}`);
  await seedAsset(request, `A11y ${stamp} filed`, { folderId });
  await seedAsset(request, `A11y ${stamp} root`, { publish: true });
  await openCms(page, '/assets');
  const library = page.getByRole('region', { name: 'Asset library' });
  await expect(library.getByRole('button', { name: `Open “A11y ${stamp} root”` })).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'Folders' })
      .getByRole('button', { name: `A11y ${stamp}`, exact: true }),
  ).toBeVisible();
  await scan(page, testInfo);

  // A delete confirm in place on a card: the tinted destructive pill on the confirm's tile, in
  // both themes (its red is tuned per theme to hold 4.5:1 on that tint).
  await library.getByRole('button', { name: `Delete “A11y ${stamp} root”` }).click();
  const confirm = library.getByRole('alertdialog', { name: `Delete “A11y ${stamp} root”?` });
  await expect(confirm.getByRole('button', { name: 'Delete' })).toBeVisible();
  await scan(page, testInfo);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await scan(page, testInfo);
  await page.emulateMedia({ colorScheme: 'light' });
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();

  await library.getByRole('radio', { name: 'List' }).click();
  await expect(library.getByRole('table')).toBeVisible();
  await scan(page, testInfo);

  await library.getByRole('checkbox', { name: `Select “A11y ${stamp} root”` }).check();
  await expect(page.getByRole('group', { name: 'Selected assets' })).toBeVisible();
  await scan(page, testInfo);

  // A search: the box, its summary and (when anything is indexed) the facet chips.
  await library.getByRole('searchbox', { name: 'Search assets' }).fill(`a11y ${stamp}`);
  await expect(library.getByText(new RegExp(`for “a11y ${stamp}”`))).toBeVisible();
  await scan(page, testInfo);
});

// A collection open in place of the library, with members to reorder, its zip card, and its
// share dialog with a link listed: the sidebar's two lists, the ordered list's move buttons, the
// segmented expiry, the switch and the in-place revoke, in both themes.
test('an asset collection, its zip and its share dialog have no accessibility violations', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  const name = `A11y set ${stamp}`;
  const ids: string[] = [];
  for (const n of [1, 2]) {
    const id = await uploadAssetBytes(request, `a11y-${stamp}-${n}.txt`, Buffer.from(`${n}`));
    const pub = await api(request, 'POST', `${MGMT}/assets/${id}/published`);
    expect(pub.ok(), await pub.text()).toBe(true);
    ids.push(id);
  }
  const made = await api(request, 'POST', `${MGMT}/asset-collections`, {
    name,
    description: 'For the sweep',
  });
  expect(made.ok(), await made.text()).toBe(true);
  const { id } = (await made.json()) as { id: string };
  const added = await api(request, 'POST', `${MGMT}/asset-collections/${id}/assets`, {
    assetIds: ids,
  });
  expect(added.ok(), await added.text()).toBe(true);

  await openCms(page, '/assets');
  await page
    .getByRole('navigation', { name: 'Collections' })
    .getByRole('button', { name: `${name}, 2 assets` })
    .click();
  const list = page.getByRole('list', { name: `Assets in “${name}”, in order` });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await scan(page, testInfo);

  await page.getByRole('button', { name: 'Download as zip' }).click();
  await expect(page.getByRole('region', { name: 'Zip download' })).toBeVisible();
  await scan(page, testInfo);

  await page.getByRole('button', { name: 'Share' }).click();
  const dialog = page.getByRole('dialog', { name: `Share “${name}”` });
  const form = dialog.getByRole('form', { name: 'New share link' });
  await form.getByRole('radio', { name: 'Custom' }).click();
  await expect(form.getByLabel('Expires at')).toBeVisible();
  await form.getByRole('radio', { name: '7 days' }).click();
  await form.getByRole('button', { name: 'Create link' }).click();
  await expect(
    dialog.getByRole('list', { name: 'Active links' }).getByRole('listitem'),
  ).toHaveCount(1);
  await scan(page, testInfo);
  await dialog.getByRole('button', { name: /Revoke the link/ }).click();
  await expect(dialog.getByRole('alertdialog', { name: /Revoke this link\?/ })).toBeVisible();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await scan(page, testInfo);
  await page.emulateMedia({ colorScheme: 'light' });
});

// An unpublished asset's share dialog: the warning in place of the form, over the sheet.
test('the share dialog for an unpublished asset has no accessibility violations', async ({
  page,
  request,
}, testInfo) => {
  const name = `a11y-draft-${Date.now()}.txt`;
  await uploadAssetBytes(request, name, Buffer.from('draft'));
  await openCms(page, '/assets');
  await page
    .getByRole('region', { name: 'Asset library' })
    .getByRole('button', { name: `Open “${name}”` })
    .click();
  await page.getByRole('dialog', { name }).getByRole('button', { name: 'Share' }).click();
  const dialog = page.getByRole('dialog', { name: `Share “${name}”` });
  await expect(dialog.getByText('Publish it to share it')).toBeVisible();
  await scan(page, testInfo);
});

// What ingest found, in sight: a possible duplicate, a failed ingest with its reason and Retry,
// and the copy's sheet asking before an edit is discarded.
test('the asset library with ingest badges has no accessibility violations', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const { copy, broken } = await seedIngestFindings(request, stamp);
  await openCms(page, '/assets');
  const library = page.getByRole('region', { name: 'Asset library' });
  const duplicateBadge = `Possible duplicate: open the asset “${copy}” duplicates`;
  await expect(library.getByRole('button', { name: duplicateBadge })).toBeVisible();
  await expect(library.getByRole('button', { name: `Retry processing “${broken}”` })).toBeVisible();
  await scan(page, testInfo);

  await library.getByRole('button', { name: `Open “${copy}”` }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel('Alt text (en-US)').fill('Not saved yet');
  await sheet.getByRole('button', { name: duplicateBadge }).click();
  await expect(sheet.getByRole('alertdialog')).toBeVisible();
  await scan(page, testInfo);
});

// The asset sheet, tab by tab: a version list with an older version to restore (and its in-place
// confirm), usage, renditions, and the rights form with its status and a field the API refused.
test('the asset sheet’s tabs have no accessibility violations', async ({
  page,
  request,
}, testInfo) => {
  const stamp = Date.now();
  const name = `a11y-versions-${stamp}.txt`;
  const id = await uploadAssetBytes(request, name, Buffer.from(`one ${stamp}`));
  const replace = await api(request, 'POST', `${MGMT}/assets/${id}/file`, {
    fileName: `a11y-versions-${stamp}-2.txt`,
    contentType: 'text/plain',
  });
  expect(replace.ok(), await replace.text()).toBe(true);
  const { upload, commit } = (await replace.json()) as {
    upload: { url: string; headers: Record<string, string> };
    commit: unknown;
  };
  const put = await request.fetch(upload.url, {
    method: 'PUT',
    headers: upload.headers,
    data: Buffer.from(`two ${stamp}`),
  });
  expect(put.ok(), await put.text()).toBe(true);
  const committed = await api(request, 'POST', `${MGMT}/assets/${id}/file/commit`, commit);
  expect(committed.ok(), await committed.text()).toBe(true);
  const rights = await api(request, 'PUT', `${MGMT}/assets/${id}/rights`, {
    license: 'CC BY 4.0',
    expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
  });
  expect(rights.ok(), await rights.text()).toBe(true);

  await openCms(page, '/assets');
  const library = page.getByRole('region', { name: 'Asset library' });
  await expect(library.getByText('Expires soon').first()).toBeVisible();
  await library.getByRole('button', { name: `Open “${name}”` }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByLabel('Alt text (en-US)')).toBeVisible();
  await scan(page, testInfo);

  await sheet.getByRole('tab', { name: 'Versions' }).click();
  await expect(
    sheet.getByRole('list', { name: 'File versions' }).getByRole('listitem'),
  ).toHaveCount(2);
  await scan(page, testInfo);
  await sheet.getByRole('button', { name: 'Restore version 1' }).click();
  await expect(sheet.getByRole('alertdialog')).toBeVisible();
  await scan(page, testInfo);
  await sheet.getByRole('button', { name: 'Cancel' }).click();

  await sheet.getByRole('tab', { name: 'Usage' }).click();
  await expect(sheet.getByText('Not referenced by any entry.')).toBeVisible();
  await scan(page, testInfo);

  await sheet.getByRole('tab', { name: 'Renditions' }).click();
  await expect(sheet.getByText(/Renditions are made from images/)).toBeVisible();
  await scan(page, testInfo);

  await sheet.getByRole('tab', { name: 'Rights' }).click();
  await expect(sheet.getByText(/Expires in 3 days/)).toBeVisible();
  await scan(page, testInfo);
  // An embargo after the expiry: refused beside the field.
  await sheet.getByLabel('Embargo until').fill('2099-01-01T09:00');
  await sheet.getByRole('button', { name: 'Save rights' }).click();
  await expect(sheet.getByLabel('Expires at')).toHaveAttribute('aria-invalid', 'true');
  await scan(page, testInfo);
});

test('the content type dialog has no accessibility violations', async ({ page }, testInfo) => {
  await openCms(page, '/content');
  await page
    .getByRole('button', { name: /New content type|\+ New/ })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await scan(page, testInfo);
});

test('the first-space notice and its dialog have no accessibility violations', async ({
  page,
}, testInfo) => {
  await asFreshDeployment(page, () => false);
  await openCms(page, '/dashboard');
  await expect(page.getByRole('heading', { name: 'Create your first space' })).toBeVisible();
  await scan(page, testInfo);
  await page.getByRole('button', { name: 'Create a space' }).click();
  await expect(page.getByRole('dialog', { name: 'New space' })).toBeVisible();
  await scan(page, testInfo);
});

test('the webhook dialog has no accessibility violations', async ({ page }, testInfo) => {
  await openCms(page, '/settings/webhooks');
  await page.getByPlaceholder('https://example.com/hooks/cms').fill('https://example.com/a11y');
  await page.getByPlaceholder('Signing secret').fill('a11y-secret');
  await page.getByRole('button', { name: 'Add webhook' }).click();
  const edit = page.getByRole('button', { name: 'Edit' }).first();
  await edit.waitFor();
  await edit.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await scan(page, testInfo);
});

test('permission checkboxes are named in a real browser', async ({ page }) => {
  await openCms(page, '/settings/connected-apps');
  for (const label of [
    'Read published content',
    'Read drafts',
    'Search content',
    'Create and edit content',
    'Publish content',
    'Change content types',
    'Administer the space',
  ]) {
    await expect(page.getByRole('checkbox', { name: label })).toBeVisible();
  }
});

test('plugin capability checkboxes are named in a real browser', async ({ page }) => {
  await openCms(page, '/settings/plugins');
  await page.getByRole('button', { name: 'Install plugin' }).click();
  await page.getByLabel(/manifest/i).setInputFiles({
    name: 'plugin.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        id: 'com.example.a11y',
        name: 'Consent probe',
        version: '1.0.0',
        capabilities: ['content:read', 'content:write', 'network:request'],
        allowedHosts: ['api.example.com'],
        hooks: ['entry:beforeSave'],
        entrypoint: 'index.js',
      }),
    ),
  });
  for (const label of ['Read content', 'Create and edit content', 'Call external services']) {
    await expect(page.getByRole('checkbox', { name: label })).toBeVisible();
  }
  await expect(page.getByRole('checkbox', { name: 'Call external services' })).toBeEnabled();
});

test('repeater controls are named per item in a real browser', async ({ page }, info) => {
  test.skip(info.project.name.startsWith('iphone'), 'the editor is review-only on a phone');
  await openCms(page, '/content/article/new');
  await expect(page.getByRole('button', { name: 'Add callout' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Add callout' }).click();
  await page.getByRole('button', { name: 'Add callout' }).click();
  await expect(page.getByRole('button', { name: 'Remove Callout 1' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove Callout 2' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Move Callout 1 up' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Move Callout 2 down' })).toBeDisabled();
  await expect(page.getByLabel('Heading').first()).toBeVisible();
});

test('the import wizard has no accessibility violations', async ({ page }, testInfo) => {
  await openCms(page, '/content/article/import');
  await page.getByLabel('File').setInputFiles({
    name: 'entries.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('headline,body\nHello,World\n'),
  });
  await expect(page.getByText(/2 columns/)).toBeVisible();
  await scan(page, testInfo);
});

test('an agent proposal in the approvals diff table has no accessibility violations', async ({
  page,
}, testInfo) => {
  // The global setup (warm.ts) seeded one pending proposal for this entry: the plain /approvals
  // sweep sees it too, so the diff table is always scanned.
  const title = PROPOSAL_TARGET;
  await openCms(page, '/approvals');
  const proposal = page.getByRole('listitem', { name: `Proposal for ${title}` });
  await expect(proposal.getByRole('table', { name: `Changes proposed to ${title}` })).toBeVisible();
  await expect(proposal.getByText('Agent proposed body')).toBeVisible();
  await expect(proposal.getByRole('button', { name: 'Approve and apply' })).toBeEnabled();
  await scan(page, testInfo);
});

test('the publish confirmation has no accessibility violations', async ({
  page,
  request,
}, testInfo) => {
  await withoutAssistant(page);
  const title = `Confirm ${Date.now()}`;
  await createChanged(request, title);
  await openCms(page, '/content/article');
  await page
    .getByRole('row', { name: new RegExp(title) })
    .getByRole('button', { name: `Publish “${title}”` })
    .click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByText('1 field changed')).toBeVisible();
  await scan(page, testInfo);
});
