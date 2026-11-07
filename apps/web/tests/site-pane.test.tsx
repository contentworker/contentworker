// @vitest-environment jsdom
// The side pane's Site view: it frames the Site frame, sends it the entry and then the ops of each
// edit, and says in words where things stand: loading, a page that doesn't speak live preview, a
// page that moved away, answered from another origin, never loaded or can't be shown, and a quiet
// note when the page refused an edit. Only the frame's own window is heard.
import type { ContentType, EntryFields } from '@contentworker/domain';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_PREVIEW_GUIDE, SitePane } from '~/cms/components/pane/SitePane';
import { FRAME_CHANNEL } from '~/cms/lib/live-preview/frame-channel';
import { LOAD_MS } from '~/cms/lib/live-preview/host';

const type = {
  apiId: 'page',
  fields: [
    {
      apiId: 'title',
      name: 'Title',
      type: 'Symbol',
      localized: true,
      required: false,
      position: 0,
    },
  ],
  preview: { urlTemplate: 'https://site.example/{locale}/p?entry={id}#token={token}' },
} as unknown as ContentType;

const onPick = vi.fn();
const onKey = vi.fn();
function pane(fields: EntryFields = { title: { 'en-US': 'Home' } }, locale = 'en-US') {
  return (
    <SitePane
      spaceId="s1"
      environmentId="main"
      entryId="e1"
      contentType={type}
      version={2}
      fields={fields}
      locale={locale}
      split={false}
      onPick={onPick}
      onKey={onKey}
    />
  );
}

