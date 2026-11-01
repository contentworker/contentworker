import { defineConfig, devices } from '@playwright/test';

const PORT = 5390;
const state = '.wrangler/e2e';

/**
 * Device tests: the admin in WebKit on an iPhone and an iPad, both ways up, plus a desktop, against
 * the dev server running offline (CONTENTWORKER_E2E in vite.config.ts) on a fresh database with no
 * one added, so local development is open. They check what unit tests can't: layout at each size,
 * the safe areas and touch targets. The `auth` project signs the first admin up, which turns
 * sign-in on for the server, so it runs after the others.
 */
const DEVICES = ['iphone', 'iphone-landscape', 'ipad', 'ipad-landscape', 'desktop', 'cms'];

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/warm.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'iphone', testMatch: 'shell.spec.ts', use: { ...devices['iPhone 15'] } },
    {
      name: 'iphone-landscape',
      testMatch: 'shell.spec.ts',
      use: { ...devices['iPhone 15 landscape'] },
    },
    { name: 'ipad', testMatch: 'shell.spec.ts', use: { ...devices['iPad (gen 7)'] } },
    {
      name: 'ipad-landscape',
      testMatch: 'shell.spec.ts',
      use: { ...devices['iPad Pro 11 landscape'] },
    },
    { name: 'desktop', testMatch: 'shell.spec.ts', use: { ...devices['Desktop Safari'] } },
    // The CMS screens (seeded through the same-origin gateway while sign-in is still open), with
    // the axe sweep. Desktop Chrome: the editors are review-only below lg.
    {
      name: 'cms',
      testMatch: /(cms|workflows|space-access|accessibility|contrast-settle)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'auth',
      testMatch: 'login.spec.ts',
      dependencies: DEVICES,
      // Chromium: it keeps the `Secure` session cookie on http://localhost, which WebKit drops.
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: [
      `rm -rf ${state}`,
      `wrangler d1 migrations apply contentworker --local --persist-to ${state}`,
      `CONTENTWORKER_E2E=1 PORT=${PORT} react-router dev`,
    ].join(' && '),
    url: `http://localhost:${PORT}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'ignore',
  },
});
