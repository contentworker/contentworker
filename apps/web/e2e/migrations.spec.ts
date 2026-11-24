import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route, type TestInfo, test } from '@playwright/test';
import { openCms, seedCms, useCmsScope } from './cms';
import { settle } from './settle';

/**
 * The Migrations screens end to end: the list, a new run created through the real API (its 422 on
 * a loopback source said beside the field), then the run's steps. The e2e server is offline, so no
 * source site can be read: the run's own reads and steps are stubbed at the API boundary in the
 * browser, starting from the real run, and play a small site of 25 pages that first can't be read
 * (503 `site_unavailable`) and then loses one race (409, retryable) before going through.
 */

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.beforeAll(async ({ request }) => {
  await seedCms(request);
});

test.beforeEach(async ({ page }) => {
  await useCmsScope(page);
});

async function scan(page: Page, testInfo: TestInfo) {
  await settle(page);
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  if (results.violations.length > 0) {
    await testInfo.attach('axe-violations.json', {
      body: JSON.stringify(results.violations, null, 2),
      contentType: 'application/json',
    });
  }
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

interface FakePage {
  id: string;
  url: string;
  path: string;
  stage: string;
  templateId: string | null;
  title: string | null;
  httpStatus: number | null;
  html: { sha256: string; bytes: number } | null;
  error: string | null;
}

/**
 * Serves every read and step of one run (`/migrations/runs/<id>…`) from the browser: the run as
 * the API made it, then this script's site. Creating and listing runs stay real.
 */
async function stubRun(page: Page) {
  const calls = { inventory: 0, fetch: 0, approve: 0, publish: 0 };
  let run: Record<string, unknown> | null = null;
  const pages: FakePage[] = [];
  let templates: Record<string, unknown>[] = [];
  const view = () => {
    const byStage: Record<string, number> = {};
    for (const p of pages) byStage[p.stage] = (byStage[p.stage] ?? 0) + 1;
    return {
      run,
      pages: {
        total: pages.length,
        fetched: pages.filter((p) => p.html).length,
        failed: pages.filter((p) => p.error).length,
        byStage,
      },
      templates,
    };
  };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  // The list is read from the real API, where this run never moved past created (its steps are
  // stubbed below): swap in the stubbed run so the list shows the state the steps left it in.
  await page.route(/\/migrations\/runs(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET' || !run) return route.fallback();
    const body = (await (await route.fetch()).json()) as { items: Record<string, unknown>[] };
    const stubbed = run;
    return json(route, {
      ...body,
      items: body.items.map((r) => (r.id === stubbed.id ? { ...r, ...stubbed } : r)),
    });
  });

  await page.route(
    /\/migrations\/runs\/[^/?]+(\/(inventory|fetch|cluster|pages))?(\?.*)?$/,
    async (route) => {
      const url = new URL(route.request().url());
      const step = /\/runs\/[^/]+\/(\w+)$/.exec(url.pathname)?.[1];
      if (!run)
        run = ((await (await route.fetch()).json()) as { run: Record<string, unknown> }).run;
      const now = new Date().toISOString();
      if (step === 'inventory') {
        if (++calls.inventory === 1) {
          return json(
            route,
            {
              error: {
                code: 'site_unavailable',
                message: 'The site can’t be read now: robots.txt answered 503',
                retryable: true,
              },
            },
            503,
          );
        }
        for (let i = 0; i < 25; i++) {
          pages.push({
            id: `0199a000-0000-7000-8000-${String(i).padStart(12, '0')}`,
            url: `https://www.example.com/${i < 20 ? 'blog' : 'about'}/page-${i}`,
            path: `/${i < 20 ? 'blog' : 'about'}/page-${i}`,
            stage: 'discovered',
            templateId: null,
            title: `Page ${i}`,
            httpStatus: null,
            html: null,
            error: null,
          });
        }
        run = {
          ...run,
          status: 'inventoried',
          inventory: {
            discovered: 28,
            added: 25,
            skipped: { robots: 2, filtered: 1, offOrigin: 0, overLimit: 0, invalid: 0 },
            warnings: [],
          },
          updatedAt: now,
        };
        return json(route, run);
      }
      if (step === 'fetch') {
        // Another step wrote the run first: the screen sends it again without a word.
        if (++calls.fetch === 2) {
          return json(
            route,
            { error: { code: 'conflict', message: 'The run changed', retryable: true } },
            409,
          );
        }
        const limit = (route.request().postDataJSON() as { limit?: number }).limit ?? 10;
        const batch = pages.filter((p) => !p.html && !p.error).slice(0, limit);
        for (const p of batch) {
          if (p.path === '/about/page-24')
            Object.assign(p, { httpStatus: 404, error: 'answered 404' });
          else Object.assign(p, { httpStatus: 200, html: { sha256: 'ab12', bytes: 4096 } });
        }
        const failed = batch.filter((p) => p.error).length;
        return json(route, {
          fetched: batch.length - failed,
          failed,
          added: 0,
          more: pages.some((p) => !p.html && !p.error),
        });
      }
      if (step === 'cluster') {
        const template = (id: string, label: string, ids: string[]) => ({
          id,
          runId: run?.id,
          label,
          status: 'pending',
          pageCount: ids.length,
          samplePageIds: [ids[0], ids[Math.floor(ids.length / 3)]].filter(Boolean),
          contentTypeId: null,
          script: null,
          proposal: null,
          lastTry: null,
          approvedBy: null,
          reviewDigest: 'a'.repeat(64),
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
        const fetched = pages.filter((p) => p.html);
        const blog = fetched.filter((p) => p.path.startsWith('/blog/'));
        const about = fetched.filter((p) => p.path.startsWith('/about/'));
        templates = [
          template(
            'tpl-blog',
            'Blog post',
            blog.map((p) => p.id),
          ),
          template(
            'tpl-about',
            'About page',
            about.map((p) => p.id),
          ),
        ];
        for (const p of blog) Object.assign(p, { stage: 'clustered', templateId: 'tpl-blog' });
        for (const p of about) Object.assign(p, { stage: 'clustered', templateId: 'tpl-about' });
        run = { ...run, status: 'clustered', updatedAt: now };
        return json(route, view());
      }
      if (step === 'pages') {
        const stage = url.searchParams.get('stage');
        const tpl = url.searchParams.get('template');
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const cursor = url.searchParams.get('cursor');
        const all = pages.filter(
          (p) => (!stage || p.stage === stage) && (!tpl || p.templateId === tpl),
        );
        const from = cursor ? all.findIndex((p) => p.id === cursor) + 1 : 0;
        const items = all.slice(from, from + limit).map((p) => ({
          ...p,
          runId: run?.id,
          depth: 0,
          lastModified: null,
          output: null,
          outputScript: null,
          score: null,
          entryId: null,
          unresolvedLinks: 0,
          createdAt: now,
          updatedAt: now,
        }));
        const last = items.at(-1);
        return json(
          route,
          from + items.length < all.length && last ? { items, nextCursor: last.id } : { items },
        );
      }
      return json(route, view());
    },
  );
  // A template's authoring, approval and loading, and the run's last steps. The first approval
  // finds the template changed under the reviewer (409), as another author's save would make it.
  let script = '';
  let digests = 0;
  await page.route(
    /\/migrations\/runs\/[^/?]+\/(templates\/[^?]+|relink|redirects|publish)(\?.*)?$/,
    async (route) => {
      const url = new URL(route.request().url());
      const [, , step] = /\/runs\/[^/]+\/(templates\/[^/]+\/?)?(\w*)$/.exec(url.pathname) ?? [];
      const id = /templates\/([^/]+)/.exec(url.pathname)?.[1];
      const method = route.request().method();
      const body = (method === 'GET' ? {} : (route.request().postDataJSON() ?? {})) as {
        model?: unknown;
        script?: string;
        reviewed?: string;
      };
      const t = templates.find((x) => x.id === id);
      const write = (change: Record<string, unknown>, authored = true) => {
        Object.assign(t ?? {}, change);
        if (authored && t) t.reviewDigest = String(++digests).repeat(64).slice(0, 64);
      };
      const mine = (stage: string) => pages.filter((p) => p.templateId === id && p.stage === stage);
      switch (step) {
        case '':
          return json(route, t);
        case 'proposal':
          write({ proposal: body.model, status: 'authoring' });
          return json(route, t);
        case 'script':
          if (method === 'PUT') {
            script = body.script ?? '';
            write({ script: { sha256: 'feed', bytes: 120 }, status: 'authoring' });
            return json(route, t);
          }
          return json(route, { script, sha256: 'feed' });
        case 'try': {
          const summary = {
            at: new Date().toISOString(),
            scriptSha256: 'feed',
            pages: 1,
            ok: 1,
            passed: 1,
            meanScore: 0.94,
            problems: [],
          };
          write({ lastTry: summary }, false);
          const text = (value: string) => ({
            nodeType: 'document',
            content: [{ nodeType: 'paragraph', content: [{ nodeType: 'text', value }] }],
          });
          return json(route, {
            summary,
            results: [
              {
                pageId: pages[0]?.id,
                url: pages[0]?.url,
                ok: true,
                score: {
                  overall: 0.94,
                  textCoverage: 0.98,
                  imagesMissing: 0,
                  imagesLost: 0,
                  sourceLinks: 0,
                  outputLinks: 0,
                  issues: [],
                },
                output: {
                  fields: { title: '<b>Page 0</b>' },
                  blocks: [{ variant: 'text', fields: { content: text('A migrated paragraph') } }],
                  assets: [],
                  links: [],
                },
                issues: [],
                logs: ['<img src=x onerror=alert(1)>'],
              },
            ],
          });
        }
        case 'approve':
          if (++calls.approve === 1) {
            write({});
            return json(route, { error: { code: 'conflict', message: 'It changed' } }, 409);
          }
          if (body.reviewed !== t?.reviewDigest) return json(route, {}, 409);
          write({ status: 'approved', contentTypeId: 'page' }, false);
          return json(route, { template: t, signalled: false, reason: 'no-driver' });
        case 'reopen':
          if (body.reviewed !== t?.reviewDigest) return json(route, {}, 409);
          write({ status: 'authoring', approvedBy: null }, false);
          return json(route, t);
        case 'transform': {
          const batch = mine('clustered').slice(0, 10);
          for (const p of batch) p.stage = 'validated';
          const more = mine('clustered').length > 0;
          return json(route, {
            transformed: batch.length,
            validated: batch.length,
            needsFix: 0,
            failed: [],
            more,
            ...(more ? { next: batch.at(-1)?.id } : {}),
          });
        }
        case 'load': {
          const batch = mine('validated').slice(0, 10);
          for (const p of batch) p.stage = 'loaded';
          return json(route, {
            loaded: batch.length,
            failed: [],
            assetFailures: [],
            unresolvedLinks: 0,
            deferred: [],
            stale: 0,
            more: mine('validated').length > 0,
          });
        }
        case 'relink':
          return json(route, { checked: 20, relinked: 4, unresolvedLinks: 0, skipped: [] });
        case 'redirects':
          return json(route, {
            created: 18,
            updated: 0,
            unchanged: 0,
            skipped: { identity: 2, noUrlPattern: 0, unresolved: 0 },
            chains: [],
          });
        default: {
          calls.publish++;
          const batch = pages.filter((p) => p.stage === 'loaded');
          for (const p of batch) p.stage = 'published';
          return json(route, { published: batch.length, added: 0, failed: [] });
        }
      }
    },
  );
  return calls;
}

test('a website migration: list, a new run, and its steps', async ({ page }, testInfo) => {
  const stamp = Date.now();
  const calls = await stubRun(page);
  await openCms(page, '/migrations');
  await expect(page.getByRole('heading', { level: 1, name: 'Migrations' })).toBeVisible();
  // The nav offers it to this role (a deployment admin: migration:run comes with space:admin).
  await expect(
    page
      .getByRole('navigation', { name: 'Main' })
      .first()
      .getByRole('link', { name: 'Migrations' }),
  ).toBeAttached();

  // A loopback source is the API's to refuse, beside the field it names, with focus there.
  await page.getByRole('button', { name: 'New migration' }).click();
  const sheet = page.getByRole('dialog', { name: 'Migrate a website' });
  const url = sheet.getByLabel('Sitemap or site URL');
  await url.fill('http://localhost:8787/sitemap.xml');
  await sheet.getByLabel('Name').fill(`E2E site ${stamp}`);
  await sheet.getByRole('button', { name: 'Create run' }).click();
  await expect(
    sheet.getByText(/must not target a loopback, link-local, or private address/),
  ).toBeVisible();
  await expect(url).toHaveAttribute('aria-invalid', 'true');
  await expect(url).toBeFocused();
  await scan(page, testInfo);

  await url.fill('https://www.example.com/sitemap.xml');
  await sheet.getByRole('button', { name: 'Create run' }).click();
  await expect(page).toHaveURL(/\/migrations\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { level: 1, name: `E2E site ${stamp}` })).toBeVisible();
  const steps = page.getByRole('list', { name: 'Steps' });
  await expect(steps.getByRole('button', { name: 'Fetch pages' })).toBeDisabled();
  await expect(steps.getByText('Inventory the source first.').first()).toBeVisible();

  // The site can't be read yet: a calm notice, and Try again goes through.
  await steps.getByRole('button', { name: 'Inventory' }).click();
  const notice = page.getByRole('alert').filter({ hasText: 'The site can’t be read right now' });
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Try again' }).click();
  await expect(notice).toBeHidden();
  await expect(steps.getByText('Found 28, added 25')).toBeVisible();
  const fetchAll = steps.getByRole('button', { name: 'Fetch until done' });
  await expect(fetchAll).toBeFocused();
  expect(calls.inventory).toBe(2);

  // Fetch until done asks while the API says more; the lost race is sent again quietly.
  await fetchAll.press('Enter');
  await expect(page.getByText('Fetched 24 pages; 1 failed. No pages are waiting.')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(steps.getByRole('button', { name: 'Cluster' })).toBeFocused();
  expect(calls.fetch).toBe(4);

  await page.keyboard.press('Enter');
  const templates = page.getByRole('list', { name: 'Templates' });
  await expect(templates.getByText('Blog post')).toBeVisible();
  await expect(page.getByText('Grouped 24 pages into 2 templates.')).toBeVisible();
  await expect(page.locator('#templates h2 [tabindex="-1"]')).toBeFocused();

  // A template narrows the pages to its own; the failed page says what the site answered.
  await templates.getByRole('button', { name: 'Show pages of About page' }).click();
  const table = page.getByRole('table', { name: 'Pages' });
  await expect(page.getByLabel('Template', { exact: true })).toHaveValue('tpl-about');
  await expect(
    table.getByRole('link', { name: '/about/page-20 (opens in a new tab)' }),
  ).toHaveAttribute('href', 'https://www.example.com/about/page-20');
  await expect(table.getByRole('link', { name: /^\/blog\// })).toHaveCount(0);
  await page.getByLabel('Template', { exact: true }).selectOption('');
  await page.getByLabel('Stage', { exact: true }).selectOption('discovered');
  const failedRow = table.getByRole('row').filter({ hasText: '/about/page-24' });
  await expect(failedRow.getByText('answered 404')).toBeVisible();
  await expect(failedRow.getByText('Failed')).toBeVisible();
  await page.getByLabel('Stage', { exact: true }).selectOption('');
  await scan(page, testInfo);

  // A template's review: its model and script, written here, then tried on a sample page.
  await templates.getByRole('link', { name: 'Blog post' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Blog post' })).toBeVisible();
  await page.getByRole('button', { name: 'Write model' }).click();
  await page.getByRole('button', { name: 'Propose model' }).click();
  await expect(page.getByRole('list', { name: 'Blocks of Body' })).toBeVisible();
  await page.getByRole('button', { name: 'Write script' }).click();
  await scan(page, testInfo);
  await page.getByRole('button', { name: 'Save script' }).click();
  await expect(page.getByRole('textbox', { name: 'Import script' })).toContainText('transform');
  await page.getByRole('button', { name: 'Try on sample pages' }).click();
  await expect(page.getByText('Tried 1 sample page: 1 passed, mean score 0.94.')).toBeVisible();
  await page.getByRole('button', { name: /^Show output of/ }).click();
  await expect(page.getByText('A migrated paragraph')).toBeVisible();
  await expect(page.getByText('<b>Page 0</b>')).toBeVisible();
  await expect(page.getByText('<img src=x onerror=alert(1)>')).toBeVisible();
  await scan(page, testInfo);

  // Approving: confirmed on the page, refused over a version nobody read, then at the new one.
  await page.getByRole('button', { name: 'Approve…' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('publishes the content type Page');
  await page.getByRole('button', { name: 'Approve template' }).click();
  await expect(page.getByText('This template changed since you read it')).toBeVisible();
  await page.getByRole('button', { name: 'I’ve read this version' }).click();
  await page.getByRole('button', { name: 'Approve…' }).click();
  await scan(page, testInfo);
  await page.getByRole('button', { name: 'Approve template' }).click();
  await expect(page.getByText(/^Approved\. Nothing is running this/)).toBeVisible();
  expect(calls.approve).toBe(2);
  await expect(page.getByRole('button', { name: 'Edit script' })).toHaveCount(0);

  // Reopened for changes, confirmed on the page, edited under the same API ID and approved again.
  await page.getByRole('button', { name: 'Reopen for changes…' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('stay as they are');
  await scan(page, testInfo);
  await page.getByRole('button', { name: 'Reopen template' }).click();
  const reopened = page.getByText('Reopened. Edit its model or script above');
  await expect(reopened).toBeFocused();
  await page.getByRole('button', { name: 'Edit model' }).click();
  const model = page.getByLabel('Content model as JSON');
  const text = await model.inputValue();
  await model.fill(text.replace('"apiId": "page"', '"apiId": "story"'));
  await page.getByRole('button', { name: 'Propose model' }).click();
  await expect(page.getByText(/apiId: must stay “page”/)).toBeVisible();
  await model.fill(text);
  await page.getByRole('button', { name: 'Propose model' }).click();
  await scan(page, testInfo);
  await page.getByRole('button', { name: 'Approve…' }).click();
  await page.getByRole('button', { name: 'Approve template' }).click();
  await expect(page.getByText(/^Approved\. Nothing is running this/)).toBeVisible();

  await page.getByRole('button', { name: 'Transform until done' }).click();
  await expect(page.getByText('Transformed 20 pages: 20 validated, 0 need a fix.')).toBeVisible();
  await page.getByRole('button', { name: 'Load until done' }).click();
  await expect(page.getByText('Loaded 20 pages.')).toBeVisible();

  // Back on the run: its links, its redirects, and publishing, which only its own answer starts.
  await page
    .getByRole('link', { name: `E2E site ${stamp}` })
    .last()
    .click();
  await page.getByRole('button', { name: 'Relink' }).click();
  await expect(page.getByText(/^Relinked 4 entries of 20 read/)).toBeVisible();
  await page.getByRole('button', { name: 'Write redirects' }).click();
  await expect(page.getByText(/2 skipped: the path didn’t move/)).toBeVisible();
  await page.getByRole('button', { name: 'Publish…', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Not now' })).toBeFocused();
  expect(calls.publish).toBe(0);
  await scan(page, testInfo);
  await page.getByRole('button', { name: 'Publish 20 entries' }).click();
  await expect(page.getByText('Published 20 entries.')).toBeVisible();
  expect(calls.publish).toBe(1);

  // Back on the list, the run is there with its pages by stage.
  await page
    .getByRole('navigation', { name: 'Main' })
    .first()
    .getByRole('link', { name: 'Migrations' })
    .click();
  const row = page.getByRole('listitem').filter({ hasText: `E2E site ${stamp}` });
  await expect(row.getByText('https://www.example.com/sitemap.xml')).toBeVisible();
  await expect(row.getByText('Clustered', { exact: true }).first()).toBeVisible();
});
