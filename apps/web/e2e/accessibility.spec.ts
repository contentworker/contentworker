import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo, test } from '@playwright/test';
import {
  asFreshDeployment,
  createChanged,
  openCms,
  PROPOSAL_TARGET,
  seedAsset,
  seedAssetFolder,
  seedCms,
  seedIngestFindings,
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
