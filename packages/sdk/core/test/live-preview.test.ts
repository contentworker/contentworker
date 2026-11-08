import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ContentRef,
  formatContentRef,
  formatFieldPath,
  parseContentRef,
  parseFieldPath,
  topLevelField,
} from '../src/index.js';
import {
  connectPreview,
  isSafeTokenValue,
  type PreviewGuestWindow,
  previewFrameAncestors,
} from '../src/live-preview.js';
import {
  acceptGuestMessage,
  connectPreviewHost,
  type IncomingMessage,
  isJsonData,
  LIVE_PREVIEW_MARK,
  narrowCapabilities,
  negotiateVersion,
  type PreviewHostOptions,
} from '../src/live-preview-host.js';

const ADMIN = 'https://admin.test';
const SITE = 'https://site.test';

type Listener = (e: IncomingMessage) => void;

/**
 * A window that receives messages the way a browser delivers them: later (a
 * microtask, standing in for the task queue), as a structured clone, stamped
 * with the sender's origin and window.
 */
class FakeWindow {
  readonly message = new Set<Listener>();
  readonly pagehide = new Set<() => void>();
  readonly location: { origin: string; href: string };
  parent: PreviewGuestWindow['parent'] = null;
  constructor(origin: string, path = '/') {
    this.location = { origin, href: `${origin}${path}` };
  }
  addEventListener(type: 'message' | 'pagehide', fn: Listener & (() => void)) {
    (type === 'message' ? this.message : this.pagehide).add(fn);
  }
  removeEventListener(type: 'message' | 'pagehide', fn: Listener & (() => void)) {
    (type === 'message' ? this.message : this.pagehide).delete(fn);
  }
  /** Delivers a message as if `source` sent it from `origin`. */
  dispatch(event: IncomingMessage) {
    queueMicrotask(() => {
      for (const fn of this.message) fn({ ...event, data: structuredClone(event.data) });
    });
  }
}

