import { expect, test } from '@playwright/test';
import { fakeSafeArea, isPhone, isTouch, open, PAGES, tapTargets } from './helpers';

// With nobody added yet, local development is open: every page renders as an admin.

for (const path of PAGES) {
  test(`${path} renders in the shell and doesn't scroll sideways`, async ({ page }) => {
    await open(page, path);
    await expect(page.locator('h1').first()).toBeAttached();
    const [scroll, width] = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      window.innerWidth,
    ]);
    expect(scroll, `page is ${scroll}px wide in a ${width}px viewport`).toBeLessThanOrEqual(width);
  });
}

test('/ goes to the overview', async ({ page }) => {
  await open(page, '/');
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
});

test('a CMS screen is the real screen, not a placeholder', async ({ page }) => {
  await open(page, '/releases');
  // The screen's own h1, with or without a space yet (a fresh database says so beneath it).
  await expect(page.getByRole('heading', { level: 1, name: 'Releases' })).toBeVisible();
  await expect(page.getByText('This screen is being ported')).toHaveCount(0);
});

test('wider screens get the sidebar, grouped, with the deployment pages for admins', async ({
  page,
}, info) => {
  test.skip(isPhone(info), 'phones have the tab bar');
  await open(page, '/content');
  const side = page.getByRole('navigation', { name: 'Main' }).first();
  for (const name of ['Overview', 'Content', 'Approvals', 'Releases', 'Media', 'Settings'])
    await expect(side.getByRole('link', { name, exact: true })).toBeVisible();
  await expect(side.getByRole('link', { name: 'Content', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(side.getByRole('link', { name: 'People and sign-in' })).toBeVisible();
});

test('phones get the tab bar, clear of the status bar and home indicator', async ({
  page,
}, info) => {
  test.skip(!isPhone(info), 'phones only');
  await open(page, '/dashboard');
  await fakeSafeArea(page);
  const bar = page.locator('nav[aria-label="Main"]:visible');
  for (const name of ['Overview', 'Content', 'Approvals', 'Releases'])
    await expect(bar.getByRole('link', { name })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'More' })).toBeVisible();
  const tab = await bar.getByRole('link', { name: 'Content' }).boundingBox();
  expect(tab!.y + tab!.height, 'a tab sits above the 34px home indicator').toBeLessThanOrEqual(
    page.viewportSize()!.height - 34,
  );
  const mark = await page.getByRole('link', { name: 'contentworker overview' }).boundingBox();
  expect(mark!.y, 'the top bar sits below the 47px status bar').toBeGreaterThanOrEqual(47);
});

test('More holds the other pages and closes on navigation', async ({ page }, info) => {
  test.skip(!isPhone(info), 'phones only');
  await open(page, '/dashboard');
  await page.getByRole('button', { name: 'More' }).tap();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('link', { name: 'Media' }).tap();
  await expect(page).toHaveURL(/\/media$/);
  await expect(sheet).toBeHidden();
  // The route announcer says where the navigation landed.
  await expect(page.locator('p[aria-live="polite"][aria-atomic="true"]')).toHaveText(/Media/);
});

test('controls take a 44px tap on touch screens', async ({ page }, info) => {
  test.skip(!isTouch(info), 'touch screens only');
  await open(page, '/dashboard');
  const targets = await tapTargets(
    page,
    'header a, header button, nav[aria-label="Main"] a, nav[aria-label="Main"] button',
  );
  expect(targets.length).toBeGreaterThan(0);
  expect(targets.filter((t) => t.height < 44)).toEqual([]);
});

test('Account offers the Home Screen on an iPhone or iPad, until dismissed', async ({
  page,
}, info) => {
  const hint = page.getByRole('complementary', { name: 'Add to Home Screen' });
  await open(page, '/account');
  if (info.project.name === 'desktop') {
    await expect(hint).toHaveCount(0);
    return;
  }
  await expect(hint).toBeVisible();
  await hint.getByRole('button', { name: 'Not now' }).click();
  await expect(hint).toHaveCount(0);
});

test('G then a letter goes to a page, and ? lists the shortcuts', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'a hardware keyboard');
  await open(page, '/dashboard');
  await page.locator('main h1').click();
  await page.keyboard.press('g');
  await page.keyboard.press('r');
  await expect(page).toHaveURL(/\/releases$/);
  await page.locator('main h1').click();
  await page.keyboard.press('Shift+?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
});
