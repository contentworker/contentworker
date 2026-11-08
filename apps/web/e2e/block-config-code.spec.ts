import { expect, type Locator, type Page, test } from '@playwright/test';
import { api, openCms, SPACE, seedCms, useCmsScope } from './cms';

/**
 * Build → Blocks' rules as code, in the real editor: a narrowing and a lock made in the Rules view
 * show in the Code view as the JSON a save sends (marked unsaved until saved), and Narrowed from
 * code diffs only the places they changed, each line's change signed − or +. CodeMirror is fetched
 * only when a code view opens. On a phone the diff is one column. In an environment of its own, as
 * the other block rules specs are, since a config is an environment's.
 */
const sym = (apiId: string, position = 0) => ({
  apiId,
  name: apiId,
  type: 'Symbol',
  localized: false,
  required: false,
  position,
});

test.beforeAll(async ({ request }) => {
  await seedCms(request);
});

test.beforeEach(async ({ page }) => {
  await useCmsScope(page);
});

async function ownEnvironment(page: Page, request: Parameters<typeof api>[0], tag: string) {
  const env = `code${tag}${Date.now().toString(36)}`;
  const mgmt = `/spaces/${SPACE}/environments/${env}`;
  const made = await api(request, 'POST', `/spaces/${SPACE}/environments`, { id: env });
  expect(made.status(), await made.text()).toBe(201);
  const type = await api(request, 'POST', `${mgmt}/content-types`, {
    apiId: 'codepage',
    name: 'Code page',
    displayField: 'title',
    fields: [
      sym('title'),
      {
        ...sym('body', 1),
        name: 'Main',
        type: 'Array',
        items: {
          type: 'Component',
          variants: [{ apiId: 'hero', name: 'Hero', fields: [sym('heading')] }],
        },
      },
    ],
  });
  expect([200, 201], await type.text()).toContain(type.status());
  const pushed = await api(request, 'POST', `${mgmt}/block-catalog`, {
    targets: [{ contentTypeApiId: 'codepage', field: 'body' }],
    allowDestructive: true,
    blocks: [
      { id: 'hero', name: 'Hero', fields: [sym('heading')] },
      { id: 'promo', name: 'Promo', fields: [sym('label')] },
      {
        id: 'grid',
        name: 'Grid',
        fields: [],
        slots: [
          { apiId: 'items', name: 'Items', allowedChildren: ['card', 'quote'], max: 6 },
          { apiId: 'aside', name: 'Aside', allowedChildren: ['quote'] },
        ],
      },
      { id: 'card', name: 'Card', fields: [sym('title')], allowedParents: ['grid'] },
      { id: 'quote', name: 'Quote', fields: [sym('text')], allowedParents: ['grid'] },
    ],
  });
  expect(pushed.status(), await pushed.text()).toBe(200);
  await page.addInitScript(
    ([space, environment]) =>
      localStorage.setItem(
        'contentworker-scope',
        JSON.stringify({ space, environment, locale: 'en-US' }),
      ),
    [SPACE, env],
  );
}

/** An editor's whole text: its lines, one per row (the docs here are short, so all are drawn). */
const textOf = async (editor: Locator) =>
  (await editor.locator('.cm-line').allInnerTexts()).join('\n');

