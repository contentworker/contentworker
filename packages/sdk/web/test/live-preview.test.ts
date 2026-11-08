// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://site.test/page"}
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type LivePreviewState, useLivePreview } from '../src/index';

const ADMIN = 'https://admin.test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The admin's window: records what the page posts. */
let parent: { postMessage: ReturnType<typeof vi.fn> };
let root: Root | undefined;
let channel = '';

const posted = () =>
  parent.postMessage.mock.calls.map(([m]) => m as { kind: string; [k: string]: unknown });

function send(data: Record<string, unknown>): void {
  const event = new MessageEvent('message', { data: { v: 1, channel, ...data }, origin: ADMIN });
  Object.defineProperty(event, 'source', { value: parent });
  window.dispatchEvent(event);
}

function accept(): void {
  channel = posted().find((m) => m.kind === 'connect.offer')?.channel as string;
  send({ kind: 'connect.accept', version: 1, capabilities: ['select', 'patch.fields'] });
}

beforeEach(() => {
  parent = { postMessage: vi.fn() };
  Object.defineProperty(window, 'parent', { value: parent, configurable: true });
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  Object.defineProperty(window, 'parent', { value: window, configurable: true });
});

let states: LivePreviewState[] = [];
let onState: (() => void) | undefined;

function Page() {
  const live = useLivePreview({
    adminOrigin: ADMIN,
    capabilities: ['select', 'patch.fields'],
    page: { entries: [{ entryId: 'e1', contentType: 'page', locale: 'en-US' }] },
    onState: () => onState?.(),
  });
  states.push(live);
  const title = live.entries.e1?.view.withProposals.title;
  return createElement('h1', null, typeof title === 'string' ? title : 'Delivered');
}

function mount() {
  states = [];
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(createElement(Page)));
}

const state = {
  kind: 'entry.state',
  rev: 0,
  entryId: 'e1',
  locale: 'en-US',
  fields: { title: 'Draft' },
};

describe('useLivePreview', () => {
  it('renders the unsaved state and acknowledges once React has committed it', async () => {
    mount();
    expect(states.at(-1)).toMatchObject({ active: true, connected: false, entries: {} });
    await act(async () => accept());
    expect(states.at(-1)?.connected).toBe(true);
    expect(posted().find((m) => m.kind === 'page')).toMatchObject({
      entries: [{ entryId: 'e1', contentType: 'page', locale: 'en-US' }],
    });
    expect(document.querySelector('h1')?.textContent).toBe('Delivered');

    await act(async () => send(state));
    expect(document.querySelector('h1')?.textContent).toBe('Draft');
    await act(async () =>
      send({
        kind: 'entry.patch',
        rev: 1,
        entryId: 'e1',
        locale: 'en-US',
        fields: { title: 'Edited' },
      }),
    );
    expect(document.querySelector('h1')?.textContent).toBe('Edited');
    expect(
      posted()
        .filter((m) => m.kind === 'applied')
        .map((m) => m.rev),
    ).toEqual([0, 1]);
  });

  it('settles a render that never commits because the page unmounted', async () => {
    mount();
    await act(async () => accept());
    const settled = vi.fn();
    onState = settled;
    act(() => {
      send(state);
      root?.unmount();
    });
    root = undefined;
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toHaveBeenCalledTimes(1);
    onState = undefined;
  });

  it('stays inert outside a frame', () => {
    Object.defineProperty(window, 'parent', { value: window, configurable: true });
    mount();
    expect(states.at(-1)?.active).toBe(false);
    expect(parent.postMessage).not.toHaveBeenCalled();
  });
});
