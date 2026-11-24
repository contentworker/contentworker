import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  type MigrationLoadResult,
  type MigrationPublishResult,
  type MigrationTemplateView,
  type MigrationTransformResult,
} from '~/cms/lib/management';

/*
 * A template's review page, and the run's last steps, against a fake of their endpoints: each
 * action's answer, refusal, 409, 501 and loop, who is offered what, and that the source site's
 * words stay words.
 */

const T0 = '2026-11-20T10:00:00.000Z';
const EVIL = '<img src=x onerror="window.pwned=1">';
const digest = (c: string) => c.repeat(64);
const MODEL = {
  apiId: 'post',
  name: 'Post',
  displayField: 'title',
  urlPattern: '/blog/{slug}',
  fields: [
    {
      apiId: 'title',
      name: 'Title',
      type: 'Symbol',
      required: true,
      localized: false,
      position: 0,
    },
    {
      apiId: 'body',
      name: 'Body',
      type: 'Array',
      required: false,
      localized: false,
      position: 1,
      items: {
        type: 'Component',
        variants: [
          {
            apiId: 'text',
            name: 'Text block',
            fields: [
              {
                apiId: 'content',
                name: 'Content',
                type: 'RichText',
                required: false,
                localized: false,
                position: 0,
              },
            ],
          },
        ],
      },
    },
  ],
};

let template: MigrationTemplateView;
let loaded: number;
let status: string;
const authored = (over: Partial<MigrationTemplateView> = {}): MigrationTemplateView => ({
  id: 't1',
  runId: 'run-1',
  label: 'Blog post',
  status: 'authoring',
  pageCount: 24,
  samplePageIds: ['p1'],
  contentTypeId: null,
  script: { sha256: 'sha-1', bytes: 40 },
  proposal: MODEL as never,
  lastTry: null,
  approvedBy: null,
  reviewDigest: digest('a'),
  version: 1,
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

const refusal = (code: number, name: string, message: string, extra = {}) =>
  new ApiError(code, `POST … → ${code}`, { error: { code: name, message, ...extra } });
const conflict = () => refusal(409, 'conflict', 'lost', { retryable: true });

const client = {
  getSpaceAccess: vi.fn(),
  listContentTypes: vi.fn(async (): Promise<unknown[]> => []),
  listReleases: vi.fn(async () => [{ id: 'rel-9', title: 'Launch', status: 'open' }]),
  getMigrationRun: vi.fn(async () => ({
    run: {
      id: 'run-1',
      name: 'example.com',
      source: {
        kind: 'sitemap',
        url: 'https://example.com/sitemap.xml',
        include: [],
        exclude: [],
        maxPages: 500,
      },
      status,
      threshold: 0.8,
      inventory: null,
      error: status === 'stopped' ? 'no go-ahead came' : null,
      releaseId: null,
      version: 1,
      createdAt: T0,
      createdBy: null,
      updatedAt: T0,
    },
    pages: { total: 24, fetched: 24, failed: 0, byStage: { loaded, clustered: 24 - loaded } },
    templates: [template],
  })),
  listMigrationPages: vi.fn(async () => ({ items: [] })),
  getMigrationTemplate: vi.fn(async () => template),
  getMigrationScript: vi.fn(async () => ({
    script: `// ${EVIL}\nexport default () => 1;`,
    sha256: template.script?.sha256 ?? null,
  })),
  proposeMigrationModel: vi.fn(async (_r: string, _t: string, model: unknown) => {
    template = { ...template, proposal: model as never, reviewDigest: digest('b') };
    return template;
  }),
  setMigrationScript: vi.fn(async () => {
    template = {
      ...template,
      script: { sha256: 'sha-2', bytes: 10 },
      reviewDigest: digest('c'),
    };
    return template;
  }),
  tryMigrationScript: vi.fn(),
  approveMigrationTemplate: vi.fn(),
  transformMigrationPages: vi.fn(),
  loadMigrationPages: vi.fn(),
  relinkMigrationPages: vi.fn(),
  importMigrationRedirects: vi.fn(),
  publishMigrationPages: vi.fn(),
  startMigrationRun: vi.fn(),
  approveMigrationPublish: vi.fn(),
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    client,
    conn: { space: 's', environment: 'main', locale: 'en-US' },
    ready: true,
  }),
  useOptionalClient: () => undefined,
}));
vi.mock('~/cms/components/block-config/code-views', () => ({
  TextView: ({ text, label }: { text: string; label: string }) => (
    <textarea aria-label={label} readOnly value={text} />
  ),
}));

