// The admin's half of live preview, as the Site frame runs it: it reads only the framed page's own
// messages (origin, window and session), says when the page never answers or has navigated away,
// and keeps the page in step: an init after hello with an explicit seq, numbered patches, and one
// re-init per refusal, falling back to whole fields when a page refuses again.
import { LIVE_PREVIEW_PROTOCOL, type LivePatchOp } from '@contentworker/sdk-core/live-preview';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameEntry } from '~/cms/lib/live-preview/frame-channel';
import { HANDSHAKE_MS, LivePreviewHost, LOAD_MS } from '~/cms/lib/live-preview/host';

const ORIGIN = 'https://site.example';
const SESSION = 'session_0123456789';

const entry = (title = 'Home', extra: Partial<FrameEntry> = {}): FrameEntry => ({
  fields: { title: { 'en-US': title }, body: { 'en-US': [{ _type: 'hero', _key: 'a' }] } },
  locale: 'en-US',
  version: 3,
  entryId: 'e1',
  contentType: 'page',
  ...extra,
});
const setTitle = (value: string): LivePatchOp[] => [
  { op: 'setField', field: 'title', locale: 'en-US', value },
];

function setup() {
  const frame = { postMessage: vi.fn() };
  const status = vi.fn();
  const onPick = vi.fn();
  const onKey = vi.fn();
  const onNote = vi.fn();
  const onGeometry = vi.fn();
  const onNavigate = vi.fn();
  const host = new LivePreviewHost({
    origin: ORIGIN,
    session: SESSION,
    frame: () => frame,
    onStatus: status,
    onPick,
    onKey,
    onNote,
    onGeometry,
    onNavigate,
  });
  /** A message from the framed page, as its window posts it. */
  const say = (
    type: string,
    body: Record<string, unknown> = {},
    from: Partial<{ origin: string; source: unknown; session: string }> = {},
  ) =>
    host.receive({
      data: { cw: LIVE_PREVIEW_PROTOCOL, session: from.session ?? SESSION, type, ...body },
      origin: from.origin ?? ORIGIN,
      source: 'source' in from ? from.source : frame,
    });
  const hello = () => say('hello', { sdkVersion: '0.2.0', capabilities: ['patch'] });
  /** What the host posted, by type, and that it always named the page's exact origin. */
  const sent = (type?: string) => {
    for (const [, target] of frame.postMessage.mock.calls) expect(target).toBe(ORIGIN);
    return frame.postMessage.mock.calls
      .map(([m]) => m as { type: string; seq?: number; ops?: LivePatchOp[]; session: string })
      .filter((m) => !type || m.type === type);
  };
  return { host, frame, status, onPick, onKey, onNote, onGeometry, onNavigate, say, hello, sent };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the live preview host', () => {
  it('sends the entry after hello, with an explicit seq, and the mode', () => {
    const t = setup();
    t.host.start();
    t.host.setEntry(entry(), null);
    expect(t.sent()).toEqual([]);
    t.hello();
    expect(t.status).toHaveBeenLastCalledWith('live', undefined);
    const [init, mode] = t.sent();
    expect(init).toMatchObject({
      type: 'init',
      session: SESSION,
      entryId: 'e1',
      locale: 'en-US',
      version: 3,
      seq: 0,
    });
    expect(mode).toMatchObject({ type: 'mode', mode: 'view' });
  });

  it('ignores messages from another window, another origin or another session', () => {
    const t = setup();
    t.host.start();
    t.host.setEntry(entry(), null);
    t.say('hello', { sdkVersion: '1', capabilities: [] }, { source: {} });
    t.say('hello', { sdkVersion: '1', capabilities: [] }, { session: 'someone_elses_session' });
    expect(t.sent()).toEqual([]);
    expect(t.status).not.toHaveBeenCalled();
    t.hello();
    t.say('pick', { key: 'a' }, { source: null });
    expect(t.onPick).not.toHaveBeenCalled();
  });

  it('says so when the page answers from another origin, and never reads it', () => {
    const t = setup();
    t.host.start();
    t.say('hello', { sdkVersion: '1', capabilities: [] }, { origin: 'https://www.site.example' });
    expect(t.status).toHaveBeenLastCalledWith('origin', 'https://www.site.example');
    expect(t.sent()).toEqual([]);
  });

  it('times out a loaded page that never says hello, and fails a frame that never loads', () => {
    const t = setup();
    t.host.start();
    t.host.frameLoaded();
    vi.advanceTimersByTime(HANDSHAKE_MS - 1);
    expect(t.status).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(t.status).toHaveBeenLastCalledWith('timeout', undefined);

    const u = setup();
    u.host.start();
    vi.advanceTimersByTime(LOAD_MS);
    expect(u.status).toHaveBeenLastCalledWith('failed', undefined);
  });

  it('takes a hello before the load event as that page’s, and a load without one as navigating away', () => {
    const t = setup();
    t.host.start();
    t.host.setEntry(entry(), null);
    t.hello();
    t.host.frameLoaded();
    vi.advanceTimersByTime(HANDSHAKE_MS);
    expect(t.status).toHaveBeenLastCalledWith('live', undefined);
    // A link followed in view mode: the frame loads another page, which never says hello.
    t.host.frameLoaded();
    t.host.setEntry(entry('Other'), setTitle('Other'));
    expect(t.sent('patch')).toEqual([]);
    vi.advanceTimersByTime(HANDSHAKE_MS);
    expect(t.status).toHaveBeenLastCalledWith('navigated', undefined);
  });

  it('re-sends the whole entry when a page says hello again, keeping the seq', () => {
    const t = setup();
    t.host.start();
    t.host.setEntry(entry(), null);
    t.hello();
    t.host.setEntry(entry('A'), setTitle('A'));
    t.host.setEntry(entry('B'), setTitle('B'));
    t.host.frameLoaded();
    t.hello();
    const inits = t.sent('init');
    expect(inits).toHaveLength(2);
    expect(inits[1]).toMatchObject({ seq: 2, fields: { title: { 'en-US': 'B' } } });
  });

  it('numbers patches, and counts what the page acknowledges even when acks skip seqs', () => {
    const t = setup();
    t.host.start();
    t.host.setEntry(entry(), null);
    t.hello();
    t.host.setEntry(entry('A'), setTitle('A'));
    t.host.setEntry(entry('B'), setTitle('B'));
    t.host.setEntry(entry('C'), setTitle('C'));
    expect(t.sent('patch').map((m) => m.seq)).toEqual([1, 2, 3]);
    t.say('rendered', { seq: 3 });
    expect(t.host.rendered).toBe(3);
    // An ack for a seq never sent is not believed.
    t.say('rendered', { seq: 9 });
    expect(t.host.rendered).toBe(3);
    // No ops, no patch.
    t.host.setEntry(entry('C'), []);
    expect(t.sent('patch')).toHaveLength(3);
  });

  it('sends the whole entry for a new locale or version, or a patch too big to send', () => {
    const t = setup();
    t.host.start();
    t.host.setEntry(entry(), null);
    t.hello();
    t.host.setEntry(entry('Home', { locale: 'de' }), setTitle('x'));
    t.host.setEntry(entry('Home', { locale: 'de', version: 4 }), []);
    const big = Array.from({ length: 101 }, () => setTitle('x')[0] as LivePatchOp);
    t.host.setEntry(entry('Home', { locale: 'de', version: 4 }), big);
    expect(t.sent('init')).toHaveLength(4);
    expect(t.sent('patch')).toEqual([]);
  });

  it('answers a refused patch with one init, and ignores refusals that init already covers', () => {
    const t = setup();
    t.host.start();
    t.host.setEntry(entry(), null);
    t.hello();
    t.host.setEntry(entry('A'), setTitle('A'));
    t.host.setEntry(entry('B'), setTitle('B'));
    t.say('error', { kind: 'patch', message: 'ops[0]: nope', seq: 1 });
    expect(t.onNote).toHaveBeenCalledWith('patch');
    expect(t.sent('init').at(-1)).toMatchObject({ seq: 2, fields: { title: { 'en-US': 'B' } } });
    // The page dropped seq 2 while out of step and says so: the init covers it.
    t.say('error', { kind: 'patch', message: 'out of step', seq: 2 });
    expect(t.sent('init')).toHaveLength(2);
  });

  it('sends blocks fields whole once a page refuses again right after a recovery', () => {
    const t = setup();
    t.host.start();
    t.host.setEntry(entry(), null);
    t.hello();
    const update: LivePatchOp[] = [
      { op: 'update', field: 'body', locale: 'en-US', key: 'a', set: { heading: 'x' } },
    ];
    const withHeading = entry('Home');
    const body = [{ _type: 'hero', _key: 'a', heading: 'x' }];
    t.host.setEntry(
      { ...withHeading, fields: { ...withHeading.fields, body: { 'en-US': body } } },
      update,
    );
    t.say('error', { kind: 'patch', message: 'no', seq: 1 });
    expect(t.host.wholeFields).toBe(false);
    t.host.setEntry(
      { ...withHeading, fields: { ...withHeading.fields, body: { 'en-US': body } } },
      update,
    );
    t.say('error', { kind: 'patch', message: 'no', seq: 2 });
    expect(t.host.wholeFields).toBe(true);
    t.host.setEntry(
      { ...withHeading, fields: { ...withHeading.fields, body: { 'en-US': body } } },
      update,
    );
    expect(t.sent('patch').at(-1)?.ops).toEqual([
      { op: 'setField', field: 'body', locale: 'en-US', value: body },
    ]);
  });

  it('a render error is a note, not a re-init', () => {
    const t = setup();
    t.host.start();
    t.host.setEntry(entry(), null);
    t.hello();
    t.say('error', { kind: 'render', message: 'boom', seq: 0 });
    expect(t.onNote).toHaveBeenCalledWith('render');
    expect(t.sent('init')).toHaveLength(1);
  });

  it('selects what the page picked, there and in the form, and hands on keys and geometry', () => {
    const t = setup();
    t.host.start();
    t.host.setEntry(entry(), null);
    t.hello();
    t.say('pick', { key: 'a' });
    expect(t.onPick).toHaveBeenCalledWith({ key: 'a' });
    expect(t.sent('select').at(-1)).toMatchObject({ key: 'a' });
    t.say('key', { key: 'z', meta: true, ctrl: false, shift: false, alt: false });
    expect(t.onKey).toHaveBeenCalledWith(expect.objectContaining({ key: 'z', meta: true }));
    t.say('geometry', {
      blocks: [{ key: 'a', rect: { x: 0, y: 0, w: 10, h: 10 } }],
      slots: [],
      fields: [],
      scroll: { x: 0, y: 0 },
      viewport: { w: 100, h: 100 },
      docHeight: 100,
      truncated: true,
    });
    expect(t.onGeometry).toHaveBeenCalledWith(expect.objectContaining({ truncated: true }));
    t.host.select(undefined);
    expect(t.sent('select').at(-1)).not.toHaveProperty('key');
  });

  it('follows a page’s link only in edit mode, and only on its own origin', () => {
    const t = setup();
    t.host.start();
    t.host.setEntry(entry(), null);
    t.hello();
    t.say('navigate', { url: `${ORIGIN}/about` });
    expect(t.onNavigate).not.toHaveBeenCalled();
    t.host.setMode('edit');
    expect(t.sent('mode').at(-1)).toMatchObject({ mode: 'edit' });
    t.say('navigate', { url: 'https://elsewhere.example/' });
    t.say('navigate', { url: `${ORIGIN}/about` });
    expect(t.onNavigate).toHaveBeenCalledTimes(1);
    expect(t.onNavigate).toHaveBeenCalledWith(`${ORIGIN}/about`);
  });
});
