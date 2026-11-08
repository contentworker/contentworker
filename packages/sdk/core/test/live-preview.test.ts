// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://site.test/page"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatContentRef } from '../src/content-ref.js';
import { mountInlineEditor } from '../src/inline-edit.js';
import {
  acceptMessage,
  type Capability,
  type ConnectPreviewOptions,
  connectPreview,
  LIVE_PREVIEW_SDK_VERSION,
  type LiveFields,
  type LiveView,
  narrowCapabilities,
  negotiateVersion,
  OFFERED_VERSIONS,
  PAGE_REPORT_LIMIT,
  type PreviewConnection,
  parseFrontendMessage,
  refAttrs,
  slotAttrs,
} from '../src/live-preview.js';

const ADMIN = 'https://admin.test';
const SITE = 'https://site.test';
const ALL: Capability[] = [
  'select',
  'patch.fields',
  'patch.blocks',
  'proposals',
  'scroll',
  'layout',
];

type Posted = { kind: string; [k: string]: unknown };

/**
 * The admin's window, as far as the page can see it: what the page posts arrives as a real
 * MessageEvent, checked and parsed with the same exports the admin imports.
 */
class Host {
  readonly received: Posted[] = [];
  readonly raw: unknown[] = [];
  readonly target = new EventTarget();
  channel: string | undefined;
  version: number | undefined;
  supported = [1];
  allowed: readonly string[] = ALL;

  constructor() {
    this.target.addEventListener('message', (e) => this.onMessage(e as MessageEvent));
  }

  postMessage(data: unknown, targetOrigin: string): void {
    expect(targetOrigin).toBe(ADMIN);
    this.raw.push(data);
    const event = new MessageEvent('message', { data: structuredClone(data), origin: SITE });
    Object.defineProperty(event, 'source', { value: window });
    this.target.dispatchEvent(event);
  }

  private onMessage(e: MessageEvent): void {
    const data = acceptMessage(e, {
      origin: SITE,
      source: window,
      ...(this.channel ? { channel: this.channel } : {}),
      ...(this.version ? { version: this.version } : {}),
    });
    if (!data) return;
    const parsed = parseFrontendMessage(data);
    if (!parsed.ok) return;
    this.received.push(parsed.message as unknown as Posted);
  }

  of(kind: string): Posted[] {
    return this.received.filter((m) => m.kind === kind);
  }

  /** Answers the last offer as the admin would. */
  answer(): void {
    const offer = this.of('connect.offer').at(-1) as Posted & {
      channel: string;
      versions: number[];
      capabilities: string[];
    };
    const version = negotiateVersion(offer.versions, this.supported);
    this.channel = offer.channel;
    if (version === undefined) {
      this.send(
        { kind: 'connect.reject', reason: 'unsupported-version', versions: this.supported },
        1,
      );
      return;
    }
    this.version = version;
    this.send({
      kind: 'connect.accept',
      version,
      capabilities: narrowCapabilities(offer.capabilities, this.allowed),
    });
  }

  send(
    body: Record<string, unknown>,
    v = this.version,
    from: { origin?: string; source?: unknown; channel?: string } = {},
  ): void {
    const event = new MessageEvent('message', {
      data: { v, channel: from.channel ?? this.channel, ...body },
      origin: from.origin ?? ADMIN,
    });
    Object.defineProperty(event, 'source', { value: 'source' in from ? from.source : host });
    window.dispatchEvent(event);
  }
}

let host: Host;
let frames: Map<number, FrameRequestCallback>;
let preview: PreviewConnection | undefined;
const states: { entryId: string; locale: string; fields: LiveFields; view: LiveView }[] = [];

function flushFrames(): void {
  const due = [...frames.values()];
  frames.clear();
  for (const cb of due) cb(0);
}
const settle = () => new Promise((r) => setTimeout(r, 0));

function start(over: Partial<ConnectPreviewOptions> = {}): PreviewConnection {
  preview = connectPreview({
    adminOrigin: ADMIN,
    capabilities: ALL,
    onState: (entryId, locale, fields, view) => {
      states.push({ entryId, locale, fields, view });
    },
    ...over,
  });
  return preview;
}

async function connected(over: Partial<ConnectPreviewOptions> = {}): Promise<PreviewConnection> {
  const p = start(over);
  host.answer();
  await settle();
  return p;
}

const at = { entryId: 'e1', locale: 'en-US' };
const state = (rev: number, fields: LiveFields = { title: 'Home' }) => ({
  kind: 'entry.state',
  rev,
  ...at,
  fields,
});