/** What one window holds to post to another: a browser's WindowProxy. */
function proxyTo(target: FakeWindow, from: () => { origin: string; source: unknown }) {
  const proxy = {
    posted: [] as unknown[],
    postMessage(data: unknown, targetOrigin: string) {
      proxy.posted.push(data);
      // A browser drops a message whose target origin doesn't match.
      if (targetOrigin !== '*' && targetOrigin !== target.location.origin) return;
      const { origin, source } = from();
      target.dispatch({ data, origin, source });
    },
  };
  return proxy;
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** An admin framing a site: the site's `parent` and the frame's `contentWindow`. */
function pair(sitePath = '/') {
  const admin = new FakeWindow(ADMIN);
  const site = new FakeWindow(SITE, sitePath);
  // Each side's view of the other. The admin hears the site as its iframe's
  // contentWindow; the site hears the admin as its parent.
  const toSite = proxyTo(site, () => ({ origin: ADMIN, source: toAdmin }));
  const toAdmin = proxyTo(admin, () => ({ origin: site.location.origin, source: toSite }));
  site.parent = toAdmin;
  const frame = { contentWindow: toSite };
  return { admin, site, frame, toSite, toAdmin };
}

function host(p: ReturnType<typeof pair>, opts: Partial<PreviewHostOptions> = {}) {
  return connectPreviewHost({
    frame: p.frame,
    allowedOrigins: [SITE],
    window: p.admin,
    ...opts,
  });
}

const ref = (over: Partial<ContentRef> = {}): ContentRef => ({
  space: 's1',
  environment: 'main',
  entryId: 'e1',
  contentType: 'page',
  field: 'title',
  locale: 'en-US',
  ...over,
});

const rect = { x: 1, y: 2, width: 3, height: 4 };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('connecting the preview', () => {
  it('connects at the highest shared version with the narrowed capabilities', async () => {
    const p = pair();
    const h = host(p, { capabilities: ['select', 'patch.fields'] });
    const connected = vi.fn();
    h.on('connect', connected);
    const g = connectPreview({ adminOrigin: ADMIN, window: p.site });
    await flush();
    expect(g.status).toBe('connected');
    expect(g.version).toBe(1);
    expect(g.capabilities).toEqual(['select', 'patch.fields']);
    expect(h.session).toMatchObject({ origin: SITE, version: 1 });
    expect(connected).toHaveBeenCalledWith(
      expect.objectContaining({ capabilities: ['select', 'patch.fields'] }),
    );
  });

  it('posts only to the configured admin origin, never to "*"', async () => {
    const p = pair();
    connectPreview({ adminOrigin: ADMIN, window: p.site });
    const spy = vi.spyOn(p.toAdmin, 'postMessage');
    connectPreview({ adminOrigin: ADMIN, window: p.site });
    expect(spy.mock.calls.every(([, target]) => target === ADMIN)).toBe(true);
  });

  it('rejects an offer with no shared version, and the page says which side is behind', async () => {
    const p = pair();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = host(p, { versions: [7] });
    const rejected = vi.fn();
    h.on('reject', rejected);
    const g = connectPreview({ adminOrigin: ADMIN, window: p.site });
    const onReject = vi.fn();
    g.on('reject', onReject);
    await flush();
    expect(g.status).toBe('rejected');
    expect(onReject).toHaveBeenCalledWith({ ours: [1], theirs: [7] });
    expect(rejected).toHaveBeenCalledWith({ origin: SITE, theirs: [1] });
    expect(String(errors.mock.calls[0]?.[0])).toMatch(/versions 1.*admin speaks 7/);
    expect(h.session).toBeUndefined();
  });

  it('resends an unanswered offer three times, then gives up', async () => {
    vi.useFakeTimers();
    const p = pair();
    const g = connectPreview({ adminOrigin: ADMIN, window: p.site });
    const unanswered = vi.fn();
    g.on('unanswered', unanswered);
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.toAdmin.posted).toHaveLength(4);
    expect(g.status).toBe('unanswered');
    expect(unanswered).toHaveBeenCalledOnce();
  });

  it('does nothing in a page that is not framed', () => {
    const site = new FakeWindow(SITE);
    const g = connectPreview({ adminOrigin: ADMIN, window: site });
    expect(g.status).toBe('off');
    expect(site.message.size).toBe(0);
  });

  it('refuses an admin origin equal to the page origin, or one that is not an origin', () => {
    const p = pair();
    expect(() => connectPreview({ adminOrigin: SITE, window: p.site })).toThrow(/admin origin/);
    for (const bad of ['admin.test', `${ADMIN}/`, `${ADMIN}/cms`, 'javascript:alert(1)']) {
      expect(() => connectPreview({ adminOrigin: bad, window: p.site })).toThrow(/origin like/);
    }
  });

  it('builds the frame-ancestors policy for preview responses', () => {
    expect(previewFrameAncestors(ADMIN)).toBe(`frame-ancestors ${ADMIN}`);
    expect(() => previewFrameAncestors(`${ADMIN} https://evil.test`)).toThrow();
  });
});