const { ToastProvider } = await import('~/cms/lib/toast');
const { MigrationTemplatePage } = await import('~/cms/routes/MigrationTemplate');
const { MigrationRunPage } = await import('~/cms/routes/MigrationRun');

const ALL = ['migration:run', 'content:manage', 'content:write', 'assets:write', 'content:publish'];
beforeEach(() => {
  template = authored();
  loaded = 0;
  status = 'clustered';
  client.getSpaceAccess.mockResolvedValue({ scopes: ALL, subject: 'me' });
});
afterEach(() => {
  for (const fn of Object.values(client)) fn.mockClear();
  for (const name of [
    'tryMigrationScript',
    'approveMigrationTemplate',
    'transformMigrationPages',
    'loadMigrationPages',
    'relinkMigrationPages',
    'importMigrationRedirects',
    'publishMigrationPages',
    'startMigrationRun',
    'approveMigrationPublish',
  ] as const) {
    client[name].mockReset();
  }
});

function open(path = '/migrations/run-1/templates/t1') {
  const router = createMemoryRouter(
    [
      { path: '/migrations/:runId/templates/:templateId', element: <MigrationTemplatePage /> },
      { path: '/migrations/:runId', element: <MigrationRunPage /> },
    ],
    { initialEntries: [path] },
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { qc, router };
}
const press = async (name: string | RegExp) =>
  fireEvent.click(await screen.findByRole('button', { name }));

describe('reviewing a template', () => {
  it('shows its model as a list and its script as text, never anything run', async () => {
    template = authored({
      label: EVIL,
      proposal: { ...MODEL, name: EVIL } as never,
      lastTry: {
        at: T0,
        scriptSha256: 'sha-0',
        pages: 3,
        ok: 2,
        passed: 1,
        meanScore: 0.71,
        problems: [EVIL],
      },
    });
    open();
    expect(await screen.findByRole('heading', { level: 1, name: EVIL })).toBeTruthy();
    const fields = screen.getByRole('list', { name: 'Fields' });
    expect(within(fields).getByText('Symbol · Required')).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'Blocks of Body' })).getByText('Text block'),
    ).toBeTruthy();
    expect(screen.getByText('/blog/{slug}')).toBeTruthy();
    expect((await screen.findByDisplayValue(/export default/)).textContent).toContain(EVIL);
    expect(screen.getByText('sha-1')).toBeTruthy();
    expect(screen.getByText('That was an earlier script. Try this one.')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Problems found' }).textContent).toBe(EVIL);
    expect(document.querySelector('img')).toBeNull();
  });

  it('proposes a model as JSON, saying what isn’t JSON and what the API refuses', async () => {
    open();
    await press('Edit model');
    const box = await screen.findByLabelText('Content model as JSON');
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: '{' } });
    await press('Propose model');
    expect((await screen.findByRole('alert')).textContent).toMatch(/isn’t valid JSON/);
    expect(client.proposeMigrationModel).not.toHaveBeenCalled();
    client.proposeMigrationModel.mockRejectedValueOnce(
      new ApiError(422, 'POST … → 422', {
        error: {
          code: 'validation_failed',
          message: 'x',
          issues: [{ field: 'urlPattern', message: 'is needed' }],
        },
      }),
    );
    fireEvent.change(box, { target: { value: '{"apiId":"x"}' } });
    await press('Propose model');
    expect((await screen.findByRole('alert')).textContent).toBe('urlPattern: is needed');
    fireEvent.change(box, { target: { value: JSON.stringify({ ...MODEL, name: 'Article' }) } });
    await press('Propose model');
    expect(await screen.findByText('Article')).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit model' })),
    );
    // Their own save is read as they wrote it: nothing to review again.
    expect(screen.queryByText('This template changed since you read it')).toBeNull();
  });

  it('holds a script to 256 KiB, asks before dropping an edit, and saves one', async () => {
    open();
    await press('Edit script');
    const box = await screen.findByLabelText('Import script');
    fireEvent.change(box, { target: { value: 'é'.repeat(140_000) } });
    expect(screen.queryByRole('alert')).toBeNull();
    await press('Save script');
    expect(screen.getByRole('alert').textContent).toMatch(/274 KiB.*at most 256 KiB/);
    expect(client.setMigrationScript).not.toHaveBeenCalled();
    await press('Cancel');
    expect(await screen.findByRole('alertdialog', { name: 'Discard this edit?' })).toBeTruthy();
    await press('Keep editing');
    // Approving takes the stored version, so an open edit holds it.
    expect(screen.getAllByText(/Save or discard the edit first/).length).toBeGreaterThan(0);
    fireEvent.change(box, { target: { value: 'export default () => 2;' } });
    await press('Save script');
    await waitFor(() =>
      expect(client.setMigrationScript).toHaveBeenCalledWith(
        'run-1',
        't1',
        'export default () => 2;',
      ),
    );
    expect(await screen.findByText('sha-2')).toBeTruthy();
  });

  it('asks before leaving with an edit', async () => {
    const { router } = open();
    await press('Edit script');
    fireEvent.change(await screen.findByLabelText('Import script'), { target: { value: 'x' } });
    await router.navigate('/migrations/run-1');
    expect(await screen.findByText(/Leave without saving it/)).toBeTruthy();
    await press('Stay');
    expect(router.state.location.pathname).toContain('/templates/');
  });

  it('locks an approved template, saying why', async () => {
    template = authored({ status: 'approved', contentTypeId: 'post' });
    open();
    expect(
      await screen.findByText(/is approved, so its model and script are settled/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit model' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit script' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Open its content type' }).getAttribute('href')).toBe(
      '/content/post',
    );
  });
});