beforeEach(() => {
  host = new Host();
  Object.defineProperty(window, 'parent', { value: host, configurable: true });
  frames = new Map();
  let next = 1;
  window.requestAnimationFrame = (cb) => {
    frames.set(next, cb);
    return next++;
  };
  window.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };
  window.history.replaceState(null, '', '/page');
  document.body.innerHTML = '';
  states.length = 0;
});

afterEach(() => {
  preview?.close();
  preview = undefined;
  vi.useRealTimers();
  Object.defineProperty(window, 'parent', { value: window, configurable: true });
});

describe('connecting', () => {
  it('does nothing when the page is not framed, or not configured', () => {
    Object.defineProperty(window, 'parent', { value: window, configurable: true });
    expect(start().active).toBe(false);
    Object.defineProperty(window, 'parent', { value: host, configurable: true });
    expect(start({ adminOrigin: undefined }).active).toBe(false);
    expect(host.raw).toEqual([]);
  });

  it('refuses an admin origin that is not exact, or is the page’s own', () => {
    for (const adminOrigin of ['*', 'null', `${ADMIN}/`, 'http://admin.test']) {
      expect(() => start({ adminOrigin })).toThrow(/exact https origin/);
    }
    expect(() => start({ adminOrigin: SITE })).toThrow(/must differ/);
  });

  it('offers its versions, capabilities, a fresh channel and its SDK, to the admin origin only', () => {
    start({ capabilities: ['select', 'scroll'] });
    const [offer] = host.of('connect.offer');
    expect(offer).toMatchObject({
      v: OFFERED_VERSIONS[0],
      versions: OFFERED_VERSIONS,
      capabilities: ['select', 'scroll'],
      sdk: { name: '@contentworker/sdk', version: LIVE_PREVIEW_SDK_VERSION },
    });
    expect(offer?.channel).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('resends the offer up to three times, a second apart, then stops', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    start();
    vi.advanceTimersByTime(10_000);
    expect(host.of('connect.offer')).toHaveLength(4);
  });

  it('stops offering once accepted, and takes only what it offered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const p = start({ capabilities: ['select'] });
    host.allowed = ALL;
    host.answer();
    vi.advanceTimersByTime(10_000);
    expect(host.of('connect.offer')).toHaveLength(1);
    expect(p.connected).toBe(true);
    expect(p.capabilities).toEqual(['select']);
  });

  it('never widens what the admin accepted beyond the offer, even when told to', async () => {
    const p = start({ capabilities: ['select'] });
    host.channel = host.of('connect.offer')[0]?.channel as string;
    host.version = 1;
    host.send({ kind: 'connect.accept', version: 1, capabilities: ALL });
    expect(p.capabilities).toEqual(['select']);
  });

  it('logs one actionable error naming both version lists when rejected', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rejected = vi.fn();
    const p = start();
    p.on('reject', rejected);
    host.supported = [7, 8];
    host.answer();
    expect(p.connected).toBe(false);
    expect(rejected).toHaveBeenCalledWith({ reason: 'unsupported-version', versions: [7, 8] });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toMatch(/\[7, 8\].*\[1\]/);
    error.mockRestore();
  });

  it('ignores a message from another origin, window or channel', async () => {
    await connected();
    host.send(state(0), 1, { origin: 'https://evil.test' });
    host.send(state(0), 1, { source: window });
    host.send(state(0), 1, { channel: 'BBBBBBBBBBBBBBBBBBBBBB' });
    host.send(state(0), 2);
    await settle();
    expect(states).toEqual([]);
  });

  it('reports at most PAGE_REPORT_LIMIT entries, the first the site lists', async () => {
    const p = start();
    host.answer();
    const entries = Array.from({ length: PAGE_REPORT_LIMIT + 10 }, (_, i) => ({
      entryId: `e${i}`,
      contentType: 'landing',
      locale: 'en-US',
    }));
    p.emit('page', { url: `${SITE}/page`, entries });
    const [sent] = host.of('page') as { entries: { entryId: string }[] }[];
    expect(sent?.entries).toHaveLength(PAGE_REPORT_LIMIT);
    expect(sent?.entries[0]?.entryId).toBe('e0');
  });

  it('reports the page once connected, if the app said what it renders first', async () => {
    const p = start();
    p.emit('page', {
      url: `${SITE}/page`,
      entries: [{ entryId: 'e1', contentType: 'landing', locale: 'en-US' }],
    });
    expect(host.of('page')).toEqual([]);
    host.answer();
    expect(host.of('page')).toEqual([
      expect.objectContaining({
        url: `${SITE}/page`,
        entries: [{ entryId: 'e1', contentType: 'landing', locale: 'en-US' }],
      }),
    ]);
  });
});