describe('the three checks', () => {
  const offer = (channel = 'c'.repeat(22)) => ({
    cw: LIVE_PREVIEW_MARK,
    v: 1,
    channel,
    kind: 'connect.offer',
    versions: [1],
    capabilities: ['select'],
    sdk: { name: 'test', version: '0' },
  });

  // One row per check, so removing a check fails a named test.
  const admin = [
    { check: 'origin', origin: 'https://evil.test', source: 'frame', channel: undefined },
    { check: 'source', origin: SITE, source: 'other', channel: undefined },
    { check: 'channel', origin: SITE, source: 'frame', channel: 'short' },
  ] as const;

  for (const row of admin) {
    it(`the admin drops an offer that fails the ${row.check} check`, async () => {
      const p = pair();
      const h = host(p);
      const source = row.source === 'frame' ? p.toSite : {};
      p.admin.dispatch({ data: offer(row.channel), origin: row.origin, source });
      await flush();
      expect(h.session).toBeUndefined();
      expect(h.dropped).toBe(1);
    });
  }

  it('the admin drops a session message on the wrong channel or from another origin', async () => {
    const p = pair();
    const h = host(p);
    connectPreview({ adminOrigin: ADMIN, window: p.site });
    await flush();
    const page = {
      cw: LIVE_PREVIEW_MARK,
      v: 1,
      kind: 'page',
      url: `${SITE}/`,
      entries: [],
    };
    const seen = vi.fn();
    h.on('page', seen);
    p.admin.dispatch({
      data: { ...page, channel: 'x'.repeat(22) },
      origin: SITE,
      source: p.toSite,
    });
    p.admin.dispatch({
      data: { ...page, channel: (p.toAdmin.posted[0] as { channel: string }).channel },
      origin: 'https://evil.test',
      source: p.toSite,
    });
    await flush();
    expect(seen).not.toHaveBeenCalled();
    expect(h.dropped).toBe(2);
  });

  const guest = ['origin', 'source', 'channel'] as const;
  for (const check of guest) {
    it(`the page drops an admin message that fails the ${check} check`, async () => {
      const p = pair();
      const g = connectPreview({ adminOrigin: ADMIN, window: p.site });
      const channel = (p.toAdmin.posted[0] as { channel: string }).channel;
      p.site.dispatch({
        data: {
          cw: LIVE_PREVIEW_MARK,
          v: 1,
          channel: check === 'channel' ? 'y'.repeat(22) : channel,
          kind: 'connect.accept',
          version: 1,
          capabilities: ['select'],
        },
        origin: check === 'origin' ? 'https://evil.test' : ADMIN,
        source: check === 'source' ? {} : p.toAdmin,
      });
      await flush();
      expect(g.status).toBe('connecting');
      expect(g.dropped).toBe(1);
    });
  }

  it('ignores other postMessage traffic and unknown kinds without counting them', async () => {
    const p = pair();
    const h = host(p);
    p.admin.dispatch({ data: { type: 'react-devtools' }, origin: SITE, source: p.toSite });
    p.admin.dispatch({ data: 'hello', origin: SITE, source: p.toSite });
    connectPreview({ adminOrigin: ADMIN, window: p.site });
    await flush();
    const channel = (p.toAdmin.posted[0] as { channel: string }).channel;
    p.admin.dispatch({
      data: { cw: LIVE_PREVIEW_MARK, v: 1, channel, kind: 'from.the.future' },
      origin: SITE,
      source: p.toSite,
    });
    await flush();
    expect(h.dropped).toBe(0);
  });

  it('drops a message stamped with a version other than the negotiated one', async () => {
    const p = pair();
    const h = host(p);
    const g = connectPreview({ adminOrigin: ADMIN, window: p.site });
    await flush();
    const channel = (p.toAdmin.posted[0] as { channel: string }).channel;
    p.site.dispatch({
      data: { cw: LIVE_PREVIEW_MARK, v: 2, channel, kind: 'select', ref: null },
      origin: ADMIN,
      source: p.toAdmin,
    });
    await flush();
    expect(g.dropped).toBe(1);
    expect(h.dropped).toBe(0);
  });

  it('drops a malformed message whole', () => {
    const ctx = { origin: () => true, source: 's', channel: undefined };
    const bad = [
      { versions: [] },
      { versions: [1.5] },
      { capabilities: 'select' },
      { sdk: null },
      { sdk: { name: 'x'.repeat(65), version: '1' } },
    ];
    for (const over of bad) {
      const data = { ...offer(), ...over };
      expect(acceptGuestMessage({ data, origin: SITE, source: 's' }, ctx)).toEqual({
        ok: false,
        reason: 'shape',
      });
    }
  });
});

