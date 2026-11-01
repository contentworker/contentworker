import { expect, test } from '@playwright/test';
import { open } from './helpers';

/**
 * Sign-in end to end. It turns sign-in on for the whole dev server (the first admin ends open
 * local development), so it runs in its own project after every device project
 * (playwright.config.ts), once.
 */
test('the first admin turns sign-in on; signing out and in again lands on two-factor setup', async ({
  page,
}) => {
  const email = 'first-admin@example.com';
  const password = 'correct horse battery staple';

  await open(page, '/team');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account and sign in' }).click();
  // Admins must use two-factor sign-in until an admin chooses otherwise: Account first.
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByText('Set up two-factor sign-in to continue.')).toBeVisible();

  // The account menu isn't there while setup is due; sign out through /logout.
  await open(page, '/logout');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);

  // Signed out, the shell sends you to sign in, and the gateway forwards without credentials.
  await open(page, '/dashboard');
  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard/);

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('not the password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('don’t match');

  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/account$/);
});