describe('two windows, from connect to applied', () => {
  it('renders the state, then each patch in order, acknowledging each rev', async () => {
    await connected();
    host.send(state(0, { title: 'Home', rich: { nodeType: 'document', content: [] } }));
    await settle();
    host.send({ kind: 'entry.patch', rev: 1, ...at, fields: { title: 'Hello', rich: null } });
    await settle();
    expect(states.map((s) => s.fields)).toEqual([
      { title: 'Home', rich: { nodeType: 'document', content: [] } },
      { title: 'Hello' },
    ]);
    expect(host.of('applied')).toEqual([
      expect.objectContaining({ rev: 0, entryId: 'e1' }),
      expect.objectContaining({ rev: 1, entryId: 'e1' }),
    ]);
  });

  it('answers a gap with failed, and starts over from a fresh state', async () => {
    await connected();
    host.send(state(0));
    await settle();
    host.send({ kind: 'entry.patch', rev: 2, ...at, fields: { title: 'Skipped one' } });
    host.send({
      kind: 'entry.patch',
      rev: 1,
      ...at,
      fields: { title: 'Wrong locale' },
      locale: 'de-DE',
    });
    host.send({ kind: 'entry.patch', rev: 1, entryId: 'unknown', locale: 'en-US', fields: {} });
    await settle();
    expect(host.of('failed').map((m) => [m.rev, m.reason])).toEqual([
      [2, 'gap'],
      [1, 'gap'],
      [1, 'gap'],
    ]);
    host.send(state(5, { title: 'Fresh' }));
    host.send({ kind: 'entry.patch', rev: 6, ...at, fields: { title: 'Again' } });
    await settle();
    expect(states.at(-1)?.fields).toEqual({ title: 'Again' });
    expect(host.of('applied').at(-1)).toMatchObject({ rev: 6 });
  });

  it('refuses a patch it could not read, and rich text turned into a string of HTML', async () => {
    const p = await connected();
    host.send(state(0, { body: { nodeType: 'document', content: [] } }));
    await settle();
    host.send({ kind: 'entry.patch', rev: 1, ...at, fields: { body: '<p>Hi</p>' } });
    host.send({ kind: 'entry.patch', rev: 1, ...at, fields: JSON.parse('{"__proto__":{"x":1}}') });
    await settle();
    expect(host.of('failed').map((m) => [m.rev, m.reason])).toEqual([
      [1, 'invalid'],
      [1, 'invalid'],
    ]);
    expect(states).toHaveLength(1);
    expect(p.dropped).toBe(2);
    expect(({} as { x?: unknown }).x).toBeUndefined();
  });

  it('acknowledges nothing a failed render held, and the next render covers it', async () => {
    let fail = false;
    await connected({
      onState: () => {
        if (fail) throw new Error('render failed');
      },
    });
    host.send(state(0));
    await settle();
    fail = true;
    host.send({ kind: 'entry.patch', rev: 1, ...at, fields: { title: 'One' } });
    await settle();
    fail = false;
    host.send({ kind: 'entry.patch', rev: 2, ...at, fields: { title: 'Two' } });
    await settle();
    expect(host.of('applied').map((m) => m.rev)).toEqual([0, 2]);
    expect(host.of('failed')).toEqual([expect.objectContaining({ rev: 1, reason: 'render' })]);
  });

  it('refuses a message needing a capability the page did not offer', async () => {
    const p = await connected({ capabilities: ['select', 'patch.fields'] });
    host.send(state(0, { body: [] }));
    await settle();
    host.send({
      kind: 'blocks.patch',
      rev: 1,
      ...at,
      field: 'body',
      ops: [{ op: 'insert', block: { _type: 'cta', _key: 'c1' } }],
    });
    host.send({ kind: 'scroll', ref: 'r' });
    await settle();
    expect(states).toHaveLength(1);
    expect(p.dropped).toBe(2);
    expect(host.of('failed')).toEqual([]);
  });

  it('ignores a kind it does not speak, without counting it', async () => {
    const p = await connected();
    host.send({ kind: 'resize', height: 900 });
    expect(p.dropped).toBe(0);
  });
});

