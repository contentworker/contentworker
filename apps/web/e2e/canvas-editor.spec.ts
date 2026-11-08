import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo, test } from '@playwright/test';
import { api, MGMT, openCms, SPACE, saveContentType, seedCms, useCmsScope } from './cms';
import { guestPort } from './live-guest/port';
import { settle } from './settle';

/**
 * The canvas editor, end to end: a type whose preview URL points at the guest page
 * (`e2e/live-guest`, which marks every blocks field and slot, so it reports seams in its layout),
 * an entry of it opened on the canvas. Choosing a seam opens the dock with only what that slot
 * takes; a block put in shows in the page before anything is saved; undo takes it back; Save draft
 * keeps it. Below md the canvas is review-only and says so. Under a block config set in Build →
 * Blocks, the dock offers only the narrowed blocks and a locked slot draws no seams.
 */
const GUEST = `http://localhost:${guestPort()}`;
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const field = (apiId: string, name: string, position = 0) => ({
  apiId,
  name,
  type: 'Symbol',
  localized: false,
  required: false,
  position,
});

test.beforeAll(async ({ request }) => {
  await seedCms(request);
  await saveType(request);
  await api(request, 'POST', `${MGMT}/content-types/canvasPage/published`);
});

const saveType = (request: Parameters<typeof api>[0]) =>
  saveContentType(request, {
    apiId: 'canvasPage',
    name: 'Canvas page',
    displayField: 'title',
    fields: [
      field('title', 'Title'),
      {
        apiId: 'body',
        name: 'Main',
        type: 'Array',
        localized: false,
        required: false,
        position: 1,
        validations: { size: { max: 8 } },
        items: {
          type: 'Component',
          variants: [
            { apiId: 'hero', name: 'Hero', fields: [field('heading', 'Heading')] },
            { apiId: 'cta', name: 'Call to action', fields: [field('label', 'Label')] },
            {
              apiId: 'section',
              name: 'Section',
              fields: [
                field('heading', 'Heading'),
                {
                  apiId: 'items',
                  name: 'Cards',
                  type: 'Array',
                  localized: false,
                  required: false,
                  position: 1,
                  validations: { size: { max: 2 } },
                  items: {
                    type: 'Component',
                    variants: [{ apiId: 'card', name: 'Card', fields: [field('title', 'Title')] }],
                  },
                },
              ],
            },
          ],
        },
      },
    ],
    preview: {
      urlTemplate: `${GUEST}/?entry={id}&type=canvasPage&space={space}&env={environment}#token={token}`,
    },
  });

test.beforeEach(async ({ page }) => {
  await useCmsScope(page);
});

