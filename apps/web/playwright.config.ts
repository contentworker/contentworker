import { defineConfig, devices } from '@playwright/test';
import { guestPort } from './e2e/live-guest/port';

// E2E_PORT runs a second suite beside one already on 5390 (another worktree's), with its own server.
const PORT = Number(process.env.E2E_PORT) || 5390;
const state = '.wrangler/e2e';

/**
 * Device tests: the admin in WebKit on an iPhone and an iPad, both ways up, plus a desktop, against
 * the dev server running offline (CONTENTWORKER_E2E in vite.config.ts) on a fresh database with no
 * one added, so local development is open. They check what unit tests can't: layout at each size,
 * the safe areas and touch targets. The `auth` project signs the first admin up, which turns
 * sign-in on for the server, so it runs after the others.
 */
const DEVICES = ['iphone', 'iphone-landscape', 'ipad', 'ipad-landscape', 'desktop', 'cms'];

/**
 * CI runs the suite in three jobs at once, each on its own server, named by `E2E_PART`:
 * `webkit` (the iPhone, iPad and desktop projects, then the projects that sign the first admin
 * up: `auth`, `invites` and `oauth`), `axe` (the accessibility sweep and the modal focus specs,
 * the desktop project's too) and `cms` (every other CMS spec, so a new one lands here). A fourth
 * job for the sign-in projects alone spent more on its runner's setup (checkout, install, the
 * browser's system libraries, a server start) than on its tests, so they ride at the end of
 * `webkit`, which waits for its device projects as the whole suite does. Unset, the whole suite
 * runs in order, as it does locally.
 */
const PARTS = ['webkit', 'axe', 'cms'] as const;
const PART = process.env.E2E_PART as (typeof PARTS)[number] | undefined;
if (PART && !PARTS.includes(PART)) {
  throw new Error(`E2E_PART is "${PART}"; use ${PARTS.join(', ')} or leave it unset`);
}
const AXE = /(accessibility|modal-focus)\.spec\.ts/;
// Every other project, the sign-in ones included, belongs to `webkit`.
const partOf = (project: string) =>
  project === 'cms' ? ['axe', 'cms'] : project === 'desktop' ? ['webkit', 'axe'] : ['webkit'];
// The sign-in projects turn sign-in on for the server, so each part runs them after the device
// projects it has (the ones sharing its server), never before.
const DEVICES_IN_PART = DEVICES.filter((project) => !PART || partOf(project).includes(PART));

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/warm.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // CI's runner has 4 vCPUs shared with the dev server and workerd: two browsers keep it busy
  // without starving the server. Specs stamp their own data, so they run side by side.
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'iphone',
      // The editor's action bar sits above the tab bar only on a phone: measured here too, with
      // the entry form's tabs and the entries list.
      testMatch: [
        'shell.spec.ts',
        'editor-action-bar.spec.ts',
        'entry-tabs.spec.ts',
        'entries-list-phone.spec.ts',
        'modals-phone.spec.ts',
        // The rules' diff is one column on a phone.
        'block-config-code.spec.ts',
        // The Access sheet comes from the bottom: its conflict and reload in reach.
        'role-save-conflict.spec.ts',
      ],
      use: { ...devices['iPhone 15'] },
    },
    {
      name: 'iphone-landscape',
      testMatch: 'shell.spec.ts',
      use: { ...devices['iPhone 15 landscape'] },
    },
    {
      name: 'ipad',
      // The rules' diff turns side by side at md: an iPad upright.
      testMatch: ['shell.spec.ts', 'entry-tabs.spec.ts', 'block-config-code.spec.ts'],
      use: { ...devices['iPad (gen 7)'] },
    },
    {
      name: 'ipad-landscape',
      testMatch: 'shell.spec.ts',
      use: { ...devices['iPad Pro 11 landscape'] },
    },
    {
      name: 'desktop',
      // Its modal focus specs run in the `axe` part, which evens out the parts' time.
      testMatch: PART === 'axe' ? 'modal-focus.spec.ts' : ['shell.spec.ts', 'modal-focus.spec.ts'],
      testIgnore: PART === 'webkit' ? 'modal-focus.spec.ts' : undefined,
      use: { ...devices['Desktop Safari'] },
    },
    // The CMS screens (seeded through the same-origin gateway while sign-in is still open), with
    // the axe sweep. Desktop Chrome: the editors are review-only below lg.
    {
      name: 'cms',
      testMatch:
        PART === 'axe'
          ? AXE
          : /(cms|workflows|space-access|first-space|block-patch-card|accessibility|contrast-settle|modal-focus|live-preview|canvas-editor|canvas-drag|locked-regions|entry-save-conflict|role-save-conflict|block-config-code)\.spec\.ts/,
      testIgnore: PART === 'cms' ? AXE : undefined,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'auth',
      testMatch: 'login.spec.ts',
      dependencies: DEVICES_IN_PART,
      // Chromium: it keeps the `Secure` session cookie on http://localhost, which WebKit drops.
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Invitations, once sign-in is on: someone joins from a link, and someone with an account
      // signs in and accepts. Its own people, so it runs beside `oauth`.
      name: 'invites',
      testMatch: 'invites.spec.ts',
      dependencies: ['auth'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // OAuth for MCP clients, signed in as the admin the `auth` project created.
      name: 'oauth',
      testMatch: 'oauth.spec.ts',
      dependencies: ['auth'],
      use: { ...devices['Desktop Chrome'] },
    },
  ].filter((project) => !PART || partOf(project.name).includes(PART)),
  webServer: [
    {
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
    // A customer's frontend for live preview (e2e/live-guest), listening to this admin only.
    {
      command: `LIVE_GUEST_ADMIN=http://localhost:${PORT} LIVE_GUEST_PORT=${guestPort()} vite --config e2e/live-guest/vite.config.ts`,
      url: `http://localhost:${guestPort()}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'ignore',
    },
  ],
});