describe('blocks and proposals', () => {
  const body = () => [
    { _type: 'hero', _key: 'h1', heading: 'Welcome' },
    { _type: 'cta', _key: 'c1', label: 'Sign up' },
  ];
  const keys = (value: unknown) => (value as { _key: string }[]).map((b) => b._key);

  it('applies real ops to the fields', async () => {
    await connected();
    host.send(state(0, { body: body() }));
    host.send({
      kind: 'blocks.patch',
      rev: 1,
      ...at,
      field: 'body',
      ops: [{ op: 'move', key: 'c1', to: { index: 0 } }],
    });
    await settle();
    expect(keys(states.at(-1)?.fields.body)).toEqual(['c1', 'h1']);
  });

  it('answers an op it can’t place with failed: conflict, changing nothing', async () => {
    await connected();
    host.send(state(0, { body: body() }));
    host.send({
      kind: 'blocks.patch',
      rev: 1,
      ...at,
      field: 'body',
      ops: [{ op: 'remove', key: 'nope' }],
    });
    await settle();
    expect(host.of('failed')).toEqual([expect.objectContaining({ rev: 1, reason: 'conflict' })]);
    expect(states).toHaveLength(1);
  });

  it('renders a proposal as a ghost, never in the fields, until it is taken back', async () => {
    await connected();
    host.send(state(0, { body: body() }));
    host.send({
      kind: 'blocks.patch',
      rev: 1,
      ...at,
      field: 'body',
      ops: [
        {
          op: 'insert',
          after: 'h1',
          block: { _type: 'cta', _key: 'g1', label: 'Proposed' },
          proposed: true,
        },
        { op: 'update', key: 'h1', set: { heading: 'Proposed heading' }, proposed: true },
        { op: 'remove', key: 'c1', proposed: true },
      ],
    });
    await settle();
    const last = states.at(-1);
    expect(keys(last?.fields.body)).toEqual(['h1', 'c1']);
    expect(((last?.fields.body ?? []) as { heading?: string }[])[0]?.heading).toBe('Welcome');
    expect(keys(last?.view.withProposals.body)).toEqual(['h1', 'g1', 'c1']);
    expect(last?.view.ghosts).toEqual({ inserted: ['g1'], changed: ['h1'], removed: ['c1'] });

    host.send({
      kind: 'blocks.patch',
      rev: 2,
      ...at,
      field: 'body',
      ops: [{ op: 'remove', key: 'g1', proposed: true }],
    });
    await settle();
    expect(keys(states.at(-1)?.view.withProposals.body)).toEqual(['h1', 'c1']);
    expect(states.at(-1)?.view.ghosts.inserted).toEqual([]);
  });

  it('drops a proposal the real edits overtook, and a fresh state clears them all', async () => {
    await connected();
    host.send(state(0, { body: body() }));
    host.send({
      kind: 'blocks.patch',
      rev: 1,
      ...at,
      field: 'body',
      ops: [{ op: 'insert', block: { _type: 'cta', _key: 'g1' }, proposed: true }],
    });
    // Accepted: the admin sends the same block as a real insert.
    host.send({
      kind: 'blocks.patch',
      rev: 2,
      ...at,
      field: 'body',
      ops: [{ op: 'insert', block: { _type: 'cta', _key: 'g1' } }],
    });
    await settle();
    expect(keys(states.at(-1)?.fields.body)).toEqual(['h1', 'c1', 'g1']);
    expect(states.at(-1)?.view.ghosts.inserted).toEqual([]);
    host.send({
      kind: 'blocks.patch',
      rev: 3,
      ...at,
      field: 'body',
      ops: [{ op: 'insert', block: { _type: 'cta', _key: 'g2' }, proposed: true }],
    });
    host.send(state(9, { body: body() }));
    await settle();
    expect(states.at(-1)?.view.ghosts.inserted).toEqual([]);
  });

  it('needs proposals to propose', async () => {
    const p = await connected({ capabilities: ['patch.blocks'] });
    host.send(state(0, { body: body() }));
    host.send({
      kind: 'blocks.patch',
      rev: 1,
      ...at,
      field: 'body',
      ops: [{ op: 'remove', key: 'c1', proposed: true }],
    });
    await settle();
    expect(p.dropped).toBe(1);
  });
});

