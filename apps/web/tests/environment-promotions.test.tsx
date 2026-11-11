// Promotions in Settings → Environments: requesting one, the list, and a promotion's record with
// Approve and Reject, through the real Management client against a mocked same-origin fetch.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { Promotions } from '~/cms/components/promotions/Promotions';
import { ClientProvider } from '~/cms/lib/client-context';
import { ToastProvider } from '~/cms/lib/toast';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const SPACE = '/spaces/space-1';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

type Json = Record<string, unknown>;

const base = {
  spaceId: 'space-1',
  source: 'staging',
  target: 'main',
  contentTypes: [{ apiId: 'article', version: 3 }],
  entries: [
    { entryId: 'entry-aaaaaaaa-1', contentTypeApiId: 'article', version: 4, publish: true },
    { entryId: 'entry-bbbbbbbb-2', contentTypeApiId: 'article', version: 2, publish: false },
  ],
  risk: { protectedTarget: true, reasons: ['The target is main'], requiresApproval: true },
  requestedBy: 'usr_other',
  createdAt: ago(600_000),
};

const waiting: Json = {
  ...base,
  id: 'p-wait',
  status: 'awaiting_approval',
  risk: {
    protectedTarget: true,
    reasons: [
      'The target is main',
      'The content type "article" makes the field "summary" required',
      'The risk check rates it Significant',
    ],
    assessment: { review: 0.72, breaking: 0.18, risk: 2.2, source: 'model' },
    requiresApproval: true,
  },
};

const completed: Json = {
  ...base,
  id: 'p-done',
  target: 'qa',
  status: 'completed',
  risk: { protectedTarget: false, reasons: [], requiresApproval: false },
  requestedBy: 'usr_me',
  completedAt: ago(500_000),
  result: {
    contentTypes: ['article'],
    entries: ['entry-aaaaaaaa-1', 'entry-bbbbbbbb-2'],
    published: ['entry-aaaaaaaa-1'],
    mismatched: [],
    gated: ['entry-bbbbbbbb-2'],
  },
};

const STALE =
  'The apply stopped before it finished and was failed after an hour; what it wrote before it stopped stays. Compare the environments and request a new promotion';

const stale: Json = {
  ...base,
  id: 'p-stale',
  status: 'failed',
  decidedBy: 'usr_me',
  decidedAt: ago(7_400_000),
  completedAt: ago(3_700_000),
  error: STALE,
};

const rejected: Json = {
  ...base,
  id: 'p-rejected',
  status: 'rejected',
  decidedBy: 'usr_me',
  decidedAt: ago(100_000),
};

const applying: Json = { ...base, id: 'p-applying', status: 'applying', decidedAt: ago(5_000) };

const diff = {
  spaceId: 'space-1',
  source: 'staging',
  target: 'main',
  contentTypes: [
    { apiId: 'article', kind: 'changed' },
    { apiId: 'legacy', kind: 'removed' },
  ],
  entries: [
    { entryId: 'entry-aaaaaaaa-1', contentTypeApiId: 'article', kind: 'added' },
    { entryId: 'entry-bbbbbbbb-2', contentTypeApiId: 'article', kind: 'changed' },
    { entryId: 'entry-cccccccc-3', contentTypeApiId: 'article', kind: 'unchanged' },
  ],
};

interface Setup {
  /** What the list answers (all of them, newest first); `forbidden` a 403. */
  list?: Json[] | 'never' | 'forbidden';
  /** What `POST …/promotions` answers. */
  request?: { status: number; body: unknown };
  /** What `POST …/approve` and `…/reject` answer, by id. */
  decide?: { status: number; body: unknown };
  /** Who the session is. */
  subject?: string;
  scopes?: string[];
  compare?: unknown;
  url?: string;
  /** More records the API holds. */
  extra?: Json[];
  /** What the record becomes once decided, whatever the answer (an apply that failed). */
  afterDecide?: Json;
  /** A record the request leaves behind, whatever it answers (one whose apply failed). */
  afterRequest?: Json;
}

