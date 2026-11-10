// @vitest-environment jsdom
// The Site frame beside the entry form, with a Coworker proposal waiting: it marks the page's
// ghost blocks "Proposed" only while the page holds the proposal. A page whose SDK doesn't take
// proposals (or that refused one) draws nothing, so no real block is ever marked as proposed.
import { formatContentRef } from '@contentworker/sdk-core';
import { newChannel } from '@contentworker/sdk-core/live-preview';
import { act, cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FRAME_CHANNEL } from '~/cms/lib/live-preview/frame-channel';

vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('~/lib/auth.server', () => ({ requireUser: async () => ({}) }));
vi.mock('~/lib/preview-frame.server', () => ({ previewFrame: async () => ({}) }));

const SITE = 'https://site.example';
const route = await import('~/routes/preview-frame');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function setup() {
  const frame = {
    ok: true,
    frontendUrl: `${SITE}/p`,
    origin: SITE,
    origins: [SITE],
  };
  const router = createMemoryRouter(
    [{ path: '/', element: <route.default />, loader: () => frame }],
    { initialEntries: ['/'] },
  );
  render(<RouterProvider router={router} />);
  const inner = (await screen.findByTitle('The entry on your site')) as HTMLIFrameElement;
  const guest = inner.contentWindow as Window;
  vi.spyOn(guest, 'postMessage').mockImplementation(() => {});
  /** The entry form, from the editor's window (this test's own). */
  const editor = (data: Record<string, unknown>) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { channel: FRAME_CHANNEL, ...data },
          origin: window.location.origin,
          source: window,
        }),
      );
    });
  const channel = newChannel();
  /** The customer's page, from the inner frame's window. */
  const page = (kind: string, body: Record<string, unknown> = {}) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { v: 1, channel, kind, ...body },
          origin: SITE,
          source: guest,
        }),
      );
    });
  return { editor, page };
}

const ref = (field: string) =>
  formatContentRef({
    space: 'sp',
    environment: 'main',
    entryId: 'e1',
    contentType: 'page',
    field,
    locale: 'en-US',
  });
const rect = { x: 0, y: 10, w: 100, h: 20 };
const ALLOWED = ['select', 'patch.fields', 'patch.blocks', 'scroll', 'layout', 'proposals'];
/** A proposal that changes a block the page already draws: the dangerous one to mark wrongly. */
const CHANGE = [{ op: 'update', field: 'body', locale: 'en-US', key: 'k1', set: { label: 'New' } }];

async function connected(capabilities: string[]) {
  const t = await setup();
  t.editor({ type: 'view', editing: true, device: 'desktop', allowed: ALLOWED });
  t.editor({
    type: 'entry',
    entry: { entryId: 'e1', locale: 'en-US', fields: { body: [{ _type: 'cta', _key: 'k1' }] } },
    edits: null,
  });
  t.page('connect.offer', {
    versions: [1],
    capabilities,
    sdk: { name: '@contentworker/sdk', version: '0.4.0' },
  });
  t.page('page', {
    url: `${SITE}/p`,
    entries: [{ entryId: 'e1', contentType: 'page', locale: 'en-US' }],
  });
  t.page('layout', {
    blocks: [{ ref: ref('body[k1]'), rect }],
    slots: [],
    fields: [],
    scroll: { x: 0, y: 0 },
    viewport: { w: 1280, h: 800 },
    docHeight: 800,
  });
  return t;
}

const marks = () => document.querySelectorAll('[data-ghost-outline]');

describe('the Site frame’s proposal marks', () => {
  it('marks the block a proposal changes while the page holds it, and none once it is taken back', async () => {
    const t = await connected(ALLOWED);
    t.editor({ type: 'proposal', ops: CHANGE });
    expect(marks()).toHaveLength(1);
    expect(marks()[0]?.textContent).toBe('Proposed change');
    t.editor({ type: 'proposal', ops: null });
    expect(marks()).toHaveLength(0);
  });

  it('marks nothing when the page’s SDK doesn’t take proposals', async () => {
    const t = await connected(['select', 'patch.fields', 'patch.blocks', 'scroll', 'layout']);
    t.editor({ type: 'proposal', ops: CHANGE });
    expect(marks()).toHaveLength(0);
  });

  it('marks nothing once the page refuses the proposal', async () => {
    const t = await connected(ALLOWED);
    t.editor({ type: 'proposal', ops: CHANGE });
    expect(marks()).toHaveLength(1);
    // The state was rev 1, the proposal rev 2: the page couldn't place it.
    t.page('failed', { rev: 2, reason: 'conflict', entryId: 'e1' });
    expect(marks()).toHaveLength(0);
  });

  it('marks nothing for ops in a locale the page doesn’t show', async () => {
    const t = await connected(ALLOWED);
    t.editor({ type: 'proposal', ops: [{ ...CHANGE[0], locale: 'de-DE' }] });
    expect(marks()).toHaveLength(0);
  });
});