/** A slot holding two blocks, the first with a heading field. */
function mountPage() {
  const ref = (field: string) => ({
    space: 's',
    environment: 'main',
    entryId: 'e1',
    contentType: 'landing',
    field,
    locale: 'en-US',
  });
  const slot = document.createElement('main');
  for (const [k, v] of Object.entries(slotAttrs(ref('body')))) slot.setAttribute(k, v);
  const a = document.createElement('section');
  for (const [k, v] of Object.entries(refAttrs(ref('body[h1]')))) a.setAttribute(k, v);
  const h = document.createElement('h1');
  h.setAttribute('data-cw-ref', formatContentRef(ref('body[h1].heading')));
  a.appendChild(h);
  const b = document.createElement('section');
  b.setAttribute('data-cw-ref', formatContentRef(ref('body[c1]')));
  slot.append(a, b);
  document.body.appendChild(slot);
  const box = (el: Element, x: number, y: number, w: number, hh: number) => {
    (el as HTMLElement).getBoundingClientRect = () =>
      ({ left: x, top: y, width: w, height: hh, x, y, right: x + w, bottom: y + hh }) as DOMRect;
  };
  box(slot, 0, 0, 800, 400);
  box(a, 0, 10, 800, 100);
  box(h, 20, 20, 300, 40);
  box(b, 0, 130, 800, 100);
  return { slot, a, h, b, ref };
}

describe('pointer, select and scroll', () => {
  it('turns a click on a marked element into pointer, with its box, and the page never sees it', async () => {
    const { h } = mountPage();
    const pageHandler = vi.fn();
    h.addEventListener('click', pageHandler);
    await connected();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    h.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(pageHandler).not.toHaveBeenCalled();
    expect(host.of('pointer')).toEqual([
      expect.objectContaining({
        pointer: 'click',
        ref: h.getAttribute('data-cw-ref'),
        rect: { x: 20, y: 20, w: 300, h: 40 },
      }),
    ]);
  });

  it('sends hover at most once a frame, and a clear when the pointer leaves', async () => {
    const { h, b } = mountPage();
    await connected();
    h.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }));
    b.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }));
    flushFrames();
    b.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }));
    document.documentElement.dispatchEvent(new MouseEvent('pointerleave'));
    flushFrames();
    expect(host.of('pointer').map((m) => m.ref)).toEqual([b.getAttribute('data-cw-ref'), null]);
  });

  it('leaves the page alone while the admin has editing off', async () => {
    const { h } = mountPage();
    await connected();
    host.send({ kind: 'editing', on: false });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    h.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(host.of('pointer').filter((m) => m.pointer === 'click')).toEqual([]);
  });

  it('passes select on, and scrolls a ref into view', async () => {
    const { b } = mountPage();
    b.scrollIntoView = vi.fn();
    const p = await connected();
    const selected = vi.fn();
    p.on('select', selected);
    host.send({ kind: 'select', ref: 'r1' });
    host.send({ kind: 'select', ref: null });
    host.send({ kind: 'scroll', ref: b.getAttribute('data-cw-ref') });
    expect(selected.mock.calls).toEqual([['r1'], [null]]);
    expect(b.scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'center' }));
  });

  it('lands a ref at the top or the bottom, clear of an inset, when the admin asks', async () => {
    const { b } = mountPage();
    b.scrollIntoView = vi.fn();
    const scrollBy = vi.fn();
    window.scrollBy = scrollBy as unknown as typeof window.scrollBy;
    await connected();
    const ref = b.getAttribute('data-cw-ref');
    host.send({ kind: 'scroll', ref, align: 'end', inset: 180 });
    expect(b.scrollIntoView).toHaveBeenLastCalledWith(expect.objectContaining({ block: 'end' }));
    expect(scrollBy).toHaveBeenLastCalledWith({ top: 180, behavior: 'auto' });
    host.send({ kind: 'scroll', ref, align: 'start', inset: 24 });
    expect(b.scrollIntoView).toHaveBeenLastCalledWith(expect.objectContaining({ block: 'start' }));
    expect(scrollBy).toHaveBeenLastCalledWith({ top: -24, behavior: 'auto' });
    // A bad align or inset drops the message whole.
    const calls = (b.scrollIntoView as ReturnType<typeof vi.fn>).mock.calls.length;
    host.send({ kind: 'scroll', ref, align: 'middle' });
    host.send({ kind: 'scroll', ref, align: 'end', inset: -1 });
    host.send({ kind: 'scroll', ref, align: 'end', inset: 1e9 });
    host.send({ kind: 'scroll', ref, align: 'end', inset: '10' });
    expect((b.scrollIntoView as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
  });
});

