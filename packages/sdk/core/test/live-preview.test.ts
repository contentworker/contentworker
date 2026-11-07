// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fitGeometry } from '../src/live-preview/guest.js';
import {
  applyLivePatch,
  blockAttrs,
  LIVE_PREVIEW_SDK_VERSION,
  type LiveFields,
  type LivePreview,
  type LivePreviewOptions,
  MAX_MESSAGE_BYTES,
  parseAdminMessage,
  parseGuestMessage,
  slotAttrs,
  startLivePreview,
} from '../src/live-preview.js';

const ADMIN = 'https://admin.test';
const SESSION = 'sess_0123456789';
// The admin's view of the frame, for the page-message parser.
const PAGE = 'https://site.test';
const FRAME = { frame: true };
const guest = { session: SESSION, origin: PAGE, source: FRAME };

type Posted = { type: string; [k: string]: unknown };

let parent: { postMessage: ReturnType<typeof vi.fn> };
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let preview: LivePreview | undefined;

/** Runs every queued animation frame, as the browser would on its next paint. */
function flushFrames(): void {
  const due = [...frames.values()];
  frames.clear();
  for (const cb of due) cb(0);
}

/** Lets the MutationObserver deliver, then paints. */
async function paint(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  flushFrames();
}

function posted(type?: string): Posted[] {
  const all = parent.postMessage.mock.calls.map(([m]) => m as Posted);
  return type ? all.filter((m) => m.type === type) : all;
}

function send(data: unknown, from: { origin?: string; source?: unknown } = {}): void {
  const event = new MessageEvent('message', { data, origin: from.origin ?? ADMIN });
  Object.defineProperty(event, 'source', { value: 'source' in from ? from.source : parent });
  window.dispatchEvent(event);
}

const msg = (type: string, body: Record<string, unknown> = {}) => ({
  cw: 1,
  session: SESSION,
  type,
  ...body,
});

const page = (): LiveFields => ({
  title: { 'en-US': 'Home' },
  body: {
    'en-US': [
      { _type: 'hero', _key: 'h1', heading: 'Welcome' },
      { _type: 'cta', _key: 'c1', label: 'Sign up' },
    ],
  },
});

const init = (extra: Record<string, unknown> = {}) =>
  msg('init', {
    fields: page(),
    locale: 'en-US',
    version: 3,
    entryId: 'e1',
    contentType: 'landing',
    ...extra,
  });

function start(over: Partial<LivePreviewOptions> = {}): LivePreview {
  preview = startLivePreview({ adminOrigin: ADMIN, onChange: () => {}, ...over });
  return preview;
}

function rect(el: Element, x: number, y: number, w: number, h: number): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({ left: x, top: y, width: w, height: h, x, y, right: x + w, bottom: y + h }) as DOMRect;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  parent = { postMessage: vi.fn() };
  Object.defineProperty(window, 'parent', { value: parent, configurable: true });
  frames = new Map();
  nextFrame = 1;
  window.requestAnimationFrame = (cb) => {
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };
  window.history.replaceState(null, '', `/page?cw_session=${SESSION}`);
  document.body.innerHTML = '';
});

afterEach(() => {
  preview?.destroy();
  preview = undefined;
  Object.defineProperty(window, 'parent', { value: window, configurable: true });
});

describe('activation', () => {
  it('is inert outside a frame', () => {
    Object.defineProperty(window, 'parent', { value: window, configurable: true });
    const onChange = vi.fn();
    expect(start({ onChange }).active).toBe(false);
    expect(parent.postMessage).not.toHaveBeenCalled();
  });

  it('is inert without a session on the URL, or with a malformed one', () => {
    window.history.replaceState(null, '', '/page');
    expect(start().active).toBe(false);
    window.history.replaceState(null, '', '/page?cw_session=<script>');
    expect(start().active).toBe(false);
    expect(parent.postMessage).not.toHaveBeenCalled();
  });

  it('refuses an admin origin that is not exact', () => {
    for (const adminOrigin of [
      '*',
      'null',
      'https://admin.test/',
      'admin.test',
      'javascript:x',
      'http://admin.test',
    ]) {
      expect(() => startLivePreview({ adminOrigin, onChange: () => {} })).toThrow(
        /exact https origin/,
      );
    }
    expect(start({ adminOrigin: 'http://localhost:5173' }).active).toBe(true);
  });

  it('leaves pages outside a session alone even when misconfigured', () => {
    window.history.replaceState(null, '', '/page');
    expect(startLivePreview({ adminOrigin: '*', onChange: () => {} }).active).toBe(false);
  });

  it('says hello to the admin origin only', () => {
    expect(start().active).toBe(true);
    expect(parent.postMessage).toHaveBeenCalledTimes(1);
    const [hello, origin] = parent.postMessage.mock.calls[0] as [Posted, string];
    expect(origin).toBe(ADMIN);
    expect(hello).toMatchObject({
      cw: 1,
      session: SESSION,
      type: 'hello',
      sdkVersion: LIVE_PREVIEW_SDK_VERSION,
    });
    expect(hello.capabilities).toContain('patch');
  });
});

