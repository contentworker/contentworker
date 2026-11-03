import { expect, test } from '@playwright/test';
import { api, EDITOR_READY, MGMT, openCms, seedCms, useCmsScope } from './cms';

/*
 * An entry form laid out in more tabs than a tablet or phone is wide: the tab bar scrolls inside
 * the form, and the page never scrolls sideways. Layout is what jsdom can't judge, so it is
 * measured here in WebKit on an iPad and an iPhone.
 */

const TABS = [
  'Overview',
  'Schedule and venue',
  'Speakers',
  'Tickets and pricing',
  'Sponsors',
  'Press',
];

test.beforeAll(async ({ request }) => {
  await seedCms(request);
  const field = (apiId: string, position: number) => ({
    apiId,
    name: TABS[position] ?? apiId,
    type: 'Symbol',
    localized: false,
    required: position === 0,
    position,
  });
  const res = await api(request, 'POST', `${MGMT}/content-types`, {
    apiId: 'conference',
    name: 'Conference',
    displayField: 'f0',
    layout: {
      tabs: TABS.map((name, i) => ({ apiId: `t${i}`, name, groups: [{ fields: [`f${i}`] }] })),
    },
    fields: TABS.map((_, i) => field(`f${i}`, i)),
  });
  if (![200, 201].includes(res.status())) throw new Error(await res.text());
  await api(request, 'POST', `${MGMT}/content-types/conference/published`);
});

test.beforeEach(async ({ page }) => {
  await useCmsScope(page);
});

test('entry tabs scroll inside the form, and the page never scrolls sideways', async ({ page }) => {
  await openCms(page, '/content/conference/new');
  const tabs = page.getByRole('tablist', { name: 'Sections of the entry' });
  await expect(tabs).toBeVisible(EDITOR_READY);

  const viewport = page.viewportSize()?.width ?? 0;
  const box = (await tabs.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport + 1);
  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(pageOverflow).toBeLessThanOrEqual(0);

  // The last tab is reached by scrolling the bar, and opens its section.
  const last = page.getByRole('tab', { name: 'Press' });
  await last.scrollIntoViewIfNeeded();
  await last.click();
  await expect(page.getByLabel('Press')).toBeVisible();
});