function setup(opts: Setup = {}) {
  const records = new Map<string, Json>(
    [waiting, completed, stale, rejected, applying, ...(opts.extra ?? [])].map((p) => [
      p.id as string,
      p,
    ]),
  );
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url === '/spaces') return json({ items: [{ id: 'space-1', name: 'Space 1' }] });
    if (url === `${SPACE}/auth/me`) {
      return json({
        spaceId: 'space-1',
        kind: 'user',
        subject: opts.subject ?? 'usr_me',
        scopes: opts.scopes ?? ['content:publish', 'content:manage'],
      });
    }
    if (url.startsWith(`${SPACE}/compare?`)) return json(opts.compare ?? diff);
    if (url.startsWith(`${SPACE}/promotions`) && method === 'GET') {
      const id = url.slice(`${SPACE}/promotions/`.length);
      if (url.startsWith(`${SPACE}/promotions/`)) {
        const found = records.get(id);
        return found ? json(found) : json({ error: { message: 'not found' } }, 404);
      }
      if (opts.list === 'never') return new Promise<Response>(() => {});
      if (opts.list === 'forbidden') {
        return json(
          { error: { code: 'forbidden', message: 'Missing scope content:publish' } },
          403,
        );
      }
      const items = opts.list ?? [...records.values()];
      const status = new URL(url, 'http://x').searchParams.get('status');
      return json({ items: status ? items.filter((p) => p.status === status) : items });
    }
    if (url === `${SPACE}/promotions` && method === 'POST') {
      const r = opts.request ?? { status: 201, body: waiting };
      if (opts.afterRequest) records.set(opts.afterRequest.id as string, opts.afterRequest);
      return json(r.body, r.status);
    }
    if (url.endsWith('/approve') || url.endsWith('/reject')) {
      const who = opts.subject ?? 'usr_me';
      const r = opts.decide ?? {
        status: 200,
        body: url.endsWith('/approve')
          ? { ...waiting, status: 'completed', decidedBy: who, completedAt: ago(0) }
          : { ...waiting, status: 'rejected', decidedBy: who, decidedAt: ago(0) },
      };
      if (r.status === 200) records.set((r.body as Json).id as string, r.body as Json);
      if (opts.afterDecide) records.set(opts.afterDecide.id as string, opts.afterDecide);
      return json(r.body, r.status);
    }
    return json({});
  }) as unknown as typeof fetch;
  render(
    <MemoryRouter initialEntries={[opts.url ?? '/settings/environments']}>
      <ToastProvider>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <ClientProvider
            initial={{ space: 'space-1', environment: 'main', locale: 'en-US' }}
            fetchImpl={fetchImpl}
          >
            <Promotions
              environments={[
                { id: 'main', name: 'Main' },
                { id: 'staging', name: 'Staging' },
                { id: 'qa', name: 'QA' },
              ]}
            />
          </ClientProvider>
        </QueryClientProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
  return calls;
}

/** Request promotion…, then the confirm's Request promotion. */
const request = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Request promotion into main…' }));
  const confirm = await screen.findByRole('alertdialog');
  expect(within(confirm).getByText('Request a promotion into main?')).toBeTruthy();
  fireEvent.click(within(confirm).getByRole('button', { name: 'Request promotion' }));
};

/** Approve and promote…, then the confirm's Approve and promote. */
const approve = async (sheet: HTMLElement) => {
  fireEvent.click(await within(sheet).findByRole('button', { name: 'Approve and promote…' }));
  const confirm = await screen.findByRole('alertdialog');
  fireEvent.click(within(confirm).getByRole('button', { name: 'Approve and promote' }));
  return confirm;
};

const compare = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
  return screen.findByRole('group', { name: /^Entries/ });
};