describe('who it listens to', () => {
  it('ignores another origin, another window and another session', async () => {
    const onChange = vi.fn();
    start({ onChange });
    send(init(), { origin: 'https://evil.test' });
    send(init(), { source: window });
    send(init(), { source: null });
    send({ ...init(), session: 'sess_somebodyelse' });
    send({ ...init(), cw: 2 });
    await settle();
    expect(onChange).not.toHaveBeenCalled();
    // Quietly: a stranger hears nothing back.
    expect(posted('error')).toEqual([]);
  });

  it('ignores a type it does not speak', async () => {
    const onChange = vi.fn();
    start({ onChange });
    send(msg('eval', { code: 'alert(1)' }));
    await settle();
    expect(onChange).not.toHaveBeenCalled();
    expect(posted('error')).toEqual([]);
  });

  it('refuses a message over the cap, and a patch of more than 100 ops', async () => {
    const onChange = vi.fn();
    start({ onChange });
    send(init());
    await settle();
    onChange.mockClear();
    const big = 'x'.repeat(MAX_MESSAGE_BYTES);
    send(
      msg('patch', {
        seq: 1,
        ops: [{ op: 'setField', field: 'title', locale: 'en-US', value: big }],
      }),
    );
    const many = Array.from({ length: 101 }, () => ({
      op: 'setField',
      field: 'title',
      locale: 'en-US',
      value: 'x',
    }));
    send(msg('patch', { seq: 2, ops: many }));
    await settle();
    expect(onChange).not.toHaveBeenCalled();
    // The first is refused unread; the second is dropped, the page being a patch behind.
    expect(posted('error').map((e) => [e.kind, e.seq])).toEqual([
      ['patch', 1],
      ['patch', 1],
    ]);
  });

  it('takes an init larger than a patch may be (a whole entry)', async () => {
    const onChange = vi.fn();
    start({ onChange });
    send(init({ fields: { body: { 'en-US': 'y'.repeat(MAX_MESSAGE_BYTES * 2) } } }));
    await settle();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('refuses a name that reaches a prototype, anywhere in the message', async () => {
    const onChange = vi.fn();
    start({ onChange });
    send(init());
    await settle();
    send(
      msg('patch', {
        seq: 1,
        ops: [{ op: 'setField', field: '__proto__', locale: 'en-US', value: { polluted: 1 } }],
      }),
    );
    send(
      JSON.parse(
        `{"cw":1,"session":"${SESSION}","type":"patch","seq":2,"ops":[{"op":"insert","field":"body","locale":"en-US","block":{"_type":"cta","__proto__":{"polluted":1}}}]}`,
      ),
    );
    await settle();
    expect(onChange).toHaveBeenCalledTimes(1);
    // The first is refused unread; the second is dropped, the page being a patch behind.
    expect(posted('error').map((e) => [e.kind, e.seq])).toEqual([
      ['patch', 1],
      ['patch', 1],
    ]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('edits', () => {
  it('renders the entry, then each patch, acknowledging after onChange settles', async () => {
    const calls: { fields: LiveFields; seq: number; ops: number }[] = [];
    let release: (() => void) | undefined;
    start({
      onChange: (fields, update) => {
        calls.push({ fields, seq: update.seq, ops: update.ops.length });
        return new Promise<void>((r) => {
          release = r;
        });
      },
    });
    send(init());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.fields).toEqual(page());
    expect(posted('rendered')).toEqual([]);

    // Two patches land while the init is still rendering: one call takes both.
    send(
      msg('patch', {
        seq: 1,
        ops: [{ op: 'setField', field: 'title', locale: 'en-US', value: 'Hello' }],
      }),
    );
    send(
      msg('patch', {
        seq: 2,
        ops: [{ op: 'move', field: 'body', locale: 'en-US', key: 'c1', to: { index: 0 } }],
      }),
    );
    expect(calls).toHaveLength(1);
    release?.();
    await settle();
    expect(posted('rendered').map((m) => m.seq)).toEqual([0]);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ seq: 2, ops: 2 });
    expect(calls[1]?.fields.title).toEqual({ 'en-US': 'Hello' });
    expect(
      ((calls[1]?.fields.body?.['en-US'] ?? []) as { _key: string }[]).map((b) => b._key),
    ).toEqual(['c1', 'h1']);
    release?.();
    await settle();
    expect(posted('rendered').map((m) => m.seq)).toEqual([0, 2]);
  });

  it('ignores a patch it has already applied (a resend)', async () => {
    const onChange = vi.fn();
    const p = start({ onChange });
    send(init());
    const patch = msg('patch', {
      seq: 1,
      ops: [{ op: 'remove', field: 'body', locale: 'en-US', key: 'h1' }],
    });
    send(patch);
    await settle();
    send(patch);
    await settle();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(p.fields?.body?.['en-US']).toHaveLength(1);
  });

  it('refuses a patch it cannot place whole, keeping the fields it had', async () => {
    const onChange = vi.fn();
    const p = start({ onChange });
    send(init());
    await settle();
    send(
      msg('patch', {
        seq: 1,
        ops: [
          { op: 'setField', field: 'title', locale: 'en-US', value: 'Changed' },
          { op: 'remove', field: 'body', locale: 'en-US', key: 'missing' },
        ],
      }),
    );
    await settle();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(p.fields).toEqual(page());
    expect(posted('error')).toEqual([expect.objectContaining({ kind: 'patch' })]);
    // A re-sent entry with the admin's seq resumes the session.
    send(init({ seq: 1 }));
    send(
      msg('patch', {
        seq: 2,
        ops: [{ op: 'setField', field: 'title', locale: 'en-US', value: 'Again' }],
      }),
    );
    await settle();
    expect(p.fields?.title).toEqual({ 'en-US': 'Again' });
  });

  it('reports a render that throws instead of acknowledging it', async () => {
    start({
      onChange: () => {
        throw new Error('boom');
      },
    });
    send(init());
    await settle();
    expect(posted('rendered')).toEqual([]);
    expect(posted('error')).toEqual([expect.objectContaining({ kind: 'render', message: 'boom' })]);
  });

  it('never posts the entry to anyone but the admin', async () => {
    start();
    send(init());
    await settle();
    for (const [, origin] of parent.postMessage.mock.calls) expect(origin).toBe(ADMIN);
  });
});

/** A slot with two stacked blocks, a field inside the first. */
function mountPage(): { slot: HTMLElement; a: HTMLElement; b: HTMLElement; h: HTMLElement } {
  const slot = document.createElement('main');
  for (const [k, v] of Object.entries(slotAttrs('body'))) slot.setAttribute(k, v);
  const a = document.createElement('section');
  for (const [k, v] of Object.entries(blockAttrs('h1'))) a.setAttribute(k, v);
  const h = document.createElement('h1');
  h.setAttribute('data-cw-ref', 's|main|e1|landing|title|en-US');
  h.textContent = 'Welcome';
  a.appendChild(h);
  const b = document.createElement('section');
  b.setAttribute('data-cw-block', 'c1');
  slot.append(a, b);
  document.body.appendChild(slot);
  rect(slot, 0, 0, 800, 400);
  rect(a, 0, 10, 800, 100);
  rect(h, 20, 20, 300, 40);
  rect(b, 0, 130, 800, 100);
  return { slot, a, b, h };
}

describe('staying in step with the admin', () => {
  const setTitle = (seq: number, value: string) =>
    msg('patch', { seq, ops: [{ op: 'setField', field: 'title', locale: 'en-US', value }] });
  const removeMissing = (seq: number) =>
    msg('patch', { seq, ops: [{ op: 'remove', field: 'body', locale: 'en-US', key: 'missing' }] });

  it('drops every patch after a refused one, naming it, until the entry comes again', async () => {
    const onChange = vi.fn();
    const p = start({ onChange });
    send(init());
    await settle();
    send(removeMissing(1));
    // Already in flight when the admin heard of the refusal: it must not land on stale fields.
    send(setTitle(2, 'Stale'));
    await settle();
    expect(p.fields?.title).toEqual({ 'en-US': 'Home' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(posted('rendered').map((m) => m.seq)).toEqual([0]);
    expect(posted('error').map((e) => [e.kind, e.seq])).toEqual([
      ['patch', 1],
      ['patch', 1],
    ]);

    // An init without a seq starts the count again.
    send(init());
    send(setTitle(1, 'Fresh'));
    await settle();
    expect(p.fields?.title).toEqual({ 'en-US': 'Fresh' });
    expect(posted('rendered').map((m) => m.seq)).toEqual([0, 0, 1]);
  });

  it('treats a patch it could not read as refused', async () => {
    const p = start();
    send(init());
    await settle();
    send(
      msg('patch', {
        seq: 1,
        ops: [
          { op: 'setField', field: 'title', locale: 'en-US', value: 'x'.repeat(MAX_MESSAGE_BYTES) },
        ],
      }),
    );
    send(setTitle(2, 'Stale'));
    await settle();
    expect(p.fields?.title).toEqual({ 'en-US': 'Home' });
    expect(posted('rendered').map((m) => m.seq)).toEqual([0]);
    expect(posted('error').map((e) => [e.kind, e.seq])).toEqual([
      ['patch', 1],
      ['patch', 1],
    ]);
    send(init({ seq: 2 }));
    send(setTitle(3, 'Back'));
    await settle();
    expect(p.fields?.title).toEqual({ 'en-US': 'Back' });
  });

  it('acknowledges nothing a failed render held until a render that includes it succeeds', async () => {
    const updates: { seq: number; ops: number }[] = [];
    let fail = false;
    start({
      onChange: (_fields, update) => {
        updates.push({ seq: update.seq, ops: update.ops.length });
        if (fail) throw new Error('render failed');
      },
    });
    send(init());
    await settle();
    fail = true;
    send(setTitle(1, 'One'));
    await settle();
    // No retry of its own: the failed call isn't run again until something new arrives.
    expect(updates).toHaveLength(2);
    fail = false;
    send(setTitle(2, 'Two'));
    await settle();
    expect(updates).toEqual([
      { seq: 0, ops: 0 },
      { seq: 1, ops: 1 },
      { seq: 2, ops: 2 },
    ]);
    expect(posted('rendered').map((m) => m.seq)).toEqual([0, 2]);
    expect(posted('error')).toEqual([expect.objectContaining({ kind: 'render', seq: 1 })]);
  });

  it('resyncs rather than hold an unbounded backlog of edits it could not render', async () => {
    start({
      onChange: () => {
        throw new Error('always');
      },
    });
    send(init());
    await settle();
    const hundred = Array.from({ length: 100 }, (_, i) => ({
      op: 'setField',
      field: 'title',
      locale: 'en-US',
      value: `v${i}`,
    }));
    for (let seq = 1; seq <= 11; seq++) send(msg('patch', { seq, ops: hundred }));
    await settle();
    expect(posted('error').filter((e) => e.kind === 'patch')).toEqual([
      expect.objectContaining({ seq: 11 }),
    ]);
    expect(posted('rendered')).toEqual([]);
  });

  it('ignores an unreadable patch from anyone but the admin', async () => {
    const p = start();
    send(init());
    await settle();
    const big = msg('patch', {
      seq: 1,
      ops: [
        { op: 'setField', field: 'title', locale: 'en-US', value: 'x'.repeat(MAX_MESSAGE_BYTES) },
      ],
    });
    send(big, { origin: 'https://evil.test' });
    send(big, { source: window });
    send(setTitle(1, 'Still in step'));
    await settle();
    expect(posted('error')).toEqual([]);
    expect(p.fields?.title).toEqual({ 'en-US': 'Still in step' });
  });

  it('starts the count again on an init without a seq', async () => {
    const p = start();
    send(init());
    send(setTitle(5, 'Five'));
    send(init());
    send(setTitle(1, 'One again'));
    await settle();
    expect(p.fields?.title).toEqual({ 'en-US': 'One again' });
  });
});

describe('geometry', () => {
  it('fits a page of more boxes than one message holds, on-screen ones first', () => {
    const key = (i: number) => `${'k'.repeat(240)}${i}`;
    const rect = (i: number) => ({ x: 0, y: i * 10 - 20_000, w: 800, h: 10 });
    const blocks = Array.from({ length: 3000 }, (_, i) => ({ key: key(i), rect: rect(i) }));
    const slots = Array.from({ length: 3000 }, (_, i) => ({
      path: key(i),
      parentKey: key(i),
      rect: rect(i),
      gaps: [
        { index: 0, axis: 'y' as const, before: key(i), rect: rect(i) },
        { index: 1, axis: 'y' as const, after: key(i), rect: rect(i) },
      ],
    }));
    const fields = Array.from({ length: 3000 }, (_, i) => ({
      ref: `${key(i)}|ref`,
      rect: rect(i),
    }));
    const body = fitGeometry(
      {
        blocks,
        slots,
        fields,
        scroll: { x: 0, y: 0 },
        viewport: { w: 800, h: 600 },
        docHeight: 30_000,
      },
      MAX_MESSAGE_BYTES - 64,
    );
    expect(body.truncated).toBe(true);
    // Box 2000 is at y = 0, the top of the viewport.
    expect(body.blocks.map((b) => b.key)).toContain(key(2000));
    expect(body.blocks.map((b) => b.key)).toContain(key(2059));
    const parsed = parseGuestMessage(
      { data: msg('geometry', body), origin: PAGE, source: FRAME },
      guest,
    );
    expect(parsed.ok).toBe(true);
  });

  it('keeps a slot with more seams than allowed, with the seams that fit', () => {
    const r = { x: 0, y: 0, w: 1, h: 1 };
    const gaps = Array.from({ length: 5000 }, (_, index) => ({
      index,
      axis: 'y' as const,
      rect: r,
    }));
    const body = fitGeometry(
      {
        blocks: [],
        slots: [{ path: 'body', rect: r, gaps }],
        fields: [],
        scroll: { x: 0, y: 0 },
        viewport: { w: 800, h: 600 },
        docHeight: 600,
      },
      MAX_MESSAGE_BYTES - 64,
    );
    expect(body.slots).toHaveLength(1);
    expect(body.slots[0]?.gaps).toHaveLength(4000);
    expect(body.truncated).toBe(true);
  });

  it('flags nothing when everything fits', () => {
    const body = fitGeometry(
      {
        blocks: [{ key: 'a', rect: { x: 0, y: 0, w: 1, h: 1 } }],
        slots: [],
        fields: [],
        scroll: { x: 0, y: 0 },
        viewport: { w: 800, h: 600 },
        docHeight: 600,
      },
      MAX_MESSAGE_BYTES,
    );
    expect(body.truncated).toBeUndefined();
    expect(body.blocks).toHaveLength(1);
  });

  it('reports blocks, slots with their seams, and fields, once per frame', async () => {
    mountPage();
    start();
    send(init());
    await settle();
    flushFrames();
    const [first, ...rest] = posted('geometry');
    expect(rest).toEqual([]);
    expect(first?.blocks).toEqual([
      { key: 'h1', rect: { x: 0, y: 10, w: 800, h: 100 }, slot: 'body' },
      { key: 'c1', rect: { x: 0, y: 130, w: 800, h: 100 }, slot: 'body' },
    ]);
    expect(first?.fields).toEqual([
      { ref: 's|main|e1|landing|title|en-US', rect: { x: 20, y: 20, w: 300, h: 40 } },
    ]);
    const [slot] = (first?.slots ?? []) as { path: string; gaps: unknown[] }[];
    expect(slot?.path).toBe('body');
    expect(slot?.gaps).toEqual([
      { index: 0, axis: 'y', before: 'h1', rect: { x: 0, y: 0, w: 800, h: 10 } },
      { index: 1, axis: 'y', after: 'h1', before: 'c1', rect: { x: 0, y: 110, w: 800, h: 20 } },
      { index: 2, axis: 'y', after: 'c1', rect: { x: 0, y: 230, w: 800, h: 170 } },
    ]);
    expect(parseGuestMessage({ data: first, origin: PAGE, source: FRAME }, guest).ok).toBe(true);
  });

  it('folds scrolls, resizes and mutations into one message per frame, and skips no-ops', async () => {
    const { b } = mountPage();
    start();
    send(init());
    await settle();
    flushFrames();
    parent.postMessage.mockClear();

    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    b.textContent = 'changed';
    await paint();
    // Nothing moved, so nothing is worth sending.
    expect(posted('geometry')).toEqual([]);

    rect(b, 0, 150, 800, 100);
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('scroll'));
    b.setAttribute('class', 'moved');
    await paint();
    expect(posted('geometry')).toHaveLength(1);
    expect(frames.size).toBe(0);
  });

  it('measures nothing before the admin has sent the entry', async () => {
    mountPage();
    start();
    window.dispatchEvent(new Event('scroll'));
    await paint();
    expect(posted('geometry')).toEqual([]);
  });
});

describe('edit mode', () => {
  async function editing(): Promise<void> {
    start();
    send(init());
    send(msg('mode', { mode: 'edit' }));
    await settle();
  }

  it('turns a click into a pick of the nearest field or block, and the page never sees it', async () => {
    const { h, b } = mountPage();
    const pageHandler = vi.fn();
    h.addEventListener('click', pageHandler);
    await editing();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    h.dispatchEvent(click);
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(click.defaultPrevented).toBe(true);
    expect(pageHandler).not.toHaveBeenCalled();
    expect(posted('pick')).toEqual([
      expect.objectContaining({ ref: 's|main|e1|landing|title|en-US' }),
      expect.objectContaining({ key: 'c1' }),
    ]);
  });

  it('turns a link click into navigate, and never follows it', async () => {
    const { b } = mountPage();
    const nav = document.createElement('a');
    nav.href = `/about?x=1&cw_session=${SESSION}`;
    nav.textContent = 'About';
    document.body.appendChild(nav);
    const bad = document.createElement('a');
    bad.setAttribute('href', 'javascript:alert(1)');
    document.body.appendChild(bad);
    const inBlock = document.createElement('a');
    inBlock.href = 'https://other.test/x';
    b.appendChild(inBlock);
    await editing();

    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    nav.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    const badClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    bad.dispatchEvent(badClick);
    expect(badClick.defaultPrevented).toBe(true);
    // Inside a block a plain click picks the block; ⌘-click follows the link.
    inBlock.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    inBlock.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }),
    );

    expect(posted('navigate').map((m) => m.url)).toEqual([
      `${window.location.origin}/about?x=1`,
      'https://other.test/x',
    ]);
    expect(posted('pick')).toEqual([expect.objectContaining({ key: 'c1' })]);
    expect(window.location.pathname).toBe('/page');
  });

  it('does not hover again once the pointer has left, even with a frame pending', async () => {
    const { h, b } = mountPage();
    await editing();
    h.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }));
    flushFrames();
    b.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }));
    document.documentElement.dispatchEvent(new MouseEvent('pointerleave'));
    flushFrames();
    expect(posted('hover')).toEqual([
      expect.objectContaining({ ref: 's|main|e1|landing|title|en-US' }),
      expect.not.objectContaining({ key: expect.anything(), ref: expect.anything() }),
    ]);
  });

  it('sends hover at most once a frame, and only when it changes', async () => {
    const { h, b } = mountPage();
    await editing();
    h.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }));
    b.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }));
    flushFrames();
    b.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }));
    flushFrames();
    document.documentElement.dispatchEvent(new MouseEvent('pointerleave'));
    expect(posted('hover')).toEqual([
      expect.objectContaining({ key: 'c1' }),
      expect.not.objectContaining({ key: expect.anything() }),
    ]);
  });

  it('forwards only the listed shortcuts, and none typed into a form', async () => {
    mountPage();
    const input = document.createElement('input');
    document.body.appendChild(input);
    // An input inside a web component: a window listener sees only its host.
    const host = document.createElement('site-search');
    const shadowInput = document.createElement('input');
    host.attachShadow({ mode: 'open' }).appendChild(shadowInput);
    document.body.appendChild(host);
    await editing();
    const press = (
      key: string,
      init: KeyboardEventInit = {},
      target: EventTarget = document.body,
    ) => {
      const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(e);
      return e;
    };
    const undo = press('z', { metaKey: true });
    const redo = press('Z', { metaKey: true, shiftKey: true });
    press('Escape');
    press('/');
    const arrow = press('ArrowDown');
    press('a');
    press('s', { metaKey: true });
    press('z');
    press('/', {}, input);
    press('Backspace', {}, input);
    const typed = press('/', { composed: true }, shadowInput);
    expect(typed.defaultPrevented).toBe(false);
    expect(undo.defaultPrevented).toBe(true);
    expect(redo.defaultPrevented).toBe(true);
    // Nothing is selected, so the arrow still scrolls the page.
    expect(arrow.defaultPrevented).toBe(false);
    expect(posted('key').map((m) => [m.key, m.meta, m.shift])).toEqual([
      ['z', true, false],
      ['z', true, true],
      ['Escape', false, false],
      ['/', false, false],
      ['ArrowDown', false, false],
    ]);
    send(msg('select', { key: 'h1' }));
    expect(press('ArrowDown').defaultPrevented).toBe(true);
  });

  it('leaves the page alone in view mode', async () => {
    const { h } = mountPage();
    start();
    send(init());
    await settle();
    const pageHandler = vi.fn();
    h.addEventListener('click', pageHandler);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    h.dispatchEvent(click);
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }),
    );
    h.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }));
    flushFrames();
    expect(click.defaultPrevented).toBe(false);
    expect(pageHandler).toHaveBeenCalledTimes(1);
    expect(posted().map((m) => m.type)).not.toEqual(
      expect.arrayContaining(['pick', 'key', 'hover']),
    );
  });

  it('scrolls a target into view, and says so when there is none', async () => {
    const { b } = mountPage();
    const scrollIntoView = vi.fn();
    b.scrollIntoView = scrollIntoView;
    await editing();
    send(msg('scrollTo', { key: 'c1' }));
    send(msg('scrollTo', { key: '"] , * [x="' }));
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'center' }));
    expect(posted('error')).toEqual([expect.objectContaining({ kind: 'target' })]);
  });

  it('passes the admin’s selection and hover on', async () => {
    const onSelect = vi.fn();
    const onHover = vi.fn();
    start({ onSelect, onHover });
    send(msg('select', { key: 'h1' }));
    send(msg('select', {}));
    send(msg('hover', { ref: 'x' }));
    expect(onSelect.mock.calls).toEqual([[{ key: 'h1' }], [undefined]]);
    expect(onHover.mock.calls).toEqual([[{ ref: 'x' }]]);
  });
});