test('the rules as code hold a narrowing and a lock, and the diff marks only those places', async ({
  page,
  request,
}, testInfo) => {
  await ownEnvironment(page, request, String(testInfo.workerIndex));
  const editorFetches: string[] = [];
  page.on('request', (r) => {
    if (/codemirror|block-config\/codemirror/i.test(r.url())) editorFetches.push(r.url());
  });
  await openCms(page, '/blocks');
  const rules = page.getByRole('list', { name: 'Rules by place' });
  await expect(rules.getByText('Code page › Main')).toBeVisible();
  // /blocks itself ships no editor.
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  expect(editorFetches).toEqual([]);

  // A narrowing (no promos at the top) and a lock (the grid's items), not saved yet.
  await page.getByRole('button', { name: 'Edit the rules for Code page › Main' }).click();
  await page.getByRole('group', { name: 'Rules for Code page › Main' }).getByLabel('Promo').click();
  await page.getByRole('switch', { name: 'Lock Grid › Items' }).click();

  const views = page.getByRole('radiogroup', { name: 'Show the rules as' });
  await views.getByRole('radio', { name: 'Code', exact: true }).click();
  const code = page.getByRole('textbox', { name: 'Block config as JSON' });
  await expect(code).toBeVisible();
  expect(editorFetches.length).toBeGreaterThan(0);
  await expect(page.getByText('Unsaved', { exact: true })).toBeVisible();
  await expect(code).toHaveAttribute('aria-readonly', 'true');
  const draft = {
    targets: [{ contentTypeApiId: 'codepage', field: 'body', blocks: ['hero', 'grid'] }],
    blocks: [{ block: 'grid', slots: { items: { locked: true } } }],
  };
  expect(JSON.parse(await textOf(code))).toEqual(draft);
  // Read-only: typing changes nothing.
  await code.click();
  await page.keyboard.type('x');
  expect(JSON.parse(await textOf(code))).toEqual(draft);

  // Saved, the same JSON is the rules in force.
  await page.getByRole('button', { name: 'Save rules' }).click();
  await expect(page.getByText('Rules saved as v1')).toBeVisible();
  await expect(page.getByText('Unsaved', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/^The rules in force, as PUT/)).toBeVisible();
  expect(JSON.parse(await textOf(code))).toEqual(draft);
  const stored = await api(request, 'GET', `${await scopePath(page)}/block-config`);
  const body = (await stored.json()) as typeof draft;
  expect({ targets: body.targets, blocks: body.blocks }).toEqual(draft);

  // Narrowed from code: the two places, not the grid's aside, which is the code's.
  await views.getByRole('radio', { name: 'Narrowed from code' }).click();
  const narrowed = page.getByRole('list', { name: 'Places narrowed from code' });
  await expect(narrowed.getByRole('heading')).toHaveText(['Code page › Main', 'Grid › Items']);
  await expect(narrowed.getByText(/Narrowed: the blocks it takes/)).toBeVisible();
  await expect(narrowed.getByText(/Narrowed: locked/)).toBeVisible();
  const wide = (page.viewportSize()?.width ?? 0) >= 768;
  if (wide) {
    const was = page.getByRole('textbox', { name: 'The code’s rule for Grid › Items, as JSON' });
    const now = page.getByRole('textbox', { name: 'The rule in force for Grid › Items, as JSON' });
    await expect(was).toContainText('"locked": false');
    await expect(now).toContainText('"locked": true');
    // Each changed line is signed, not only tinted: − on the code's side, + on the rule in force.
    const item = narrowed.getByRole('listitem').filter({ hasText: 'Grid › Items' });
    await expect(item.locator('.cm-merge-a .cm-diffSigns')).toContainText('−');
    await expect(item.locator('.cm-merge-b .cm-diffSigns')).toContainText('+');
  } else {
    const one = page.getByRole('textbox', {
      name: 'The rule in force for Grid › Items, with the code’s lines it replaces, as JSON',
    });
    await expect(one).toContainText('"locked": true');
    const item = narrowed.getByRole('listitem').filter({ hasText: 'Grid › Items' });
    await expect(item.locator('.cm-deletedChunk')).toContainText('"locked": false');
    await expect(item.locator('.cm-diffSigns')).toContainText('−');
    await expect(item.locator('.cm-diffSigns')).toContainText('+');
  }

  // Show all: every place, the aside as the code allows.
  await page.getByRole('switch', { name: 'Show all' }).click();
  const every = page.getByRole('list', { name: 'Every place, code against in force' });
  await expect(every.getByRole('heading')).toHaveText([
    'Code page › Main',
    'Grid › Items',
    'Grid › Aside',
  ]);
  await expect(every.getByRole('listitem').filter({ hasText: 'Grid › Aside' })).toContainText(
    'As the code allows',
  );

  // Nothing is remembered: the next visit opens on the rows.
  await openCms(page, '/blocks');
  await expect(views.getByRole('radio', { name: 'Rules' })).toBeChecked();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
});

test('Copy puts the JSON on the clipboard and says so', async ({
  page,
  request,
  browserName,
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'reading the clipboard back takes Chromium permissions');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await ownEnvironment(page, request, `c${testInfo.workerIndex}`);
  await openCms(page, '/blocks');
  await page.getByRole('switch', { name: 'Lock Grid › Aside' }).click();
  await page
    .getByRole('radiogroup', { name: 'Show the rules as' })
    .getByRole('radio', { name: 'Code', exact: true })
    .click();
  const code = page.getByRole('textbox', { name: 'Block config as JSON' });
  await expect(code).toBeVisible();
  await page.getByRole('button', { name: 'Copy JSON' }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(await textOf(code));
  expect(JSON.parse(copied)).toEqual({
    targets: [],
    blocks: [{ block: 'grid', slots: { aside: { locked: true } } }],
  });
});

/** The management path of the environment the page is in. */
async function scopePath(page: Page) {
  const scope = await page.evaluate(() => localStorage.getItem('contentworker-scope'));
  const { space, environment } = JSON.parse(scope ?? '{}') as {
    space: string;
    environment: string;
  };
  return `/spaces/${space}/environments/${environment}`;
}