/** A page: a hero, a section holding one card, and a call to action; opened on the canvas. */
async function openCanvas(page: Page, request: Parameters<typeof api>[0], title: string) {
  const res = await api(request, 'POST', `${MGMT}/entries`, {
    contentTypeApiId: 'canvasPage',
    fields: {
      title: { 'en-US': title },
      body: {
        'en-US': [
          { _type: 'hero', _key: 'h1', heading: 'Welcome' },
          {
            _type: 'section',
            _key: 's1',
            heading: 'Features',
            items: [{ _type: 'card', _key: 'c1', title: 'Fast' }],
          },
          { _type: 'cta', _key: 'a1', label: 'Start' },
        ],
      },
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
  const id = ((await res.json()) as { entry: { id: string } }).entry.id;
  await openCms(page, `/content/canvasPage/${id}/canvas`);
  const site = page
    .frameLocator('iframe[title="Site preview"]')
    .frameLocator('iframe[title="The entry on your site"]');
  await expect(site.getByRole('heading', { level: 1 })).toHaveText(title, { timeout: 15_000 });
  return { id, site };
}

/** axe over the whole canvas (and the frames in it), WCAG 2.1 A/AA. */
async function scan(page: Page, testInfo: TestInfo, name: string) {
  await settle(page);
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  if (results.violations.length > 0) {
    await testInfo.attach(`axe-${name}.json`, {
      body: JSON.stringify(results.violations, null, 2),
      contentType: 'application/json',
    });
  }
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    name,
  ).toEqual([]);
}

test('a seam opens the dock with only what fits there; a block put in shows unsaved, undoes and saves', async ({
  page,
  request,
}, testInfo) => {
  const { id, site } = await openCanvas(page, request, `Canvas ${testInfo.workerIndex}`);

  // The page reports its slots: a seam between the hero and the section, and one in the cards.
  const top = page.locator('[data-seam="body#1"]');
  await expect(top).toHaveCount(1);
  await top.click();
  const dock = page.getByRole('region', { name: 'Add to Main' });
  await expect(dock).toBeVisible();
  await expect(dock.locator('[data-dock-item]')).toHaveText(['Hero', 'Call to action', 'Section']);
  // A compact row along the bottom, and the chosen seam marked above it.
  expect((await dock.boundingBox())?.height ?? 999).toBeLessThanOrEqual(160);
  await expect(top.locator('[data-insertion-line]')).toHaveCount(1);
  await page.keyboard.press('ArrowRight');
  await expect(dock.getByRole('button', { name: 'Call to action' })).toBeFocused();
  await scan(page, testInfo, 'dock');

  // The cards slot takes cards only.
  await page.locator('[data-seam="body[s1].items#1"]').click();
  await expect(
    page.getByRole('region', { name: 'Add to Cards' }).locator('[data-dock-item]'),
  ).toHaveText(['Card']);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: /^Add to/ })).toHaveCount(0);

  // Put a call to action between the hero and the section: on the page at once, not saved.
  await top.click();
  await dock.getByRole('button', { name: 'Call to action' }).click();
  await expect(page.locator('[data-insertion-line]')).toHaveCount(0);
  const blocks = site.locator('#app > [data-cw-slot] > section');
  await expect(blocks).toHaveText(['Welcome', 'cta', /^Features/, 'Start']);
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Call to action' })).toBeFocused();
  await scan(page, testInfo, 'inspector');

  // Undo takes it out of the page; redo puts it back.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(blocks).toHaveText(['Welcome', /^Features/, 'Start']);
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(blocks).toHaveText(['Welcome', 'cta', /^Features/, 'Start']);
  await page.getByRole('textbox', { name: /^Label/ }).fill('Read more');
  await expect(blocks.nth(1)).toHaveText('Read more');

  // Saved through the entry's save, it is in the draft.
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft updated')).toBeVisible();
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);
  const saved = await api(request, 'GET', `/preview/${SPACE}/main/entries?sys.id=${id}&limit=1`);
  const { items } = (await saved.json()) as {
    items: { fields: { body: Record<string, { _type: string; label?: string }[]> } }[];
  };
  expect(items[0]?.fields.body['en-US']?.map((b) => b._type)).toEqual([
    'hero',
    'cta',
    'section',
    'cta',
  ]);
  expect(items[0]?.fields.body['en-US']?.[1]?.label).toBe('Read more');
});

