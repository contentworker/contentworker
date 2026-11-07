// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type LivePreviewState, useLivePreview } from '../src/index';

const ADMIN = 'https://admin.test';
const SESSION = 'sess_0123456789';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let parent: { postMessage: ReturnType<typeof vi.fn> };
let root: Root | undefined;

function send(data: Record<string, unknown>): void {
  const event = new MessageEvent('message', {
    data: { cw: 1, session: SESSION, ...data },
    origin: ADMIN,
  });
  Object.defineProperty(event, 'source', { value: parent });
  window.dispatchEvent(event);
}

const types = () => parent.postMessage.mock.calls.map(([m]) => (m as { type: string }).type);

beforeEach(() => {
  parent = { postMessage: vi.fn() };
  Object.defineProperty(window, 'parent', { value: parent, configurable: true });
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
  window.history.replaceState(null, '', `/?cw_session=${SESSION}`);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  Object.defineProperty(window, 'parent', { value: window, configurable: true });
});

let states: LivePreviewState[] = [];

let onChange: (() => void) | undefined;

function Page() {
  const live = useLivePreview({ adminOrigin: ADMIN, onChange: () => onChange?.() });
  states.push(live);
  const title = live.fields?.title?.['en-US'];
  return createElement('h1', null, typeof title === 'string' ? title : 'Delivered');
}

function mount(): { states: LivePreviewState[] } {
  states = [];
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(createElement(Page)));
  return { states };
}

describe('useLivePreview', () => {
  it('renders the edited fields and acknowledges once React has committed them', async () => {
    const { states } = mount();
    expect(states.at(-1)).toMatchObject({ active: true, fields: undefined });
    expect(document.querySelector('h1')?.textContent).toBe('Delivered');

    await act(async () => {
      send({
        type: 'init',
        fields: { title: { 'en-US': 'Draft' } },
        locale: 'en-US',
        version: 1,
        entryId: 'e1',
        contentType: 'page',
      });
    });
    expect(document.querySelector('h1')?.textContent).toBe('Draft');
    expect(types()).toContain('rendered');

    await act(async () => {
      send({
        type: 'patch',
        seq: 1,
        ops: [{ op: 'setField', field: 'title', locale: 'en-US', value: 'Edited' }],
      });
    });
    expect(document.querySelector('h1')?.textContent).toBe('Edited');
    expect(states.at(-1)?.update?.seq).toBe(1);
  });

  it('settles a render that never commits because the page unmounted', async () => {
    mount();
    const settled = vi.fn();
    onChange = settled;
    act(() => {
      send({
        type: 'init',
        fields: { title: { 'en-US': 'Draft' } },
        locale: 'en-US',
        version: 1,
        entryId: 'e1',
        contentType: 'page',
      });
      root?.unmount();
    });
    root = undefined;
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toHaveBeenCalledTimes(1);
    onChange = undefined;
  });

  it('stays inert outside a frame, and stops listening when unmounted', async () => {
    Object.defineProperty(window, 'parent', { value: window, configurable: true });
    const { states } = mount();
    expect(states.at(-1)?.active).toBe(false);
    act(() => root?.unmount());
    root = undefined;
    expect(parent.postMessage).not.toHaveBeenCalled();
  });
});