describe('navigation', () => {
  it('lets the page follow its own links, and names where it went before unloading', async () => {
    mountPage();
    const link = document.createElement('a');
    link.href = '/about';
    document.body.appendChild(link);
    await connected();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    window.dispatchEvent(new Event('pagehide'));
    expect(host.of('navigated')).toEqual([expect.objectContaining({ url: `${SITE}/about` })]);
  });

  it('forgets a link the page’s own router took over', async () => {
    const link = document.createElement('a');
    link.href = '/routed';
    document.body.appendChild(link);
    link.addEventListener('click', (e) => e.preventDefault());
    await connected();
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    window.dispatchEvent(new Event('pagehide'));
    expect(host.of('navigated')).toEqual([expect.objectContaining({ url: `${SITE}/page` })]);
  });

  it('resolves a relative URL from the router', async () => {
    const p = await connected();
    p.emit('navigated', { url: '/next?x=1' });
    expect(host.of('navigated')).toEqual([expect.objectContaining({ url: `${SITE}/next?x=1` })]);
  });

  it('connects again on a new channel after client-side navigation', async () => {
    const p = await connected();
    const first = host.channel;
    window.history.pushState(null, '', '/next');
    p.emit('navigated', { url: `${SITE}/next` });
    expect(host.of('navigated')).toEqual([expect.objectContaining({ url: `${SITE}/next` })]);
    expect(p.connected).toBe(false);
    // The host, still pinned to the old channel, drops the new offer: read what was posted.
    const offer = host.raw.at(-1) as Posted;
    expect(offer.kind).toBe('connect.offer');
    expect(offer.channel).not.toBe(first);
  });
});

describe('the inline editor, when the channel is connected', () => {
  it('hides its toggle, draws nothing, and follows the admin’s editing switch', async () => {
    const { h } = mountPage();
    const onEdit = vi.fn();
    const editor = mountInlineEditor({ onEdit });
    const toggle = document.querySelector<HTMLButtonElement>('.cw-ie-toggle');
    expect(toggle?.hidden).toBe(false);
    await connected();
    expect(toggle?.hidden).toBe(true);
    expect(editor.enabled).toBe(true);
    h.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    // The click went to the admin as pointer, not to the overlay's own handler.
    expect(onEdit).not.toHaveBeenCalled();
    expect(host.of('pointer')).toHaveLength(1);
    host.send({ kind: 'editing', on: false });
    expect(editor.enabled).toBe(false);
    preview?.close();
    expect(toggle?.hidden).toBe(false);
    editor.destroy();
  });
});

describe('layout (extension)', () => {
  it('reports blocks, slots with their seams, and fields, by ref', async () => {
    const { ref } = mountPage();
    await connected();
    host.send(state(0));
    await settle();
    flushFrames();
    const [layout] = host.of('layout');
    expect(layout?.blocks).toEqual([
      { ref: formatContentRef(ref('body[h1]')), rect: { x: 0, y: 10, w: 800, h: 100 } },
      { ref: formatContentRef(ref('body[c1]')), rect: { x: 0, y: 130, w: 800, h: 100 } },
    ]);
    expect(layout?.fields).toEqual([
      { ref: formatContentRef(ref('body[h1].heading')), rect: { x: 20, y: 20, w: 300, h: 40 } },
    ]);
    const [slot] = (layout?.slots ?? []) as {
      ref: string;
      gaps: { index: number; after?: string; before?: string }[];
    }[];
    expect(slot?.ref).toBe(formatContentRef(ref('body')));
    expect(slot?.gaps.map((g) => [g.index, g.after, g.before])).toEqual([
      [0, undefined, 'h1'],
      [1, 'h1', 'c1'],
      [2, 'c1', undefined],
    ]);
  });

  it('sends none without the layout capability', async () => {
    mountPage();
    await connected({ capabilities: ['select', 'patch.fields'] });
    host.send(state(0));
    await settle();
    flushFrames();
    expect(host.of('layout')).toEqual([]);
  });
});

describe('close', () => {
  it('removes every listener, and posts nothing after', async () => {
    const { h } = mountPage();
    const p = await connected();
    p.close();
    const count = host.raw.length;
    host.send(state(0));
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    h.dispatchEvent(click);
    window.dispatchEvent(new Event('scroll'));
    await settle();
    flushFrames();
    expect(click.defaultPrevented).toBe(false);
    expect(states).toEqual([]);
    expect(host.raw).toHaveLength(count);
  });
});