test('Layers reaches every block by keyboard', async ({ page, request }, testInfo) => {
  await openCanvas(page, request, `Layers ${testInfo.workerIndex}`);
  await page.getByRole('button', { name: 'Layers' }).click();
  const tree = page.getByRole('tree', { name: 'Main blocks' });
  await tree.getByRole('treeitem', { name: /^Hero/ }).click();
  await page.keyboard.press('ArrowDown');
  await expect(tree.getByRole('treeitem', { name: /^Section/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('ArrowRight');
  await expect(tree.getByRole('treeitem', { name: /^Card/ })).toBeFocused();
  await expect(page.getByRole('heading', { level: 2, name: 'Card' })).toBeVisible();
  await scan(page, testInfo, 'layers');
});

test('below md the canvas is review-only, and says so', async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await openCanvas(page, request, `Narrow ${testInfo.workerIndex}`);
  await expect(page.getByText(/Arranging blocks needs a wider screen/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save draft' })).toHaveCount(0);
  await expect(page.locator('[data-seam]')).toHaveCount(0);
  await scan(page, testInfo, 'narrow');
});

/**
 * The block config, end to end, in an environment of its own (the config and the catalog are an
 * environment's, and the other specs share `main`): a catalog pushed for the page type, a
 * narrowing and a lock set in Build → Blocks, then the canvas honouring both.
 */
test('the rules set in Build → Blocks narrow the dock and lock a slot on the canvas', async ({
  page,
  request,
}, testInfo) => {
  const env = `rules${testInfo.workerIndex}${Date.now().toString(36)}`;
  const mgmt = `/spaces/${SPACE}/environments/${env}`;
  const made = await api(request, 'POST', `/spaces/${SPACE}/environments`, { id: env });
  expect(made.status(), await made.text()).toBe(201);
  const type = await api(request, 'POST', `${mgmt}/content-types`, {
    apiId: 'rulesPage',
    name: 'Rules page',
    displayField: 'title',
    fields: [
      field('title', 'Title'),
      {
        apiId: 'body',
        name: 'Main',
        type: 'Array',
        localized: false,
        required: false,
        position: 1,
        items: {
          type: 'Component',
          variants: [{ apiId: 'hero', name: 'Hero', fields: [field('heading', 'Heading')] }],
        },
      },
    ],
    preview: {
      urlTemplate: `${GUEST}/?entry={id}&type=rulesPage&space={space}&env={environment}#token={token}`,
    },
  });
  expect([200, 201], await type.text()).toContain(type.status());
  const pushed = await api(request, 'POST', `${mgmt}/block-catalog`, {
    targets: [{ contentTypeApiId: 'rulesPage', field: 'body' }],
    allowDestructive: true,
    blocks: [
      { id: 'hero', name: 'Hero', fields: [field('heading', 'Heading')] },
      { id: 'cta', name: 'Call to action', fields: [field('label', 'Label')] },
      {
        id: 'section',
        name: 'Section',
        fields: [field('heading', 'Heading')],
        slots: [{ apiId: 'items', name: 'Cards', allowedChildren: ['card'], max: 2 }],
      },
      { id: 'card', name: 'Card', allowedParents: ['section'], fields: [field('title', 'Title')] },
    ],
  });
  expect(pushed.status(), await pushed.text()).toBe(200);
  const entry = await api(request, 'POST', `${mgmt}/entries`, {
    contentTypeApiId: 'rulesPage',
    fields: {
      title: { 'en-US': 'Ruled page' },
      body: {
        'en-US': [
          { _type: 'hero', _key: 'h1', heading: 'Welcome' },
          {
            _type: 'section',
            _key: 's1',
            heading: 'Features',
            items: [{ _type: 'card', _key: 'c1', title: 'Fast' }],
          },
          { _type: 'cta', _key: 'a1', label: 'Start' },
        ],
      },
    },
  });
  expect(entry.ok(), await entry.text()).toBe(true);
  const id = ((await entry.json()) as { entry: { id: string } }).entry.id;
  await page.addInitScript(
    ([space, environment]) =>
      localStorage.setItem(
        'contentworker-scope',
        JSON.stringify({ space, environment, locale: 'en-US' }),
      ),
    [SPACE, env],
  );

  // Build → Blocks: the top level takes no calls to action any more, and the cards are locked.
  await openCms(page, '/blocks');
  const rules = page.getByRole('list', { name: 'Rules by place' });
  await expect(rules.getByText('Rules page › Main')).toBeVisible();
  await page.getByRole('button', { name: 'Edit the rules for Rules page › Main' }).click();
  const top = page.getByRole('group', { name: 'Rules for Rules page › Main' });
  await top.getByLabel('Call to action').click();
  await page.getByRole('switch', { name: 'Lock Section › Cards' }).click();
  await page.getByRole('button', { name: 'Save rules' }).click();
  await expect(page.getByText('Rules saved as v1')).toBeVisible();
  await expect(rules.getByText('Editors may place Hero, Section · any number')).toBeVisible();
  await expect(rules.getByText(/^Editors may place Card · up to 2 · locked$/)).toBeVisible();

  // The canvas: the dock offers what the rule takes; the locked cards draw no seam.
  await openCms(page, `/content/rulesPage/${id}/canvas`);
  const site = page
    .frameLocator('iframe[title="Site preview"]')
    .frameLocator('iframe[title="The entry on your site"]');
  await expect(site.getByRole('heading', { level: 1 })).toHaveText('Ruled page', {
    timeout: 15_000,
  });
  const seam = page.locator('[data-seam="body#1"]');
  await expect(seam).toHaveCount(1);
  await expect(page.locator('[data-seam^="body[s1].items"]')).toHaveCount(0);
  await seam.click();
  const dock = page.getByRole('region', { name: 'Add to Main' });
  await expect(dock.locator('[data-dock-item]')).toHaveText(['Hero', 'Section']);
  // The call to action stored before the rules stays on the page.
  await expect(site.locator('#app > [data-cw-slot] > section')).toHaveText([
    'Welcome',
    /^Features/,
    'Start',
  ]);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Layers' }).click();
  await expect(page.getByRole('group', { name: 'Cards · 1 of 2 · locked' })).toBeAttached();
  await scan(page, testInfo, 'rules');
});