describe('version negotiation', () => {
  const matrix: [number[], number[], number | undefined][] = [
    [[1], [1], 1],
    [[3, 2, 1], [2, 1], 2],
    [[1], [3, 2], undefined],
    [[], [1], undefined],
    [[9, 1], [1], 1],
    [[1, 2], [2, 1], 2],
  ];
  for (const [offered, supported, want] of matrix) {
    it(`offer ${JSON.stringify(offered)} × admin ${JSON.stringify(supported)} → ${want}`, () => {
      expect(negotiateVersion(offered, supported)).toBe(want);
    });
  }

  it('narrows capabilities and drops names it does not know', () => {
    expect(
      narrowCapabilities(['scroll', 'select', 'teleport'], ['select', 'patch.fields']),
    ).toEqual(['select']);
  });
});

describe('capabilities', () => {
  it('the admin sends nothing the page did not allow, and the page refuses it anyway', async () => {
    const p = pair();
    const h = host(p);
    const onState = vi.fn();
    const g = connectPreview({
      adminOrigin: ADMIN,
      window: p.site,
      capabilities: ['select'],
      onState,
    });
    await flush();
    expect(g.capabilities).toEqual(['select']);
    expect(h.scroll(ref())).toBe(false);
    h.setState('e1', 'en-US', { title: 'Hi' });
    await flush();
    expect(onState).not.toHaveBeenCalled();
    expect(p.toSite.posted.some((m) => (m as { kind: string }).kind === 'entry.state')).toBe(false);

    const channel = (p.toAdmin.posted[0] as { channel: string }).channel;
    p.site.dispatch({
      data: {
        cw: LIVE_PREVIEW_MARK,
        v: 1,
        channel,
        kind: 'entry.state',
        rev: 0,
        entryId: 'e1',
        locale: 'en-US',
        fields: { title: 'forced' },
      },
      origin: ADMIN,
      source: p.toAdmin,
    });
    await flush();
    expect(onState).not.toHaveBeenCalled();
    expect(g.dropped).toBe(1);
  });

  it('the page never widens what it offered, whatever the admin accepts', async () => {
    const p = pair();
    const g = connectPreview({ adminOrigin: ADMIN, window: p.site, capabilities: ['select'] });
    const channel = (p.toAdmin.posted[0] as { channel: string }).channel;
    p.site.dispatch({
      data: {
        cw: LIVE_PREVIEW_MARK,
        v: 1,
        channel,
        kind: 'connect.accept',
        version: 1,
        capabilities: ['select', 'patch.fields', 'scroll'],
      },
      origin: ADMIN,
      source: p.toAdmin,
    });
    await flush();
    expect(g.capabilities).toEqual(['select']);
  });
});