describe('destroy', () => {
  it('removes every listener and observer', async () => {
    const observers: { disconnect: ReturnType<typeof vi.fn> }[] = [];
    class FakeResizeObserver {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
      constructor() {
        observers.push(this);
      }
    }
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
    const { h } = mountPage();
    const onChange = vi.fn();
    const p = start({ onChange });
    send(init());
    send(msg('mode', { mode: 'edit' }));
    await settle();
    window.dispatchEvent(new Event('scroll'));
    expect(frames.size).toBe(1);
    p.destroy();
    expect(frames.size).toBe(0);
    expect(observers[0]?.disconnect).toHaveBeenCalled();
    parent.postMessage.mockClear();
    onChange.mockClear();

    send(init());
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    h.dispatchEvent(click);
    window.dispatchEvent(new Event('scroll'));
    h.textContent = 'later';
    await paint();
    expect(click.defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(parent.postMessage).not.toHaveBeenCalled();
    delete (window as unknown as { ResizeObserver?: unknown }).ResizeObserver;
  });
});

describe('the protocol parsers', () => {
  it('refuses a malformed admin message as invalid', () => {
    const bad = [
      msg('init', { fields: [], locale: 'en-US', version: 1, entryId: 'e', contentType: 't' }),
      msg('patch', { seq: -1, ops: [] }),
      msg('patch', { seq: 1, ops: [{ op: 'eval', field: 'a', locale: 'b' }] }),
      msg('patch', { seq: 1, ops: [{ op: 'move', field: 'a', locale: 'b', key: 'k' }] }),
      msg('mode', { mode: 'god' }),
      msg('scrollTo', {}),
      msg('select', { key: 'a', ref: 'b' }),
    ];
    for (const m of bad)
      expect(parseAdminMessage(m, SESSION)).toEqual({ ok: false, reason: 'invalid' });
  });

  const from = (data: unknown, origin = PAGE, source: unknown = FRAME) =>
    parseGuestMessage({ data, origin, source }, guest);

  it('refuses page messages the admin should not act on', () => {
    const bad = [
      msg('navigate', { url: 'javascript:alert(1)' }),
      msg('navigate', { url: 'data:text/html,hi' }),
      // Off the page's origin, or http on the open internet.
      msg('navigate', { url: 'https://attacker.test/' }),
      msg('navigate', { url: 'http://site.test/next' }),
      msg('pick', { key: 'constructor' }),
      msg('hover', { ref: '__proto__' }),
      JSON.parse(
        `{"cw":1,"session":"${SESSION}","type":"hello","sdkVersion":"1","capabilities":[],"__proto__":{"x":1}}`,
      ),
      msg('rendered', { seq: 1, extra: new Map() }),
      msg('key', { key: 'q', meta: false, ctrl: false, shift: false, alt: false }),
      msg('geometry', {
        blocks: [{ key: 'a', rect: { x: Number.NaN, y: 0, w: 0, h: 0 } }],
        slots: [],
        fields: [],
        scroll: { x: 0, y: 0 },
        viewport: { w: 0, h: 0 },
        docHeight: 0,
      }),
      msg('error', { kind: 'other', message: 'x' }),
    ];
    for (const m of bad) expect(from(m)).toEqual({ ok: false, reason: 'invalid' });
    expect(from(msg('navigate', { url: 'https://site.test/next' })).ok).toBe(true);
  });

  it('takes nothing on the session alone: origin and window come first', () => {
    const pick = msg('pick', { key: 'h1' });
    expect(from(pick).ok).toBe(true);
    // The session is in the frame's URL, so anything that read it can send it.
    expect(from(pick, 'https://attacker.test')).toEqual({ ok: false, reason: 'foreign' });
    expect(from(pick, PAGE, window)).toEqual({ ok: false, reason: 'foreign' });
    expect(from({ ...pick, session: 'sess_another0000' })).toEqual({
      ok: false,
      reason: 'foreign',
    });
  });

  it('hands the admin only the fields it validated', () => {
    const parsed = from({ ...msg('pick', { key: 'h1' }), onclick: 'alert(1)', nested: { a: 1 } });
    expect(parsed).toEqual({
      ok: true,
      message: { cw: 1, session: SESSION, type: 'pick', key: 'h1' },
    });
  });
});

describe('applyLivePatch', () => {
  it('sets an ordinary field and leaves the input untouched', () => {
    const before = page();
    const result = applyLivePatch(before, [
      { op: 'setField', field: 'title', locale: 'de-DE', value: 'Start' },
      { op: 'setField', field: 'title', locale: 'en-US' },
    ]);
    expect(result).toEqual({ ok: true, fields: { ...page(), title: { 'de-DE': 'Start' } } });
    expect(before).toEqual(page());
  });

  it('refuses the whole patch at the first op that can’t apply', () => {
    const result = applyLivePatch(page(), [
      { op: 'remove', field: 'body', locale: 'en-US', key: 'h1' },
      { op: 'update', field: 'body', locale: 'en-US', key: 'h1', set: { heading: 'x' } },
    ]);
    expect(result).toMatchObject({ ok: false, op: 1 });
  });

  it('refuses ops carrying prototype names, for callers that did not parse them', () => {
    const op = JSON.parse(
      '{"op":"insert","field":"body","locale":"en-US","block":{"_type":"cta","__proto__":{"x":1}}}',
    );
    expect(applyLivePatch(page(), [op])).toMatchObject({ ok: false, op: 0 });
  });
});