describe('found in review', () => {
  const body = () => [
    { _type: 'hero', _key: 'h1', heading: 'Welcome' },
    { _type: 'cta', _key: 'c1', label: 'Sign up' },
  ];
  const keys = (value: unknown) => ((value ?? []) as { _key: string }[]).map((b) => b._key);

  it('never runs two onState calls for one entry at once, even across a fresh state', async () => {
    let running = 0;
    let most = 0;
    const releases: (() => void)[] = [];
    await connected({
      onState: async (_id, _locale, fields) => {
        running += 1;
        most = Math.max(most, running);
        states.push({ entryId: 'e1', locale: 'en-US', fields, view: undefined as never });
        await new Promise<void>((r) => releases.push(r));
        running -= 1;
      },
    });
    host.send(state(0, { title: 'Old' }));
    await settle();
    host.send(state(9, { title: 'Fresh' }));
    await settle();
    expect(running).toBe(1);
    releases.shift()?.();
    await settle();
    releases.shift()?.();
    await settle();
    expect(most).toBe(1);
    expect(states.map((s) => s.fields.title)).toEqual(['Old', 'Fresh']);
    // The superseded render acknowledges nothing; the fresh one does.
    expect(host.of('applied').map((m) => m.rev)).toEqual([9]);
  });

  it('gives the inline editor back its own setting when the session ends', async () => {
    mountPage();
    const editor = mountInlineEditor({ onEdit: () => {} });
    expect(editor.enabled).toBe(false);
    const p = await connected();
    expect(editor.enabled).toBe(true);
    p.close();
    expect(editor.enabled).toBe(false);
    editor.destroy();
  });

  it('keeps the inline editor stood down while another connection is still live', async () => {
    const editor = mountInlineEditor({ onEdit: () => {} });
    const first = await connected();
    const second = connectPreview({ adminOrigin: ADMIN, capabilities: ALL, onState: () => {} });
    const offer = host.raw.at(-1) as Posted;
    host.send({ kind: 'connect.accept', version: 1, capabilities: ALL }, 1, {
      channel: offer.channel as string,
    });
    expect(second.connected).toBe(true);
    first.close();
    expect(document.querySelector<HTMLButtonElement>('.cw-ie-toggle')?.hidden).toBe(true);
    second.close();
    expect(document.querySelector<HTMLButtonElement>('.cw-ie-toggle')?.hidden).toBe(false);
    editor.destroy();
  });

  it('tells its handlers the session ended, and gives the new one the layout again', async () => {
    mountPage();
    const p = await connected();
    host.send(state(0));
    await settle();
    flushFrames();
    expect(host.of('layout')).toHaveLength(1);
    const ended = vi.fn();
    p.on('disconnect', ended);
    p.emit('navigated', { url: `${SITE}/again` });
    expect(ended).toHaveBeenCalledTimes(1);
    // The pinned host dropped the new offer; answer it from what was posted.
    const offer = host.raw.at(-1) as Posted;
    host.channel = offer.channel as string;
    host.received.length = 0;
    host.send({ kind: 'connect.accept', version: 1, capabilities: ALL });
    flushFrames();
    expect(host.of('layout')).toHaveLength(1);
  });

  it('logs one error however many rejects arrive', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    start();
    host.supported = [7];
    host.answer();
    host.answer();
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('lays a proposal inside another proposal of the same patch, by ref', async () => {
    await connected();
    host.send(state(0, { body: body() }));
    host.send({
      kind: 'blocks.patch',
      rev: 1,
      ...at,
      field: 'body',
      ops: [
        { op: 'insert', ref: 'r1', block: { _type: 'section', _key: 's9' }, proposed: true },
        {
          op: 'insert',
          parent: { key: 'r1', slot: 'items' },
          block: { _type: 'cta', _key: 'g9' },
          proposed: true,
        },
      ],
    });
    await settle();
    const view = states.at(-1)?.view;
    expect(view?.ghosts.inserted).toEqual(['s9', 'g9']);
    const section = ((view?.withProposals.body ?? []) as { _key: string; items?: unknown }[]).find(
      (b) => b._key === 's9',
    );
    expect(keys(section?.items)).toEqual(['g9']);
  });

  it('refuses a proposed insert that leaves a block to be keyed on the page', async () => {
    await connected();
    host.send(state(0, { body: body() }));
    host.send({
      kind: 'blocks.patch',
      rev: 1,
      ...at,
      field: 'body',
      ops: [
        {
          op: 'insert',
          block: { _type: 'section', _key: 's9', items: [{ _type: 'cta' }] },
          proposed: true,
        },
      ],
    });
    await settle();
    expect(host.of('failed')).toEqual([expect.objectContaining({ rev: 1, reason: 'invalid' })]);
  });

  it('takes back what was proposed inside or beside a block taken back', async () => {
    await connected();
    host.send(state(0, { body: body() }));
    host.send({
      kind: 'blocks.patch',
      rev: 1,
      ...at,
      field: 'body',
      ops: [
        { op: 'insert', block: { _type: 'section', _key: 's9' }, proposed: true },
        {
          op: 'insert',
          parent: { key: 's9', slot: 'items' },
          block: { _type: 'cta', _key: 'g9' },
          proposed: true,
        },
        { op: 'remove', key: 's9', proposed: true },
      ],
    });
    // The same key proposed again starts empty.
    host.send({
      kind: 'blocks.patch',
      rev: 2,
      ...at,
      field: 'body',
      ops: [{ op: 'insert', block: { _type: 'section', _key: 's9' }, proposed: true }],
    });
    await settle();
    expect(states.at(-1)?.view.ghosts.inserted).toEqual(['s9']);
  });

  it('lists no proposed removal of a block the real edits already removed', async () => {
    await connected();
    host.send(state(0, { body: body() }));
    host.send({
      kind: 'blocks.patch',
      rev: 1,
      ...at,
      field: 'body',
      ops: [{ op: 'remove', key: 'c1', proposed: true }],
    });
    host.send({
      kind: 'blocks.patch',
      rev: 2,
      ...at,
      field: 'body',
      ops: [{ op: 'remove', key: 'c1' }],
    });
    await settle();
    expect(states.at(-1)?.view.ghosts.removed).toEqual([]);
  });

  it('caps the proposals one entry holds', async () => {
    await connected();
    host.send(state(0, { body: body() }));
    for (let rev = 1; rev <= 3; rev++) {
      const ops = Array.from({ length: 100 }, (_, i) => ({
        op: 'update',
        key: 'h1',
        set: { heading: `${rev}.${i}` },
        proposed: true,
      }));
      host.send({ kind: 'blocks.patch', rev, ...at, field: 'body', ops });
    }
    await settle();
    expect(host.of('failed')).toEqual([expect.objectContaining({ rev: 3, reason: 'conflict' })]);
  });

  it('answers a state it could not read, so the admin needn’t wait on it', async () => {
    await connected();
    host.send(state(0, { numbers: Array.from({ length: 20_000 }, (_, i) => i) }));
    await settle();
    expect(host.of('failed')).toEqual([expect.objectContaining({ rev: 0, reason: 'invalid' })]);
    expect(states).toEqual([]);
  });

  it('puts a block in a slot’s seams only when its path names that slot', async () => {
    const { slot, ref } = mountPage();
    const stray = document.createElement('section');
    stray.setAttribute('data-cw-ref', formatContentRef({ ...ref('body[x1]'), entryId: 'other' }));
    slot.appendChild(stray);
    await connected();
    host.send(state(0));
    await settle();
    flushFrames();
    const [layout] = host.of('layout');
    const gaps = ((layout?.slots ?? []) as { gaps: { before?: string }[] }[])[0]?.gaps ?? [];
    expect(gaps.map((g) => g.before)).toEqual(['h1', 'c1', undefined]);
  });

  it('skips a block or field the admin could not read, rather than losing the whole layout', async () => {
    const { slot, ref } = mountPage();
    const bad = document.createElement('section');
    bad.setAttribute('data-cw-ref', formatContentRef(ref('body[constructor]')));
    const broken = document.createElement('p');
    broken.setAttribute('data-cw-ref', 's|main|e1|landing|%E0|en-US');
    slot.append(bad, broken);
    await connected();
    host.send(state(0));
    await settle();
    flushFrames();
    expect(host.of('layout')).toHaveLength(1);
  });

  it('reports only the page entries the admin can read', () => {
    const p = start();
    p.emit('page', {
      url: `${SITE}/page`,
      entries: [
        { entryId: 'e1', contentType: 'landing', locale: 'en-US' },
        { entryId: '', contentType: 'landing', locale: 'en-US' },
        { entryId: 'e2', contentType: 'constructor', locale: 'en-US' },
      ],
    });
    host.answer();
    expect(host.of('page')[0]?.entries).toEqual([
      { entryId: 'e1', contentType: 'landing', locale: 'en-US' },
    ]);
  });
});
