import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { api, openCms, SPACE, seedCms, useCmsScope } from './cms';
import { settle } from './settle';

/**
 * The Access sheet's save is held to the version of the role it opened with: someone saving the
 * role behind it keeps the sheet open with the edits, says so, and Reload role reads it again in
 * the same sheet; nothing of theirs is undone. Desktop Chrome with the axe sweep, and WebKit on a
 * phone, where the sheet comes from the bottom.
 */
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.beforeAll(async ({ request }) => {
  await seedCms(request);
});

test.beforeEach(async ({ page }) => {
  await useCmsScope(page);
});

test('a save someone beat keeps the edits, and Reload role shows theirs', async ({
  page,
  request,
}, testInfo) => {
  const name = `Beaten ${testInfo.project.name} ${Date.now()}`;
  const role = {
    name,
    scopes: ['content:write', 'preview:read'],
    contentGrants: [{ contentTypeApiId: '*', actions: ['read', 'write'] }],
  };
  const created = await api(request, 'POST', `/spaces/${SPACE}/roles`, role);
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };

  await openCms(page, '/settings/roles');
  const opener = page.getByRole('button', { name: `Content access for ${name}` });
  await opener.click();
  const sheet = page.getByRole('dialog', { name: `Content access: ${name}` });
  await expect(sheet.getByRole('button', { name: 'Save access' })).toBeDisabled();

  // Someone else gives the role publishing while the sheet is open.
  const behind = await api(request, 'PUT', `/spaces/${SPACE}/roles/${id}`, {
    ...role,
    contentGrants: [{ contentTypeApiId: '*', actions: ['read', 'write', 'publish'] }],
    expectedVersion: 1,
  });
  expect(behind.ok(), await behind.text()).toBe(true);

  const del = sheet.getByRole('checkbox', { name: 'Delete Every type', exact: true });
  await del.click();
  await sheet.getByRole('button', { name: 'Save access' }).click();
  const alert = sheet.getByRole('alert');
  await expect(alert).toContainText('Someone else changed this role');
  await expect(alert).toBeFocused();
  await expect(del).not.toBeChecked();
  await expect(sheet.getByRole('button', { name: 'Save access' })).toBeDisabled();
  await settle(page);
  const results = await new AxeBuilder({ page })
    .withTags(WCAG)
    .include('[role="dialog"]')
    .analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);

  // Theirs is what's stored: publishing kept, the delete not withheld.
  const stored = (await (await api(request, 'GET', `/spaces/${SPACE}/roles/${id}`)).json()) as {
    version: number;
    contentGrants: { actions: string[]; deniedActions?: string[] }[];
  };
  expect(stored.version).toBe(2);
  expect(stored.contentGrants[0]).toEqual({
    contentTypeApiId: '*',
    actions: ['read', 'write', 'publish'],
  });

  await alert.getByRole('button', { name: 'Reload role' }).click();
  await expect(alert).toHaveCount(0);
  await expect(
    sheet.getByRole('checkbox', { name: 'Publish Every type', exact: true }),
  ).toBeChecked();
  await expect(del).toBeChecked();
  await expect(sheet.getByRole('checkbox', { name: 'Read Every type', exact: true })).toBeFocused();

  // Nothing is dirty after the reload: Escape closes, and focus goes back to what opened it.
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(opener).toBeFocused();
});