describe('trying a script', () => {
  const summary = {
    at: T0,
    scriptSha256: 'sha-1',
    pages: 1,
    ok: 1,
    passed: 1,
    meanScore: 0.93,
    problems: [],
  };
  it('draws its output with the rich text renderer and everything else as words', async () => {
    client.tryMigrationScript.mockResolvedValue({
      summary,
      results: [
        {
          pageId: 'p1',
          url: 'https://example.com/blog/a',
          ok: true,
          score: {
            overall: 0.93,
            textCoverage: 0.97,
            imagesMissing: 0,
            imagesLost: 0,
            sourceLinks: 1,
            outputLinks: 1,
            issues: [],
          },
          issues: [],
          logs: [EVIL],
          output: {
            fields: {
              title: EVIL,
              // A document no save would take: its words, never its link.
              bad: {
                nodeType: 'document',
                content: [
                  {
                    nodeType: 'paragraph',
                    content: [
                      {
                        nodeType: 'hyperlink',
                        data: { uri: 'javascript:alert(1)' },
                        content: [{ nodeType: 'text', value: 'evil link' }],
                      },
                    ],
                  },
                ],
              },
            },
            blocks: [
              {
                variant: 'text',
                fields: {
                  content: {
                    nodeType: 'document',
                    content: [
                      {
                        nodeType: 'paragraph',
                        content: [
                          { nodeType: 'text', value: `${EVIL} and ` },
                          {
                            nodeType: 'hyperlink',
                            data: { uri: '/logout' },
                            content: [{ nodeType: 'text', value: 'a relative link' }],
                          },
                        ],
                      },
                    ],
                  },
                },
              },
            ],
            assets: [{ url: 'javascript:alert(2)' }],
            links: [],
          },
        },
      ],
    });
    open();
    await press('Try on sample pages');
    expect(await screen.findByText('Tried 1 sample page: 1 passed, mean score 0.93.')).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Sample pages tried' });
    expect(within(list).getByText('Passed')).toBeTruthy();
    await press(/^Show output of/);
    expect(await screen.findByText('evil link')).toBeTruthy();
    // In the document's own renderer, resolved against the page it came from.
    const link = await screen.findByRole('link', { name: 'a relative link' });
    expect(link.getAttribute('href')).toBe('https://example.com/logout');
    expect(within(screen.getByRole('list', { name: 'Script log' })).getByText(EVIL)).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.innerHTML).not.toMatch(/href="javascript:/i);
  });

  it('says a script can’t run here (501) without offering it again', async () => {
    client.tryMigrationScript.mockRejectedValue(
      refusal(501, 'not_configured', 'Running import scripts is not configured'),
    );
    open();
    await press('Try on sample pages');
    const alert = (await screen.findByText('The try didn’t finish')).closest(
      '[data-slot=alert]',
    ) as HTMLElement;
    expect(within(alert).getByText('Running import scripts is not configured')).toBeTruthy();
    expect(within(alert).queryByRole('button')).toBeNull();
  });

  it('offers a 503 again', async () => {
    client.tryMigrationScript
      .mockRejectedValueOnce(refusal(503, 'unavailable', 'Busy'))
      .mockResolvedValueOnce({ summary, results: [] });
    open();
    await press('Try on sample pages');
    await press('Try again');
    expect(await screen.findByText(/^Tried 1 sample page/)).toBeTruthy();
  });
});

