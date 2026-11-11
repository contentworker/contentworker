import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, expect, type TestInfo, test } from '@playwright/test';
import { EDITOR_READY, MGMT, openCms, SPACE, useCmsScope } from './cms';
import { guestPort } from './live-guest/port';
import { settle } from './settle';

/**
 * A restricted person in the entry form, once sign-in is on: their role writes listings, reads but
 * may not change a listing's price, and may not read its internal notes (required, and set). They
 * join from an invitation, open a listing, see the price read-only with its reason and no notes at
 * all, change the title and save; the price and the notes keep what they held. The setup goes
 * through the deployment's admin and MCP tokens, as `invites.spec.ts` does.
 */

const ADMIN = { Authorization: 'Bearer dev-admin-token', 'content-type': 'application/json' };
const MCP = { Authorization: 'Bearer dev-mcp-token' };
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const GUEST = `http://localhost:${guestPort()}`;

async function admin(
  request: APIRequestContext,
  method: 'GET' | 'POST',
  path: string,
  data?: unknown,
) {
  return request.fetch(path, { method, headers: ADMIN, ...(data === undefined ? {} : { data }) });
}

/** One MCP tool call over HTTP, answered as JSON or as one server-sent event. */
async function tool(request: APIRequestContext, name: string, args: Record<string, unknown>) {
  const res = await request.post('/mcp', {
    headers: { ...MCP, accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
  expect(res.ok(), `${name}: ${res.status()}`).toBe(true);
  const text = await res.text();
  const json = text.startsWith('{') ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? '');
  const result = JSON.parse(json).result as { content: { text: string }[]; isError?: boolean };
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  return JSON.parse(result.content[0]!.text);
}

async function scan(page: import('@playwright/test').Page, testInfo: TestInfo) {
  await settle(page);
  const results = await new AxeBuilder({ page }).withTags(WCAG).include('#main').analyze();
  await testInfo.attach('axe', { body: JSON.stringify(results.violations, null, 2) });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(', ')}`),
  ).toEqual([]);
}

test('a person whose role makes a field read-only and hides another edits what they may and saves', async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  // Its own people and entries, whatever runs beside it.
  const stamp = `${Date.now()}-${testInfo.parallelIndex}-${testInfo.repeatEachIndex}`;
  // The e2e space (the CMS projects made it while sign-in was open; make sure).
  await admin(request, 'POST', '/spaces', { spaceId: SPACE, name: 'E2E', defaultLocale: 'en-US' });
  const type = await admin(request, 'POST', `${MGMT}/content-types`, {
    apiId: 'listing',
    name: 'Listing',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
      {
        apiId: 'price',
        name: 'Price',
        type: 'Number',
        localized: false,
        required: true,
        position: 1,
      },
      {
        apiId: 'notes',
        name: 'Internal notes',
        type: 'Text',
        localized: false,
        required: true,
        position: 2,
      },
    ],
  });
  expect([200, 201, 409], await type.text()).toContain(type.status());
  await admin(request, 'POST', `${MGMT}/content-types/listing/published`);
  const created = await admin(request, 'POST', `${MGMT}/entries`, {
    contentTypeApiId: 'listing',
    fields: {
      title: { 'en-US': `Loft ${stamp}` },
      price: { 'en-US': 450000 },
      notes: { 'en-US': 'The owner will take less' },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const id = ((await created.json()) as { entry: { id: string } }).entry.id;
  // A page laid out on the canvas (framed by the guest site), whose blocks field the role reads
  // but may not change.
  const pageType = await admin(request, 'POST', `${MGMT}/content-types`, {
    apiId: 'ruledPage',
    name: 'Ruled page',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: false,
        position: 0,
      },
      {
        apiId: 'body',
        name: 'Main',
        type: 'Array',
        localized: false,
        required: false,
        position: 1,
        items: {
          type: 'Component',
          variants: [
            {
              apiId: 'hero',
              name: 'Hero',
              fields: [
                {
                  apiId: 'heading',
                  name: 'Heading',
                  type: 'Symbol',
                  localized: false,
                  required: false,
                  position: 0,
                },
              ],
            },
          ],
        },
      },
    ],
    preview: {
      urlTemplate: `${GUEST}/?entry={id}&type=ruledPage&space={space}&env={environment}#token={token}`,
    },
  });
  expect([200, 201, 409], await pageType.text()).toContain(pageType.status());
  await admin(request, 'POST', `${MGMT}/content-types/ruledPage/published`);
  const laidOut = await admin(request, 'POST', `${MGMT}/entries`, {
    contentTypeApiId: 'ruledPage',
    fields: {
      title: { 'en-US': `Launch ${stamp}` },
      body: { 'en-US': [{ _type: 'hero', _key: 'h1', heading: 'Welcome' }] },
    },
  });
  expect(laidOut.ok(), await laidOut.text()).toBe(true);
  const pageId = ((await laidOut.json()) as { entry: { id: string } }).entry.id;
  const role = await admin(request, 'POST', `/spaces/${SPACE}/roles`, {
    name: `Listing writer ${stamp}`,
    scopes: ['content:write', 'preview:read'],
    contentGrants: [
      {
        contentTypeApiId: 'listing',
        actions: ['read', 'write'],
        deniedFields: ['notes'],
        readOnlyFields: ['price'],
      },
      { contentTypeApiId: 'ruledPage', actions: ['read', 'write'], readOnlyFields: ['body'] },
    ],
  });
  expect(role.ok(), await role.text()).toBe(true);
  const roleId = ((await role.json()) as { id: string }).id;

  // ── They join with that role ──
  const email = `listing-writer-${stamp}@example.com`;
  const invited = (await tool(request, 'invite_create', {
    email,
    grants: [{ space: SPACE, role: roleId }],
  })) as { token: string };
  const context = await browser.newContext();
  const page = await context.newPage();
  await useCmsScope(page);
  await page.goto(`/invite/${invited.token}`);
  await page.getByLabel('Name').fill('Listing writer');
  await page.getByLabel('Password', { exact: true }).fill('a long and memorable passphrase');
  await page.getByRole('button', { name: 'Create account and join' }).click();
  await expect(page).toHaveURL(/\/account\?welcome=1$/);

  // ── The listing, as their role sees it ──
  await openCms(page, `/content/listing/${id}`);
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible(EDITOR_READY);
  const price = page.getByLabel('Price');
  await expect(price).toHaveValue('450000');
  await expect(price).toHaveAttribute('readonly', '');
  await expect(price).toHaveAttribute('aria-readonly', 'true');
  // Still in the tab order, its reason read on focus.
  await expect(price).toHaveAccessibleDescription('Your role can’t change this field');
  // Drawn read-only, apart from the editable title: no fill, a dashed edge.
  await expect(price).toHaveCSS('border-top-style', 'dashed');
  await expect(price).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.getByLabel('Title')).not.toHaveCSS('border-top-style', 'dashed');
  // Focused, it keeps the dashed edge in the ring's colour.
  const edge = () => price.evaluate((el) => getComputedStyle(el).borderTopColor);
  const resting = await edge();
  await price.focus();
  await expect(price).toHaveCSS('border-top-style', 'dashed');
  expect(await edge()).not.toBe(resting);
  await price.blur();
  await expect(page.getByText('Internal notes')).toHaveCount(0);
  await scan(page, testInfo);

  // ── An edit to the title saves; the price and the notes keep what they held ──
  await page.getByLabel('Title').fill(`Loft ${stamp}, renovated`);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft updated')).toBeVisible();
  await expect(page.getByText(/needs attention|need attention|is required/)).toHaveCount(0);

  const stored = await admin(request, 'GET', `${MGMT}/entries/${id}`);
  expect(stored.ok(), await stored.text()).toBe(true);
  expect(((await stored.json()) as { fields: unknown }).fields).toEqual({
    title: { 'en-US': `Loft ${stamp}, renovated` },
    price: { 'en-US': 450000 },
    notes: { 'en-US': 'The owner will take less' },
  });

  // ── The canvas over a blocks field the role can't change: review, and the way to the form ──
  await openCms(page, `/content/ruledPage/${pageId}/canvas`);
  await expect(
    page.getByText('Your role can’t change Main: the canvas is for review here.', { exact: false }),
  ).toBeVisible(EDITOR_READY);
  await expect(page.getByRole('link', { name: 'the form' })).toHaveAttribute(
    'href',
    `/content/ruledPage/${pageId}`,
  );
  await expect(page.getByRole('button', { name: 'Save draft' })).toHaveCount(0);
  const site = page
    .frameLocator('iframe[title="Site preview"]')
    .frameLocator('iframe[title="The entry on your site"]');
  await expect(site.getByRole('heading', { level: 1 })).toHaveText(`Launch ${stamp}`, {
    timeout: 15_000,
  });
  await scan(page, testInfo);
  await context.close();
});