describe('unsaved state', () => {
  it('sends state on connect, patches in order, and reports each one applied', async () => {
    const p = pair();
    const h = host(p);
    const applied = vi.fn();
    h.on('applied', applied);
    h.setState('e1', 'en-US', { title: 'Draft', body: { nodeType: 'document', content: [] } });
    const onState = vi.fn();
    connectPreview({ adminOrigin: ADMIN, window: p.site, onState });
    await flush();
    expect(onState).toHaveBeenLastCalledWith('e1', 'en-US', {
      title: 'Draft',
      body: { nodeType: 'document', content: [] },
    });
    h.patch('e1', 'en-US', { title: 'Draft 2' });
    h.patch('e1', 'en-US', { title: 'Draft 3' });
    await flush();
    expect(onState).toHaveBeenLastCalledWith('e1', 'en-US', {
      title: 'Draft 3',
      body: { nodeType: 'document', content: [] },
    });
    expect(applied.mock.calls.map(([d]) => d.rev)).toEqual([0, 1, 2]);
  });

  it('answers a gap with failed, and the admin resends the whole state', async () => {
    const p = pair();
    const h = host(p);
    const failed = vi.fn();
    h.on('failed', failed);
    h.setState('e1', 'en-US', { title: 'A' });
    const onState = vi.fn();
    connectPreview({ adminOrigin: ADMIN, window: p.site, onState });
    await flush();
    const channel = (p.toAdmin.posted[0] as { channel: string }).channel;
    // A patch that skips a rev, as if one were lost.
    p.site.dispatch({
      data: {
        cw: LIVE_PREVIEW_MARK,
        v: 1,
        channel,
        kind: 'entry.patch',
        rev: 5,
        entryId: 'e1',
        locale: 'en-US',
        fields: { title: 'lost' },
      },
      origin: ADMIN,
      source: p.toAdmin,
    });
    await flush();
    expect(failed).toHaveBeenCalledWith({ entryId: 'e1', rev: 5, reason: 'gap' });
    expect(onState).toHaveBeenCalledTimes(2);
    expect(onState).toHaveBeenLastCalledWith('e1', 'en-US', { title: 'A' });
  });

  it('reports a render failure without resending', async () => {
    const p = pair();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = host(p);
    const failed = vi.fn();
    h.on('failed', failed);
    h.setState('e1', 'en-US', { title: 'A' });
    const onState = vi.fn(() => {
      throw new Error('boom');
    });
    connectPreview({ adminOrigin: ADMIN, window: p.site, onState });
    await flush();
    expect(failed).toHaveBeenCalledWith({ entryId: 'e1', rev: 0, reason: 'render' });
    expect(onState).toHaveBeenCalledOnce();
  });

  it('a page that connects after a navigation gets the current state again', async () => {
    const p = pair();
    const h = host(p);
    const ended = vi.fn();
    h.on('ended', ended);
    h.setState('e1', 'en-US', { title: 'A' });
    const first = connectPreview({ adminOrigin: ADMIN, window: p.site });
    await flush();
    h.patch('e1', 'en-US', { title: 'B' });
    await flush();
    first.close();
    await flush();
    expect(ended).toHaveBeenCalledWith({ url: `${SITE}/` });
    expect(h.session).toBeUndefined();

    const onState = vi.fn();
    connectPreview({ adminOrigin: ADMIN, window: p.site, onState });
    await flush();
    expect(onState).toHaveBeenCalledWith('e1', 'en-US', { title: 'B' });
  });

  it('carries only JSON data: no dates, maps, cycles, non-finite numbers or deep nesting', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let deep: unknown = 'x';
    for (let i = 0; i < 70; i++) deep = [deep];
    expect(isJsonData({ a: [1, 'b', null, true, { c: 2 }] })).toBe(true);
    for (const bad of [new Date(), new Map(), cycle, Number.NaN, Infinity, deep, () => 1, 1n]) {
      expect(isJsonData({ v: bad })).toBe(false);
    }
  });
});

describe('page and pointer', () => {
  it('reports what the page renders, sent on connect even when reported before it', async () => {
    const p = pair();
    const h = host(p);
    const seen = vi.fn();
    h.on('page', seen);
    const g = connectPreview({ adminOrigin: ADMIN, window: p.site });
    g.reportPage(
      Array.from({ length: 60 }, (_, i) => ({
        entryId: `e${i}`,
        contentType: 'page',
        locale: 'en',
      })),
    );
    await flush();
    expect(seen).toHaveBeenCalledOnce();
    expect(seen.mock.calls[0]?.[0].entries).toHaveLength(50);
  });

  it('drops a pointer ref for an entry the page did not report or the person may not read', async () => {
    const p = pair();
    const h = host(p, { canRead: (r) => r.entryId !== 'secret' });
    const pointer = vi.fn();
    h.on('pointer', pointer);
    const g = connectPreview({ adminOrigin: ADMIN, window: p.site });
    g.reportPage([
      { entryId: 'e1', contentType: 'page', locale: 'en-US' },
      { entryId: 'secret', contentType: 'page', locale: 'en-US' },
    ]);
    await flush();
    g.reportPointer('click', ref(), rect);
    g.reportPointer('click', ref({ entryId: 'unreported' }), rect);
    g.reportPointer('hover', ref({ entryId: 'secret' }), rect);
    await flush();
    expect(pointer).toHaveBeenCalledOnce();
    expect(pointer).toHaveBeenCalledWith({ pointer: 'click', ref: ref(), rect });
    expect(h.dropped).toBe(2);
  });

  it('passes select and scroll to the page', async () => {
    const p = pair();
    const h = host(p);
    const g = connectPreview({ adminOrigin: ADMIN, window: p.site });
    const selected = vi.fn();
    const scrolled = vi.fn();
    g.on('select', selected);
    g.on('scroll', scrolled);
    await flush();
    expect(h.select(ref())).toBe(true);
    expect(h.scroll(ref({ field: 'body[k1].heading' }))).toBe(true);
    h.select(null);
    await flush();
    expect(selected.mock.calls).toEqual([[ref()], [null]]);
    expect(scrolled).toHaveBeenCalledWith(ref({ field: 'body[k1].heading' }));
  });
});