describe('approving', () => {
  const approve = async () => {
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Approve…' }).getAttribute('aria-disabled'),
      ).toBeNull(),
    );
    await press('Approve…');
  };

  it('confirms on the page, naming the type, and sends the digest that was read', async () => {
    client.approveMigrationTemplate.mockImplementation(async () => {
      template = { ...template, status: 'approved', contentTypeId: 'post' };
      return { template, signalled: false, reason: 'no-driver' };
    });
    open();
    await approve();
    const ask = await screen.findByRole('alertdialog');
    expect(ask.textContent).toMatch(/creates and publishes the content type Post \(post\)/);
    expect(document.activeElement).toBe(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(client.approveMigrationTemplate).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole('button', { name: 'Approve template' }));
    expect(await screen.findByText(/Nothing is running this in the background/)).toBeTruthy();
    expect(client.approveMigrationTemplate).toHaveBeenCalledWith('run-1', 't1', digest('a'));
  });

  it('says it revises a type of this run’s, and warns of one that isn’t', async () => {
    client.listContentTypes.mockResolvedValue([{ apiId: 'post' }]);
    open();
    await approve();
    expect(await screen.findByText(/isn’t this migration’s/)).toBeTruthy();
    client.listContentTypes.mockResolvedValue([]);
  });

  it('on a 409 over a changed template, reloads it and asks for another review', async () => {
    client.approveMigrationTemplate.mockImplementationOnce(async () => {
      template = { ...template, reviewDigest: digest('f') };
      throw refusal(409, 'conflict', 'changed after it was reviewed');
    });
    open();
    await approve();
    await press('Approve template');
    expect(await screen.findByText('This template changed since you read it')).toBeTruthy();
    // It can't be approved again until it is said to be read, and then at the new digest.
    const button = screen.getByRole('button', { name: 'Approve…' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await press('I’ve read this version');
    client.approveMigrationTemplate.mockResolvedValueOnce({
      template: { ...template, status: 'approved' },
      signalled: true,
    });
    await approve();
    await press('Approve template');
    expect(await screen.findByText(/background run was told/)).toBeTruthy();
    expect(client.approveMigrationTemplate).toHaveBeenLastCalledWith('run-1', 't1', digest('f'));
  });

  it('drops a question whose template changed while it was open', async () => {
    const { qc } = open();
    await approve();
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    template = { ...template, reviewDigest: digest('e') };
    await qc.invalidateQueries();
    expect(await screen.findByText('This template changed since you read it')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(client.approveMigrationTemplate).not.toHaveBeenCalled();
  });

  it('takes “read” for the version the notice named, not one that came under it', async () => {
    const { qc } = open();
    await screen.findByRole('button', { name: 'Approve…' });
    template = { ...template, reviewDigest: digest('e') };
    await qc.invalidateQueries();
    expect(await screen.findByRole('button', { name: 'I’ve read this version' })).toBeTruthy();
    template = { ...template, reviewDigest: digest('f') };
    await qc.invalidateQueries();
    await press('Show me the newest');
    expect(screen.getByRole('button', { name: 'Approve…' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    await press('I’ve read this version');
    await approve();
    client.approveMigrationTemplate.mockRejectedValueOnce(refusal(400, 'x', 'no'));
    await press('Approve template');
    await waitFor(() =>
      expect(client.approveMigrationTemplate).toHaveBeenCalledWith('run-1', 't1', digest('f')),
    );
  });

  it('doesn’t take “read” while an editor hides the new version', async () => {
    const { qc } = open();
    await press('Edit script');
    template = { ...template, reviewDigest: digest('e') };
    await qc.invalidateQueries();
    expect(await screen.findByText(/Save or discard the edit to see the new version/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'I’ve read this version' })).toBeNull();
  });

  it('holds the question while the approval runs', async () => {
    client.approveMigrationTemplate.mockImplementation(() => new Promise(() => {}));
    open();
    await approve();
    await press('Approve template');
    await press('Cancel');
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approving…' }));
    expect(client.approveMigrationTemplate).toHaveBeenCalledTimes(1);
  });

  it('won’t approve a script it hasn’t shown', async () => {
    client.getMigrationScript.mockResolvedValueOnce({ script: 'another', sha256: 'sha-9' });
    open();
    expect(await screen.findByText('The import script on screen has to load first.')).toBeTruthy();
    expect(screen.queryByText('another')).toBeNull();
  });

  it('says any other 409 in the API’s words, and an unreachable driver can be told again', async () => {
    client.approveMigrationTemplate.mockRejectedValueOnce(
      refusal(409, 'conflict', 'A content type "post" already exists'),
    );
    open();
    await approve();
    await press('Approve template');
    expect(await screen.findByText('A content type "post" already exists')).toBeTruthy();
    client.approveMigrationTemplate.mockImplementation(async () => {
      template = { ...template, status: 'approved', contentTypeId: 'post' };
      return { template, signalled: false, reason: 'unreachable' };
    });
    await approve();
    await press('Approve template');
    await press('Tell it again');
    await waitFor(() => expect(client.approveMigrationTemplate).toHaveBeenCalledTimes(3));
  });

  it('isn’t offered without content:manage, and the reason is said once', async () => {
    client.getSpaceAccess.mockResolvedValue({ scopes: ['migration:run'], subject: 'me' });
    open();
    expect(await screen.findByText('Approving takes content:manage.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve…' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit model' })).toBeTruthy();
  });
});

describe('taking a template’s pages in', () => {
  const transformed = (over: Partial<MigrationTransformResult> = {}): MigrationTransformResult => ({
    transformed: 10,
    validated: 9,
    needsFix: 1,
    failed: [],
    more: true,
    ...over,
  });
  const load = (over: Partial<MigrationLoadResult> = {}): MigrationLoadResult => ({
    loaded: 10,
    failed: [],
    assetFailures: [],
    unresolvedLinks: 0,
    deferred: [],
    more: false,
    ...over,
  });
  beforeEach(() => {
    template = authored({ status: 'approved', contentTypeId: 'post' });
  });

  it('transforms until done, going on from each answer’s cursor, a lost race sent again', async () => {
    client.transformMigrationPages
      .mockResolvedValueOnce(
        transformed({
          next: 'p10',
          failed: [{ pageId: 'p3', url: 'https://example.com/3', error: EVIL }],
        }),
      )
      .mockRejectedValueOnce(conflict())
      .mockResolvedValueOnce(
        transformed({ more: false, transformed: 4, validated: 4, needsFix: 0 }),
      );
    open();
    await press('Transform until done');
    expect(
      await screen.findByText('Transformed 14 pages: 13 validated, 1 needs a fix.'),
    ).toBeTruthy();
    expect(client.transformMigrationPages.mock.calls.map((c) => c[2])).toEqual([
      { limit: 10 },
      { limit: 10, after: 'p10' },
      { limit: 10, after: 'p10' },
    ]);
    const failures = screen.getByRole('list', { name: 'Pages not transformed' });
    expect(within(failures).getByText(EVIL)).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('transforms one batch a press, each going on from the last', async () => {
    client.transformMigrationPages
      .mockResolvedValueOnce(transformed({ next: 'p10' }))
      .mockResolvedValueOnce(transformed({ more: false }));
    open();
    await press('Transform pages');
    expect(await screen.findByText(/More pages follow\.$/)).toBeTruthy();
    await press('Transform pages');
    await waitFor(() => expect(client.transformMigrationPages).toHaveBeenCalledTimes(2));
    expect(client.transformMigrationPages.mock.calls[1]?.[2]).toEqual({ limit: 10, after: 'p10' });
  });

  it('stops when asked, saying a batch may still finish', async () => {
    client.transformMigrationPages.mockImplementation(
      (_r, _t, _o, signal: AbortSignal) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(new DOMException('', 'AbortError'))),
        ),
    );
    open();
    await press('Transform until done');
    const stop = await screen.findByRole('button', { name: 'Stop' });
    await waitFor(() => expect(document.activeElement).toBe(stop));
    fireEvent.click(stop);
    expect(await screen.findByText(/^Stopped\..*may still finish/)).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Transform until done' }),
      ),
    );
  });

  it('loads until done, listing pages and files not brought in, and needs-fix when asked', async () => {
    client.loadMigrationPages
      .mockResolvedValueOnce(
        load({
          more: true,
          failed: [{ pageId: 'p1', url: 'https://example.com/1', error: 'no title' }],
          assetFailures: [
            { pageId: 'p2', url: 'https://example.com/a.png', error: 'answered 404' },
          ],
          unresolvedLinks: 2,
        }),
      )
      .mockResolvedValueOnce(load({ loaded: 3 }));
    open();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Include needs-fix pages' }));
    await press('Load until done');
    expect(
      await screen.findByText(
        'Loaded 13 pages; 1 not loaded; 1 file not brought in; 2 links left for Relink.',
      ),
    ).toBeTruthy();
    expect(client.loadMigrationPages.mock.calls[0]?.[2]).toEqual({
      limit: 10,
      includeNeedsFix: true,
    });
    expect(screen.getByText('no title')).toBeTruthy();
    expect(screen.getByText('answered 404')).toBeTruthy();
  });

  it('stops a load whose pages left all keep losing their race, and lists them', async () => {
    client.loadMigrationPages.mockResolvedValue(
      load({
        loaded: 0,
        more: true,
        deferred: [{ pageId: 'p1', url: 'https://example.com/1', error: 'claimed' }],
      }),
    );
    open();
    await press('Load until done');
    expect(await screen.findByText(/keep losing a race/)).toBeTruthy();
    expect(client.loadMigrationPages).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('list', { name: 'Pages left for the next load' })).toBeTruthy();
  });

  it('keeps what was loaded before a batch failed, with Try again', async () => {
    client.loadMigrationPages
      .mockResolvedValueOnce(load({ more: true }))
      .mockRejectedValueOnce(refusal(503, 'unavailable', 'Try later'));
    open();
    await press('Load until done');
    expect(await screen.findByText('Loading stopped')).toBeTruthy();
    expect(screen.getByText('Loaded 10 pages.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('offers each step only to a role that holds what it needs', async () => {
    client.getSpaceAccess.mockResolvedValue({ scopes: ['migration:run'], subject: 'me' });
    open();
    expect(await screen.findByRole('button', { name: 'Transform pages' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load pages' })).toBeNull();
    expect(
      screen.getAllByText('Loading takes migration:run, content:write and assets:write.'),
    ).toHaveLength(1);
  });

  it('waits on the approval', async () => {
    template = authored();
    open();
    const button = (await screen.findByRole('button', {
      name: 'Transform pages',
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getAllByText('Approve the template first.')).toHaveLength(2);
  });
});

describe('finishing a run', () => {
  const published = (over: Partial<MigrationPublishResult> = {}): MigrationPublishResult => ({
    published: 50,
    added: 0,
    failed: [],
    ...over,
  });
  beforeEach(() => {
    template = authored({ status: 'approved', contentTypeId: 'post' });
    loaded = 24;
  });
  const run = () => open('/migrations/run-1');

  it('relinks until there is no next', async () => {
    client.relinkMigrationPages
      .mockResolvedValueOnce({
        checked: 50,
        relinked: 20,
        unresolvedLinks: 0,
        skipped: [{ pageId: 'p', url: 'https://example.com/s', error: 'edited since' }],
        next: 'x',
      })
      .mockResolvedValueOnce({ checked: 5, relinked: 1, unresolvedLinks: 2, skipped: [] });
    run();
    await press('Relink');
    expect(
      await screen.findByText(
        'Relinked 21 entries of 55 read; 2 links still to pages with no entry.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('edited since')).toBeTruthy();
  });

  it('writes redirects, counting what was skipped and why', async () => {
    client.importMigrationRedirects.mockResolvedValue({
      created: 12,
      updated: 0,
      unchanged: 3,
      skipped: { identity: 4, noUrlPattern: 0, unresolved: 1 },
      chains: [],
    });
    run();
    await press('Write redirects');
    expect(await screen.findByText(/4 skipped: the path didn’t move/)).toBeTruthy();
    expect(screen.getByText(/1 skipped: no path could be made/)).toBeTruthy();
  });

  it('publishes nothing until it is confirmed with the number, then until done', async () => {
    client.publishMigrationPages
      .mockResolvedValueOnce(published({ published: 20, next: 'p20' }))
      .mockResolvedValueOnce(
        published({
          published: 3,
          failed: [{ pageId: 'p', url: 'https://example.com/f', error: 'required' }],
        }),
      );
    run();
    await press('Publish…');
    const ask = await screen.findByRole('alertdialog', {
      name: 'Publish 24 loaded entries of example.com now?',
    });
    expect(ask.textContent).toMatch(/go public at once.*doesn’t undo/);
    expect(document.activeElement).toBe(within(ask).getByRole('button', { name: 'Not now' }));
    expect(client.publishMigrationPages).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole('button', { name: 'Not now' }));
    expect(client.publishMigrationPages).not.toHaveBeenCalled();
    await press('Publish…');
    await press('Publish 24 entries');
    expect(await screen.findByText('Published 23 entries; 1 failed.')).toBeTruthy();
    expect(client.publishMigrationPages.mock.calls.map((c) => c[1])).toEqual([
      { limit: 24 },
      { limit: 4, after: 'p20' },
    ]);
    expect(screen.getByRole('list', { name: 'Entries not published' })).toBeTruthy();
  });

  it('adds them to a release, the batches after the first to the one it answered, and links it', async () => {
    client.publishMigrationPages
      .mockResolvedValueOnce(published({ published: 0, added: 20, releaseId: 'rel-1', next: 'p' }))
      .mockResolvedValueOnce(published({ published: 0, added: 4, releaseId: 'rel-1' }));
    run();
    await press('Publish…');
    fireEvent.click(await screen.findByRole('radio', { name: 'Through a release' }));
    fireEvent.change(screen.getByLabelText('Its title (optional)'), {
      target: { value: 'New site' },
    });
    await press('Add to the release');
    expect(await screen.findByText('Added 24 entries to the release.')).toBeTruthy();
    expect(client.publishMigrationPages.mock.calls.map((c) => c[1])).toEqual([
      { viaRelease: true, releaseTitle: 'New site', limit: 24 },
      { viaRelease: true, releaseId: 'rel-1', limit: 4, after: 'p' },
    ]);
    expect(screen.getByRole('link', { name: 'Open the release' }).getAttribute('href')).toBe(
      '/releases?release=rel-1',
    );
  });

  it('asks again, rather than publishing, when Try again follows a failure', async () => {
    client.publishMigrationPages.mockRejectedValueOnce(refusal(503, 'unavailable', 'Later'));
    run();
    await press('Publish…');
    await press('Publish 24 entries');
    await press('Try again');
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(client.publishMigrationPages).toHaveBeenCalledTimes(1);
  });

  it('publishes no more than it asked about, and asks nothing when the count can’t be read', async () => {
    loaded = 2;
    client.publishMigrationPages.mockResolvedValue(published({ published: 1, next: 'n1' }));
    client.publishMigrationPages
      .mockResolvedValueOnce(published({ published: 1, next: 'a' }))
      .mockResolvedValueOnce(published({ published: 1, next: 'b' }));
    run();
    await press('Publish…');
    await press('Publish 2 entries');
    expect(
      await screen.findByText(/^Published 2 entries\. Any more were loaded since/),
    ).toBeTruthy();
    expect(client.publishMigrationPages).toHaveBeenCalledTimes(2);
    client.getMigrationRun.mockRejectedValueOnce(refusal(500, 'x', 'x'));
    await press('Publish…');
    expect(await screen.findByText(/nothing was asked/)).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('asks again with the release a failed add chose', async () => {
    client.publishMigrationPages.mockRejectedValueOnce(refusal(503, 'unavailable', 'Later'));
    run();
    await press('Publish…');
    fireEvent.click(await screen.findByRole('radio', { name: 'Through a release' }));
    await press('Add to the release');
    await press('Try again');
    expect(await screen.findByRole('button', { name: 'Add to the release' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Publish 24/ })).toBeNull();
  });

  it('keeps someone’s place while a long loop ends', async () => {
    let end: (r: unknown) => void = () => {};
    client.relinkMigrationPages.mockImplementation(() => new Promise((r) => (end = r)));
    run();
    await press('Relink');
    const stage = screen.getByLabelText('Stage');
    stage.focus();
    end({ checked: 1, relinked: 1, unresolvedLinks: 0, skipped: [] });
    expect(await screen.findByText(/^Relinked 1 entry/)).toBeTruthy();
    expect(document.activeElement).toBe(stage);
  });

  it('offers a publisher without content:write no release, and others only what they hold', async () => {
    client.getSpaceAccess.mockResolvedValue({
      scopes: ['content:manage', 'content:publish'],
      subject: 'me',
    });
    run();
    await press('Publish…');
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(screen.queryByRole('radio', { name: 'Through a release' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Relink' })).toBeNull();
    expect(screen.getAllByText('Relinking takes migration:run and content:write.')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Write redirects' })).toBeTruthy();
  });
});

describe('in the background', () => {
  const run = () => open('/migrations/run-1');

  it('starts the driver, and says when it was running already', async () => {
    client.startMigrationRun
      .mockResolvedValueOnce({ started: true })
      .mockResolvedValueOnce({ started: false });
    run();
    await press('Start');
    expect(await screen.findByText(/^Started\. It pauses/)).toBeTruthy();
    await press('Start');
    expect(await screen.findByText('It was already running in the background.')).toBeTruthy();
  });

  it('says a finished driver and an install without one in plain words, with no Try again', async () => {
    client.startMigrationRun
      .mockRejectedValueOnce(
        refusal(
          400,
          'invalid_state',
          'The migration run "run-1" has a driver that has finished: x',
        ),
      )
      .mockRejectedValueOnce(refusal(501, 'not_configured', 'x'));
    run();
    await press('Start');
    expect(await screen.findByText(/has already finished/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await press('Start');
    expect(await screen.findByText(/isn’t set up on this install/)).toBeTruthy();
  });

  it('gives the go-ahead only once confirmed, and says a run never started', async () => {
    client.approveMigrationPublish
      .mockRejectedValueOnce(refusal(404, 'not_found', 'x'))
      .mockResolvedValueOnce({ accepted: true });
    run();
    await press('Give the go-ahead to publish…');
    expect(client.approveMigrationPublish).not.toHaveBeenCalled();
    expect((await screen.findByRole('alertdialog')).textContent).toMatch(/go public as you/);
    await press('Give the go-ahead');
    expect(await screen.findByText(/Nothing is running this in the background/)).toBeTruthy();
    await press('Give the go-ahead to publish…');
    await press('Give the go-ahead');
    expect(await screen.findByText(/^Go-ahead given/)).toBeTruthy();
    expect(client.approveMigrationPublish).toHaveBeenLastCalledWith('run-1', {});
  });

  it('takes one go-ahead: an unanswered one can only be sent again as it was', async () => {
    client.approveMigrationPublish
      .mockRejectedValueOnce(refusal(503, 'unavailable', 'x'))
      .mockResolvedValueOnce({ accepted: true });
    run();
    await press('Give the go-ahead to publish…');
    await press('Give the go-ahead');
    expect(await screen.findByText(/Another can’t replace it/)).toBeTruthy();
    await press('Send the go-ahead again…');
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(screen.queryByRole('radio', { name: 'Through a release' })).toBeNull();
    await press('Give the go-ahead');
    expect(await screen.findByText(/^Go-ahead given/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /go-ahead/ })).toBeNull();
  });

  it('holds a stopped run, saying what can still be done', async () => {
    status = 'stopped';
    run();
    const start = (await screen.findByRole('button', { name: 'Start' })) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(screen.getByText(/so it can’t be started or told anything again/)).toBeTruthy();
    expect(screen.getByText('Its background run stopped')).toBeTruthy();
    expect(screen.getByText('no go-ahead came')).toBeTruthy();
  });
});
