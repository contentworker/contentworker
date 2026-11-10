// @vitest-environment jsdom
// The side pane's Site view: it frames the Site frame, says what the page may do and sends it the
// entry (one locale's values) and then each edit, and says in words where things stand: loading,
// a page that isn't connected, an SDK too old or too new, a page that doesn't show the entry or
// moved away, answered from another origin, refused the entry, never loaded or can't be shown, and
// a quiet note when the page refused an edit. Only the frame's own window is heard.
import type { ContentType, EntryFields } from '@contentworker/domain';
import type { Capability } from '@contentworker/sdk-core/live-preview';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_PREVIEW_GUIDE, SitePane } from '~/cms/components/pane/SitePane';
import { FRAME_CHANNEL } from '~/cms/lib/live-preview/frame-channel';
import { ADMIN_CAPABILITIES, LOAD_MS } from '~/cms/lib/live-preview/host';

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
function pane(
  fields: EntryFields = { title: { 'en-US': 'Home' } },
  locale = 'en-US',
  over: { selected?: string | null; allowed?: readonly Capability[] | null } = {},
) {
  return (
    <SitePane
      spaceId="s1"
      environmentId="main"
      entryId="e1"
      contentType={type}
      fields={fields}
      locale={locale}
      defaultLocale="en-US"
      allowed={over.allowed === null ? undefined : (over.allowed ?? ADMIN_CAPABILITIES)}
      selected={over.selected ?? null}
      split={false}
      onPick={onPick}
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
const ready = () => fromFrame({ type: 'ready', origin: 'https://site.example' });
const status = (s: string, detail?: string) =>
  fromFrame({ type: 'status', status: s, ...(detail ? { detail } : {}) });

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
    expect(screen.getByText('Loading the entry’s page…').getAttribute('role')).toBe('status');
    expect(frame().parentElement?.getAttribute('aria-busy')).toBe('true');
  });

  it('says what the page may do first, then sends the entry and each edit, only to this origin', () => {
    const view = render(pane());
    const spy = spyFrame();
    ready();
    const [first, second] = posted(spy);
    expect(first).toMatchObject({ type: 'view', device: 'desktop', allowed: ADMIN_CAPABILITIES });
    expect(second).toMatchObject({
      type: 'entry',
      entry: { entryId: 'e1', locale: 'en-US', fields: { title: 'Home' } },
      edits: null,
    });
    for (const [, target] of spy.mock.calls) expect(target).toBe(window.location.origin);
    view.rerender(pane({ title: { 'en-US': 'Homepage' } }));
    expect(posted(spy, 'entry')[1]).toMatchObject({
      edits: { fields: { title: 'Homepage' }, blocks: [] },
    });
    // A render with the same values sends nothing.
    view.rerender(pane({ title: { 'en-US': 'Homepage' } }));
    expect(posted(spy, 'entry')).toHaveLength(2);
    expect(screen.getByText('site.example', { exact: false }).textContent).toContain(
      'https://site.example',
    );
  });

  it('a role that may only select says so to the frame', () => {
    render(pane(undefined, undefined, { allowed: ['select', 'scroll'] }));
    const spy = spyFrame();
    ready();
    expect(posted(spy, 'view')[0]).toMatchObject({ allowed: ['select', 'scroll'] });
  });

  it('edits once the page is live, and lets clicks in it be views instead', () => {
    render(pane());
    const spy = spyFrame();
    ready();
    status('live');
    expect(posted(spy, 'view').at(-1)).toMatchObject({ editing: true });
    act(() => screen.getByRole('radio', { name: 'View' }).click());
    expect(posted(spy, 'view').at(-1)).toMatchObject({ editing: false });
    act(() => screen.getByRole('radio', { name: 'Phone, 390 pixels' }).click());
    expect(posted(spy, 'view').at(-1)).toMatchObject({ device: 'phone' });
  });

  it('sends the form’s focused field to be outlined, and none to clear it', () => {
    const view = render(pane());
    const spy = spyFrame();
    ready();
    view.rerender(pane(undefined, undefined, { selected: 'ref-1' }));
    expect(posted(spy, 'select').at(-1)).toMatchObject({ ref: 'ref-1' });
    view.rerender(pane(undefined, undefined, { selected: null }));
    expect(posted(spy, 'select').at(-1)).toMatchObject({ ref: null });
  });

  it('loads another locale’s page afresh when the URL names the locale', () => {
    const view = render(pane());
    const first = frame();
    ready();
    status('live');
    view.rerender(pane({ title: { 'en-US': 'Home', de: 'Start' } }, 'de'));
    expect(frame()).not.toBe(first);
    expect(frame().getAttribute('src')).toBe('/preview-frame/s1/main/e1?locale=de');
    expect(frame().parentElement?.getAttribute('aria-busy')).toBe('true');
    act(() => vi.advanceTimersByTime(LOAD_MS));
    expect(screen.getByRole('alert').textContent).toMatch(/The page didn’t load/);
  });

  it('ignores the channel from any other window or origin', () => {
    render(pane());
    fromFrame({ type: 'status', status: 'not-connected' }, window);
    fromFrame({ type: 'pick', ref: 'r' }, null);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { channel: FRAME_CHANNEL, type: 'status', status: 'failed' },
          origin: 'https://site.example',
          source: frame().contentWindow,
        }),
      );
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('says a page that never offered isn’t connected, links the guide, and still shows it', () => {
    render(pane());
    ready();
    status('not-connected');
    expect(screen.getByRole('alert').textContent).toMatch(
      /This site isn’t connected for live preview/,
    );
    expect(screen.getByRole('link', { name: 'Set up live preview' }).getAttribute('href')).toBe(
      LIVE_PREVIEW_GUIDE,
    );
    // And the screen that prints the page's config and checks it connects.
    expect(screen.getByRole('link', { name: /^Connect a frontend/ }).getAttribute('href')).toBe(
      '/settings/frontend',
    );
    expect(frame()).toBeTruthy();
    expect(
      (screen.getByRole('radio', { name: 'View' }) as HTMLElement).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('says which way a refused SDK is off', () => {
    render(pane());
    status('unsupported', 'old');
    expect(screen.getByRole('alert').textContent).toMatch(/The site’s SDK is too old/);
    cleanup();
    render(pane());
    status('unsupported', 'new');
    expect(screen.getByRole('alert').textContent).toMatch(/The site’s SDK is too new/);
  });

  it('offers the way back from a page that doesn’t show the entry, or moved away', () => {
    render(pane());
    const first = frame();
    status('elsewhere');
    expect(screen.getByRole('alert').textContent).toMatch(/This page doesn’t show this entry/);
    status('navigated');
    expect(screen.getByRole('alert').textContent).toMatch(/moved away from this entry/);
    act(() => screen.getByRole('button', { name: 'Back to the entry' }).click());
    expect(frame()).not.toBe(first);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says an entry the page refused can’t be previewed, and clicks still find their fields', () => {
    render(pane());
    status('unpreviewable');
    expect(screen.getByRole('alert').textContent).toMatch(/can’t be previewed on this page/);
    expect((screen.getByRole('radio', { name: 'Edit' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('says nothing of what the page may do until the person’s access is known, then does', () => {
    const view = render(pane(undefined, undefined, { allowed: null }));
    const spy = spyFrame();
    ready();
    expect(posted(spy, 'view')[0]).not.toHaveProperty('allowed');
    view.rerender(pane());
    expect(posted(spy, 'view').at(-1)).toMatchObject({ allowed: ADMIN_CAPABILITIES });
  });

  it('names both origins when the page offered from another', () => {
    render(pane());
    ready();
    status('origin', 'https://www.site.example');
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
    status('unavailable', 'incomplete');
    expect(screen.getByRole('alert').textContent).toMatch(/no page on the site yet/);
    expect(screen.queryByTitle('Site preview')).toBeNull();
    cleanup();
    render(pane());
    status('unavailable', 'refused');
    expect(screen.getByRole('alert').textContent).toMatch(/Your role can’t make a preview link/);
  });

  it('notes a refused edit quietly, then lets it go', () => {
    render(pane());
    ready();
    status('live');
    fromFrame({ type: 'note', kind: 'gap' });
    expect(screen.getByText(/sent the whole entry again/).getAttribute('role')).toBe('status');
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => vi.advanceTimersByTime(6_000));
    expect(screen.queryByText(/sent the whole entry again/)).toBeNull();
  });

  it('hands on a click with the entries the page reported', () => {
    render(pane());
    fromFrame({ type: 'session', entries: ['e1'], capabilities: ['select'] });
    fromFrame({ type: 'pick', ref: 'the-ref' });
    expect(onPick).toHaveBeenCalledWith('the-ref', ['e1']);
  });
});