describe('Requesting a promotion', () => {
  it('defaults to another environment into main, and preselects what it can carry', async () => {
    const calls = setup();
    expect(
      screen.getByRole('combobox', { name: 'Source environment to promote from' }).textContent,
    ).toContain('staging');
    expect(
      screen.getByRole('combobox', { name: 'Target environment to promote into' }).textContent,
    ).toContain('main');
    const entries = await compare();
    expect(calls.some((c) => c.url === `${SPACE}/compare?source=staging&target=main`)).toBe(true);
    // Only what it can carry is listed; what only the target has is counted.
    expect(within(entries).getAllByRole('checkbox')).toHaveLength(2);
    expect(within(entries).getByText('2 of 2 selected')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Promote legacy' })).toBeNull();
    expect(
      screen.getByText('1 content type is only in main: a promotion leaves it as it is.'),
    ).toBeTruthy();
  });

  it('sends the selection and the blocks choice, and says why it waits for approval', async () => {
    const calls = setup();
    await compare();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Promote article · bbbbbb-2' }));
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Include the block catalog and block config' }),
    );
    await request();
    expect(await screen.findByText('Waiting for approval')).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST' && c.url === `${SPACE}/promotions`);
    expect(post?.body).toEqual({
      source: 'staging',
      target: 'main',
      contentTypes: ['article'],
      entries: ['entry-aaaaaaaa-1'],
      blocks: false,
    });
    // The reasons in the API's words, then the model's view in words and figures.
    expect(
      screen.getByText('The content type "article" makes the field "summary" required'),
    ).toBeTruthy();
    expect(screen.getByText('The model')).toBeTruthy();
    expect(screen.getByText('Significant')).toBeTruthy();
    expect(screen.getByText('72%')).toBeTruthy();
    expect(screen.getByText('18%')).toBeTruthy();
    // And the list was read again, so it shows there.
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === 'GET' && c.url === `${SPACE}/promotions`).length,
      ).toBe(2),
    );
  });

  it('says one applied at once, with what went as drafts', async () => {
    setup({ request: { status: 201, body: completed } });
    await compare();
    await request();
    expect(await screen.findByText('Promoted into qa')).toBeTruthy();
    expect(screen.getByText(/1 content type and 2 entries copied, 1 entry live\./)).toBeTruthy();
    expect(
      screen.getByText(/1 entry went as drafts: a workflow publishes them in qa\./),
    ).toBeTruthy();
    // Applied: the diff is read again, and nothing is left ticked.
    fireEvent.click(screen.getByRole('button', { name: 'View promotion' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('lists a refusal’s issues in the API’s words, grouped, and keeps the selection', async () => {
    const issues = [
      {
        field: 'contentTypes',
        message:
          'The content type "article" removes the field "summary", which 3 entries in main still hold (entry-1, entry-2, entry-3)',
      },
      {
        field: 'entries',
        message: 'Entry entry-9 is in the trash in main: restore or purge it there first',
      },
    ];
    setup({
      request: { status: 422, body: { error: { code: 'validation', message: 'Invalid', issues } } },
    });
    await compare();
    await request();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Nothing was promoted into main')).toBeTruthy();
    expect(
      within(alert).getByText(/may list it as failed\. Nothing was copied either way\./),
    ).toBeTruthy();
    expect(within(alert).getByText('Content types')).toBeTruthy();
    expect(within(alert).getByText('Entries')).toBeTruthy();
    expect(within(alert).getByText(issues[0]!.message)).toBeTruthy();
    expect(within(alert).getByText(issues[1]!.message)).toBeTruthy();
    // The choice stays for sending again.
    expect(screen.getByText('2 of 2 selected')).toBeTruthy();
  });

  it('says one that applied at once and stopped partway failed, from the record the API answers', async () => {
    const error = 'Entry entry-aaaaaaaa-1 takes the slug "spring", which entry-x holds in main';
    setup({
      request: {
        status: 201,
        body: { ...completed, id: 'p-partway', target: 'main', status: 'failed', error },
      },
    });
    await compare();
    await request();
    expect(await screen.findByText('The promotion failed')).toBeTruthy();
    expect(screen.getByText(error)).toBeTruthy();
    expect(screen.queryByText('Nothing was promoted into main')).toBeNull();
  });

  it('closes the picker once answered, so the same promotion isn’t filed twice', async () => {
    setup();
    await compare();
    await request();
    expect(await screen.findByText('Waiting for approval')).toBeTruthy();
    expect(screen.queryByRole('group', { name: /^Entries/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Request promotion into main…' })).toBeNull();
  });

  it('offers no request to a role that can’t manage content, and says why', async () => {
    setup({ scopes: ['content:publish'] });
    await compare();
    const button = screen.getByRole('button', { name: 'Request promotion into main…' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    expect(
      screen.getByText(/Requesting a promotion takes a role that can manage and publish content/),
    ).toBeTruthy();
  });

  it('says a 403 in the API’s words', async () => {
    setup({
      request: {
        status: 403,
        body: {
          error: {
            code: 'forbidden',
            message: 'Promotions take a role without content-type or field restrictions',
          },
        },
      },
    });
    await compare();
    await request();
    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByText('Promotions take a role without content-type or field restrictions'),
    ).toBeTruthy();
  });

  it('keeps a long diff in a scrolling list that can be cleared and refilled', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      entryId: `e${String(i).padStart(3, '0')}-xxxx`,
      contentTypeApiId: 'article',
      kind: 'added',
    }));
    setup({ compare: { ...diff, contentTypes: [], entries: many } });
    const entries = await compare();
    const list = within(entries).getByRole('list', { name: 'Entries' });
    // Focusable, so the keyboard can scroll it.
    expect(list.getAttribute('tabindex')).toBe('0');
    expect(within(entries).getByText('40 of 40 selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select none of the entries' }));
    expect(within(entries).getByText('0 of 40 selected')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Include the block catalog and block config' }),
    );
    expect(
      (screen.getByRole('button', { name: 'Request promotion into main…' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Select all entries' }));
    expect(within(entries).getByText('40 of 40 selected')).toBeTruthy();
  });
});

describe('The promotions list', () => {
  it('shows each one’s route, requester, what it copies and its status in words', async () => {
    setup();
    const list = await screen.findByRole('list', { name: 'Promotions' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(5);
    const done = rows.find((r) => r.textContent?.includes('qa')) as HTMLElement;
    expect(within(done).getByText('Completed')).toBeTruthy();
    expect(within(done).getByText(/^You ·/)).toBeTruthy();
    expect(within(done).getByText('1 content type and 2 entries')).toBeTruthy();
    for (const word of ['Awaiting approval', 'Failed', 'Rejected', 'Applying']) {
      expect(within(list).getByText(word)).toBeTruthy();
    }
  });

  it('opens a record from anywhere on its row, by a button that says which promotion it is', async () => {
    setup();
    const open = await screen.findByRole('button', {
      name: /^Open promotion staging → qa, 1 content type and 2 entries, completed, requested by you \w{3} \d/,
    });
    // Stretched over the row, so a press anywhere on it lands on the button.
    expect(open.className).toContain('after:inset-0');
    expect(open.closest('li')?.className).toContain('relative');
    fireEvent.click(open);
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('calls a requester’s own rejection Withdrawn in the list', async () => {
    setup({
      list: [{ ...rejected, id: 'p-withdrawn', decidedBy: base.requestedBy }],
    });
    const list = await screen.findByRole('list', { name: 'Promotions' });
    expect(within(list).getByText('Withdrawn')).toBeTruthy();
  });

  it('asks the API for only those awaiting approval', async () => {
    const calls = setup();
    await screen.findByRole('list', { name: 'Promotions' });
    fireEvent.click(screen.getByRole('radio', { name: 'Awaiting approval' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `${SPACE}/promotions?status=awaiting_approval`)).toBe(
        true,
      ),
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Promotions' })).getAllByRole('listitem'),
      ).toHaveLength(1),
    );
  });

  it('says a role that can’t publish doesn’t list them, without calling it a failure', async () => {
    setup({ list: 'forbidden', scopes: ['content:write'] });
    expect(
      await screen.findByText('Promotions are listed for roles that can publish content.'),
    ).toBeTruthy();
    expect(screen.queryByText('Couldn’t read the promotions')).toBeNull();
  });

  it('says when there are none yet', async () => {
    setup({ list: [] });
    expect(await screen.findByText('No promotions yet')).toBeTruthy();
  });

  it('marks itself busy while it loads, with one status line', () => {
    setup({ list: 'never' });
    const loading = screen.getByText('Loading promotions…');
    expect(loading.getAttribute('role')).toBe('status');
    expect(loading.closest('[aria-busy="true"]')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Promotions' })).toBeNull();
  });
});

describe('A promotion’s record', () => {
  it('lets someone other than the requester approve it, after a modal confirm', async () => {
    const calls = setup({ url: '/settings/environments?promotion=p-wait' });
    const sheet = await screen.findByRole('dialog');
    await within(sheet).findByText('Why it needs approval');
    expect(within(sheet).getByText('The risk check rates it Significant')).toBeTruthy();
    expect(within(sheet).getByText('Goes live')).toBeTruthy();
    expect(within(sheet).getByText('As a draft')).toBeTruthy();
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Approve and promote…' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('Approve and promote into main?')).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Approve and promote' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/p-wait/approve'))).toBe(
        true,
      ),
    );
    expect(
      await within(sheet).findByText('Promoted into main', { selector: '[data-slot=alert-title]' }),
    ).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: 'Approve and promote…' })).toBeNull();
    // The confirm hands focus to what happened, not to the Approve that's gone.
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain('Promoted into main'),
    );
  });

  it('offers its requester no decision, only Withdraw, recorded as withdrawn by them', async () => {
    const calls = setup({ url: '/settings/environments?promotion=p-wait', subject: 'usr_other' });
    const sheet = await screen.findByRole('dialog');
    expect(
      await within(sheet).findByText(
        'You requested it, so someone else approves or rejects it. You can withdraw it.',
      ),
    ).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: 'Approve and promote…' })).toBeNull();
    expect(within(sheet).queryByRole('button', { name: 'Reject' })).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Withdraw request' }));
    expect(within(sheet).getByText('Withdraw this request?')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Withdraw request' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/p-wait/reject'))).toBe(true),
    );
    expect(await within(sheet).findByText(/^Withdrawn by you,/)).toBeTruthy();
    expect(within(sheet).getByRole('status').textContent).toBe('Withdrawn');
    const history = within(sheet).getByRole('region', { name: 'History' });
    expect(within(history).getByText('Withdrawn')).toBeTruthy();
  });

  it('tells a requester who can’t withdraw what withdrawing takes', async () => {
    setup({
      url: '/settings/environments?promotion=p-wait',
      subject: 'usr_other',
      scopes: ['content:write'],
    });
    const sheet = await screen.findByRole('dialog');
    expect(
      await within(sheet).findByText(/Withdrawing it takes a role that can publish content/),
    ).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: 'Withdraw request' })).toBeNull();
  });

  it('offers no decision to a role that can’t publish, and says why', async () => {
    setup({ url: '/settings/environments?promotion=p-wait', scopes: ['content:write'] });
    const sheet = await screen.findByRole('dialog');
    expect(
      await within(sheet).findByText(
        'Deciding it takes a role that can publish content, with no content-type or field limits.',
      ),
    ).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: 'Approve and promote…' })).toBeNull();
    expect(within(sheet).queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('offers only Reject to a publisher without content:manage when it copies types', async () => {
    setup({ url: '/settings/environments?promotion=p-wait', scopes: ['content:publish'] });
    const sheet = await screen.findByRole('dialog');
    expect(
      await within(sheet).findByText(
        'Approving it also takes content:manage, since it copies content types or blocks.',
      ),
    ).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: 'Approve and promote…' })).toBeNull();
    expect(within(sheet).getByRole('button', { name: 'Reject' })).toBeTruthy();
  });

  it('rejects in place, and says who rejected it', async () => {
    const calls = setup({ url: '/settings/environments?promotion=p-wait' });
    const sheet = await screen.findByRole('dialog');
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Reject' }));
    expect(within(sheet).getByText('Reject this promotion?')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/p-wait/reject'))).toBe(true),
    );
    expect(await within(sheet).findByText(/Rejected by you,/)).toBeTruthy();
    // Reject is gone: focus is on what happened, and the status region says it.
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Rejected by you'));
    expect(within(sheet).getByRole('status').textContent).toBe('Rejected');
  });

  it('says a refused approval in the API’s words, and reads a decided one again', async () => {
    const message = 'Promotion p-wait is completed, not awaiting approval';
    const calls = setup({
      url: '/settings/environments?promotion=p-wait',
      decide: { status: 409, body: { error: { code: 'conflict', message } } },
    });
    const sheet = await screen.findByRole('dialog');
    const confirm = await approve(sheet);
    // Said in the confirm, which stays open on it.
    expect(await within(confirm).findByText(message)).toBeTruthy();
    await waitFor(() =>
      expect(calls.filter((c) => c.url === `${SPACE}/promotions/p-wait`).length).toBeGreaterThan(1),
    );
  });

  it('shows an approval whose apply stopped partway as failed, from the record the API answers', async () => {
    const error = 'Entry entry-bbbbbbbb-2 takes the slug "spring", which entry-x holds in main';
    setup({
      url: '/settings/environments?promotion=p-wait',
      decide: {
        status: 200,
        body: {
          ...waiting,
          status: 'failed',
          decidedBy: 'usr_me',
          decidedAt: ago(0),
          completedAt: ago(0),
          error,
          result: {
            contentTypes: ['article'],
            entries: ['entry-aaaaaaaa-1'],
            published: [],
            mismatched: [],
            gated: [],
          },
        },
      },
    });
    const sheet = await screen.findByRole('dialog');
    await approve(sheet);
    expect(await within(sheet).findByText('The promotion failed')).toBeTruthy();
    expect(within(sheet).getByText(error)).toBeTruthy();
    expect(within(sheet).getByRole('region', { name: 'Written before it stopped' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('says a 403 approval refusal in the API’s words', async () => {
    const message = 'Approving a promotion with content types or blocks takes content:manage';
    setup({
      url: '/settings/environments?promotion=p-wait',
      decide: { status: 403, body: { error: { code: 'forbidden', message } } },
    });
    const sheet = await screen.findByRole('dialog');
    const confirm = await approve(sheet);
    expect(await within(confirm).findByText(message)).toBeTruthy();
  });

  it('says one is applying, and that a stuck apply is failed after an hour', async () => {
    setup({ url: '/settings/environments?promotion=p-applying' });
    const sheet = await screen.findByRole('dialog');
    expect(await within(sheet).findByText(/^Applying since/)).toBeTruthy();
    expect(within(sheet).getByText(/marked failed; what it wrote by then stays\./)).toBeTruthy();
  });

  it('shows the stale sweep’s failure in its own words, with the history', async () => {
    setup({ url: '/settings/environments?promotion=p-stale' });
    const sheet = await screen.findByRole('dialog');
    expect(await within(sheet).findByText('The promotion failed')).toBeTruthy();
    expect(within(sheet).getByText(STALE)).toBeTruthy();
    const history = within(sheet).getByRole('region', { name: 'History' });
    expect(within(history).getByText('Requested')).toBeTruthy();
    expect(within(history).getByText('Approved')).toBeTruthy();
    expect(within(history).getByText('Failed')).toBeTruthy();
  });

  it('shows what a completed one did, and that it needed no approval', async () => {
    setup({ url: '/settings/environments?promotion=p-done' });
    const sheet = await screen.findByRole('dialog');
    expect(
      await within(sheet).findByText('Promoted into qa', { selector: '[data-slot=alert-title]' }),
    ).toBeTruthy();
    expect(within(sheet).getByRole('status').textContent).toBe('Promoted into qa');
    expect(within(sheet).getByText('No rule asked for a person to check it.')).toBeTruthy();
    expect(within(sheet).getByText('Needed no approval')).toBeTruthy();
    expect(within(sheet).getByRole('region', { name: 'What it did' })).toBeTruthy();
  });

  it('shows a long list of entries a few at a time, and hands focus to the first one added', async () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({
      entryId: `entry-${String(i).padStart(2, '0')}-xxxxxx`,
      contentTypeApiId: 'article',
      version: 1,
      publish: false,
    }));
    setup({
      url: '/settings/environments?promotion=p-big',
      extra: [{ ...waiting, id: 'p-big', entries }],
    });
    const sheet = await screen.findByRole('dialog');
    const list = await within(sheet).findByRole('list', { name: 'Entries' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(8);
    const more = within(sheet).getByRole('button', { name: 'Show all 30' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(within(list).getAllByRole('listitem')).toHaveLength(30);
    await waitFor(() =>
      expect(document.activeElement).toBe(within(list).getAllByRole('listitem')[8]),
    );
    expect(within(sheet).getByRole('button', { name: 'Show fewer' })).toBeTruthy();
  });
});