const frame = () => screen.getByTitle('Site preview') as HTMLIFrameElement;
/** A message on the channel, from the frame's window unless `source` says otherwise. */
function fromFrame(data: Record<string, unknown>, source: unknown = frame().contentWindow) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { channel: FRAME_CHANNEL, ...data },
        origin: window.location.origin,
        source: source as Window,
      }),
    );
  });
}
function spyFrame() {
  const win = frame().contentWindow as Window;
  return vi.spyOn(win, 'postMessage').mockImplementation(() => {});
}
const posted = (spy: ReturnType<typeof spyFrame>, type?: string) =>
  spy.mock.calls.map(([m]) => m as Record<string, unknown>).filter((m) => !type || m.type === type);

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('the Site pane', () => {
  it('frames the Site frame for the entry, in its locale when the URL names one, loading meanwhile', () => {
    render(pane());
    expect(frame().getAttribute('src')).toBe('/preview-frame/s1/main/e1?locale=en-US');
    expect(screen.getByRole('status').textContent).toMatch(/Loading the entry’s page/);
    expect(frame().parentElement?.getAttribute('aria-busy')).toBe('true');
  });

  it('sends the entry when the frame is ready, then each edit as ops, posting only to this origin', () => {
    const view = render(pane());
    const spy = spyFrame();
    fromFrame({ type: 'ready', origin: 'https://site.example' });
    expect(posted(spy, 'entry')[0]).toMatchObject({
      entry: { entryId: 'e1', contentType: 'page', locale: 'en-US', version: 2 },
      ops: null,
    });
    expect(posted(spy, 'view')[0]).toMatchObject({ mode: 'view', device: 'desktop' });
    for (const [, target] of spy.mock.calls) expect(target).toBe(window.location.origin);
    view.rerender(pane({ title: { 'en-US': 'Homepage' } }));
    expect(posted(spy, 'entry')[1]).toMatchObject({
      ops: [{ op: 'setField', field: 'title', locale: 'en-US', value: 'Homepage' }],
    });
    expect(screen.getByText('site.example', { exact: false }).textContent).toContain(
      'https://site.example',
    );
  });

  it('switches to edit mode once the page is live, and lets clicks in it be views instead', () => {
    render(pane());
    const spy = spyFrame();
    fromFrame({ type: 'ready', origin: 'https://site.example' });
    fromFrame({ type: 'status', status: 'live' });
    expect(posted(spy, 'view').at(-1)).toMatchObject({ mode: 'edit' });
    act(() => screen.getByRole('radio', { name: 'View' }).click());
    expect(posted(spy, 'view').at(-1)).toMatchObject({ mode: 'view' });
    act(() => screen.getByRole('radio', { name: 'Phone, 390 pixels' }).click());
    expect(posted(spy, 'view').at(-1)).toMatchObject({ device: 'phone' });
  });

  it('ignores the channel from any other window', () => {
    render(pane());
    fromFrame({ type: 'status', status: 'timeout' }, window);
    fromFrame({ type: 'pick', target: { key: 'a' } }, null);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('says a page that never answered doesn’t speak live preview, and links the guide', () => {
    render(pane());
    fromFrame({ type: 'ready', origin: 'https://site.example' });
    fromFrame({ type: 'status', status: 'timeout' });
    expect(screen.getByRole('alert').textContent).toMatch(
      /This site doesn’t speak live preview yet/,
    );
    expect(screen.getByRole('link', { name: 'Set up live preview' }).getAttribute('href')).toBe(
      LIVE_PREVIEW_GUIDE,
    );
    // The page still shows, in view mode.
    expect(frame()).toBeTruthy();
    expect((screen.getByRole('radio', { name: 'Edit' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers the way back after the page navigated away, with a fresh frame', () => {
    render(pane());
    const first = frame();
    fromFrame({ type: 'status', status: 'navigated' });
    expect(screen.getByRole('alert').textContent).toMatch(/moved away from this entry/);
    act(() => screen.getByRole('button', { name: 'Back to the entry' }).click());
    expect(frame()).not.toBe(first);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('names both origins when the page answered from another', () => {
    render(pane());
    fromFrame({ type: 'ready', origin: 'https://site.example' });
    fromFrame({ type: 'status', status: 'origin', detail: 'https://www.site.example' });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('https://www.site.example');
    expect(alert.textContent).toContain('https://site.example');
  });

  it('says the page didn’t load when the frame never comes up, and tries again', () => {
    render(pane());
    act(() => vi.advanceTimersByTime(LOAD_MS));
    expect(screen.getByRole('alert').textContent).toMatch(/The page didn’t load/);
    act(() => screen.getByRole('button', { name: 'Try again' }).click());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says why the entry can’t be shown, and shows no frame', () => {
    render(pane());
    fromFrame({ type: 'status', status: 'unavailable', detail: 'incomplete' });
    expect(screen.getByRole('alert').textContent).toMatch(/no page on the site yet/);
    expect(screen.queryByTitle('Site preview')).toBeNull();
    cleanup();
    render(pane());
    fromFrame({ type: 'status', status: 'unavailable', detail: 'refused' });
    expect(screen.getByRole('alert').textContent).toMatch(/Your role can’t make a preview link/);
  });

  it('notes a refused edit quietly, then lets it go', () => {
    render(pane());
    fromFrame({ type: 'ready', origin: 'https://site.example' });
    fromFrame({ type: 'status', status: 'live' });
    fromFrame({ type: 'note', kind: 'patch' });
    expect(screen.getByRole('status').textContent).toMatch(/sent the whole entry again/);
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => vi.advanceTimersByTime(6_000));
    expect(screen.queryByText(/sent the whole entry again/)).toBeNull();
  });

  it('hands on picks and keys, and clears the selection on Escape', () => {
    render(pane());
    const spy = spyFrame();
    fromFrame({ type: 'pick', target: { key: 'a' } });
    expect(onPick).toHaveBeenCalledWith({ key: 'a' });
    fromFrame({ type: 'key', key: 'z', meta: true, ctrl: false, shift: false, alt: false });
    expect(onKey).toHaveBeenCalledWith({
      key: 'z',
      meta: true,
      ctrl: false,
      shift: false,
      alt: false,
    });
    fromFrame({ type: 'key', key: 'Escape', meta: false, ctrl: false, shift: false, alt: false });
    expect(posted(spy, 'select')).toHaveLength(1);
    expect(posted(spy, 'select')[0]).not.toHaveProperty('target');
  });
});