describe('isSafeTokenValue', () => {
  const safe = [
    '#0f172a',
    '12px',
    '1.5rem',
    'var(--space-4)',
    'calc(var(--space-2) * 2)',
    'calc(1px + (2px * 3))',
    'clamp(1rem, 2vw, 3rem)',
    'oklch(62% 0.2 290)',
    'rgb(0 0 0 / 50%)',
    'bold',
  ];
  const unsafe = [
    'url(https://evil.test/x)',
    'URL(https://evil.test/x)',
    'u\\rl(https://evil.test/x)',
    'image-set("x.png" 1x)',
    'var(--a, url(x))',
    '@import "x"',
    'expression(alert(1))',
    'javascript:alert(1)',
    '<style>',
    'red; background: red',
    'red}body{color:red',
    'red /* comment */',
    'red !important',
    'attr(data-x)',
    'env(safe-area-inset-top)',
    'red\nbackground:red',
    '',
    'x'.repeat(257),
  ];
  for (const v of safe) it(`accepts ${v}`, () => expect(isSafeTokenValue(v)).toBe(true));
  for (const v of unsafe) {
    it(`rejects ${JSON.stringify(v).slice(0, 40)}`, () => expect(isSafeTokenValue(v)).toBe(false));
  }
  it('rejects a value that is not a string', () => {
    expect(isSafeTokenValue(12)).toBe(false);
  });
});

describe('field paths in content refs', () => {
  const path = 'body[0192f1].ctas[0192e2].label';

  it('formats and parses a path into blocks', () => {
    const steps = [
      { field: 'body', key: '0192f1' },
      { field: 'ctas', key: '0192e2' },
      { field: 'label' },
    ];
    expect(formatFieldPath(steps)).toBe(path);
    expect(parseFieldPath(path)).toEqual(steps);
    expect(parseFieldPath('title')).toEqual([{ field: 'title' }]);
  });

  it('refuses a path that does not name a value', () => {
    expect(() => formatFieldPath([])).toThrow();
    expect(() => formatFieldPath([{ field: 'body' }, { field: 'heading' }])).toThrow(/block key/);
    expect(() => formatFieldPath([{ field: 'body', key: 'a]b' }])).toThrow(/block key/);
    for (const bad of ['body.heading', 'body[].x', 'body[k]x', '1body', 'body[k].']) {
      expect(parseFieldPath(bad)).toBeUndefined();
    }
  });

  it('stays a six-part ref, so an older parser still reads it', () => {
    const r = ref({ field: path });
    const serialized = formatContentRef(r);
    expect(serialized.split('|')).toHaveLength(6);
    expect(parseContentRef(serialized)).toEqual(r);
  });

  it('names the top-level field a path starts at', () => {
    expect(topLevelField(path)).toBe('body');
    expect(topLevelField('title')).toBe('title');
  });
});
