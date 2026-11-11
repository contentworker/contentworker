import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo, test } from '@playwright/test';
import { api, openCms, SPACE, useCmsScope } from './cms';
import { guestPort } from './live-guest/port';
import { settle } from './settle';

/**
 * Moving blocks on the canvas in a real browser, where jsdom can't follow: a card dragged by its
 * grip over the framed page (pointer capture, across the frame) to another grid, a refused drop
 * that says why, and Move to by keyboard, with the inspector swept by axe. In an environment of its
 * own: the catalog is an environment's, and the other specs share `main`.
 */
const GUEST = `http://localhost:${guestPort()}`;
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const symbol = (apiId: string, name: string) => ({
  apiId,
  name,
  type: 'Symbol',
  localized: false,
  required: false,
  position: 0,
});

test.beforeEach(async ({ page }) => {
  await useCmsScope(page);
});

/** A page of a hero and two card grids, under a catalog with breakpoints, opened on the canvas. */
async function openArranged(page: Page, request: Parameters<typeof api>[0], testInfo: TestInfo) {
  const env = `arrange${testInfo.workerIndex}${Date.now().toString(36)}`;
  const mgmt = `/spaces/${SPACE}/environments/${env}`;
  const made = await api(request, 'POST', `/spaces/${SPACE}/environments`, { id: env });
  expect(made.status(), await made.text()).toBe(201);
  const type = await api(request, 'POST', `${mgmt}/content-types`, {
    apiId: 'arrangedPage',
    name: 'Arranged page',
    displayField: 'title',
    fields: [
      symbol('title', 'Title'),
      {
        apiId: 'body',
        name: 'Main',
        type: 'Array',
        localized: false,
        required: false,
        position: 1,
        items: {
          type: 'Component',
          variants: [{ apiId: 'hero', name: 'Hero', fields: [symbol('heading', 'Heading')] }],
        },
      },
    ],
    preview: {
      urlTemplate: `${GUEST}/?entry={id}&type=arrangedPage&space={space}&env={environment}#token={token}`,
    },
  });
  expect([200, 201], await type.text()).toContain(type.status());
  const pushed = await api(request, 'POST', `${mgmt}/block-catalog`, {
    targets: [{ contentTypeApiId: 'arrangedPage', field: 'body' }],
    allowDestructive: true,
    blocks: [
      {
        id: 'hero',
        name: 'Hero',
        fields: [symbol('heading', 'Heading')],
      },
      {
        id: 'grid',
        name: 'Card grid',
        fields: [symbol('title', 'Title')],
        slots: [{ apiId: 'cards', name: 'Cards', allowedChildren: ['card'], max: 3 }],
      },
      { id: 'card', name: 'Card', allowedParents: ['grid'], fields: [symbol('title', 'Title')] },
    ],
  });
  expect(pushed.status(), await pushed.text()).toBe(200);
  const card = (key: string, title: string) => ({ _type: 'card', _key: key, title });
  const entry = await api(request, 'POST', `${mgmt}/entries`, {
    contentTypeApiId: 'arrangedPage',
    fields: {
      title: { 'en-US': 'Arranged page' },
      body: {
        'en-US': [
          { _type: 'hero', _key: 'h1', heading: 'Welcome' },
          {
            _type: 'grid',
            _key: 'gA',
            title: 'First',
            cards: [card('a1', 'One'), card('a2', 'Two')],
          },
          { _type: 'grid', _key: 'gB', title: 'Second', cards: [card('b1', 'Three')] },
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
  await openCms(page, `/content/arrangedPage/${id}/canvas`);
  const site = page
    .frameLocator('iframe[title="Site preview"]')
    .frameLocator('iframe[title="The entry on your site"]');
  await expect(site.getByRole('heading', { level: 1 })).toHaveText('Arranged page', {
    timeout: 15_000,
  });
  return { site };
}

/** The cards of the grid titled `title`, as the page renders them. */
const cardsOf = (site: ReturnType<Page['frameLocator']>, title: string) =>
  site
    .locator('section', { has: site.locator(':scope > p', { hasText: title }) })
    .locator('[data-cw-slot] > section');

/** A box once it holds still: selecting a block scrolls the page to it, and the seams with it. */
async function settledBox(page: Page, selector: string) {
  let last = '';
  await expect
    .poll(async () => {
      const box = JSON.stringify(await page.locator(selector).boundingBox());
      const still = box === last && box !== 'null';
      last = box;
      return still;
    })
    .toBe(true);
  return JSON.parse(last) as { x: number; y: number; width: number; height: number };
}

/** Presses the selected block's grip and carries it to the seam `id`, letting go unless told. */
async function dragTo(page: Page, seam: string, release = true) {
  const grip = await settledBox(page, '[data-drag-handle]');
  const target = await settledBox(page, `[data-seam="${seam}"]`);
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  // Over the framed page the whole way: the grip holds the pointer (capture).
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
  if (release) await page.mouse.up();
}

test('a card drags across grids over the page; a refused drop says why', async ({
  page,
  request,
}, testInfo) => {
  const { site } = await openArranged(page, request, testInfo);
  await page.getByRole('button', { name: 'Layers' }).click();

  await page.locator('[data-layer="a2"]').click();
  await expect(page.locator('[data-drag-handle="a2"]')).toBeVisible();
  await dragTo(page, 'body[gB].cards#1');
  await expect(cardsOf(site, 'Second')).toHaveText(['Three', 'Two']);
  await expect(cardsOf(site, 'First')).toHaveText(['One']);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(cardsOf(site, 'First')).toHaveText(['One', 'Two']);

  // The hero can't go among cards: the seam says so while it is carried, and nothing changes.
  await page.locator('[data-layer="h1"]').click();
  // Between two cards, away from Main's own seams (which do take a hero).
  await dragTo(page, 'body[gA].cards#1', false);
  await expect(page.locator('[data-seam-says]')).toHaveText('Cards doesn’t take Hero');
  await page.mouse.up();
  await expect(page.locator('[data-drag-chip]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
});

test('Move to by keyboard, with the inspector swept by axe', async ({
  page,
  request,
}, testInfo) => {
  const { site } = await openArranged(page, request, testInfo);
  await page.getByRole('button', { name: 'Layers' }).click();

  // Move to: Enter on the card in Layers opens its settings; the menu is keys all the way.
  await page.locator('[data-layer="a1"]').click();
  await page.keyboard.press('Enter');
  const settings = page.getByRole('complementary', { name: 'Block settings' });
  await settings.getByRole('button', { name: 'Move Card to another slot' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Card grid “Second” › Cards' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(cardsOf(site, 'Second')).toHaveText(['Three', 'One']);
  await expect(settings.getByRole('heading', { level: 2, name: 'Card' })).toBeFocused();

  await settle(page);
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
});
