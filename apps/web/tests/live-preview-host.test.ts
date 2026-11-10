// The admin's half of the live preview channel (docs/specs/live-preview-channel.md), as the Site
// frame runs it. It answers only the framed page's own offers (origin, sender, channel), picks a
// shared version or rejects with both lists, narrows what the page may be sent to what the person
// may do, sends the entry once the page says it renders it, numbers each edit per entry, and
// answers every failure with a fresh state, except a state the page refused, which it never resends.
// The first test wires it to the real frontend half (`connectPreview`) in a window of another origin.
import {
  type Capability,
  connectPreview,
  type LiveFields,
  newChannel,
} from '@contentworker/sdk-core/live-preview';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FrameEntry } from '~/cms/lib/live-preview/frame-channel';
import {
  ADMIN_CAPABILITIES,
  CONNECT_MS,
  capabilitiesFor,
  LivePreviewHost,
  LOAD_MS,
  SELECT_ONLY,
} from '~/cms/lib/live-preview/host';

const ADMIN = 'https://admin.example';
const SITE = 'https://site.example';

const entry = (title = 'Home', extra: Partial<FrameEntry> = {}): FrameEntry => ({
  entryId: 'e1',
  locale: 'en-US',
  fields: { title, body: [{ _type: 'cta', _key: 'k1', label: 'Go' }] },
  ...extra,
});
const titled = (title: string) => ({ fields: { title }, blocks: [] });

afterEach(() => vi.useRealTimers());

describe('the live preview host with the real frontend half', () => {
  it('connects, sends the state once the page reports the entry, then each edit, and hears it applied', async () => {
    const dom = new JSDOM('<main id="app"></main>', { url: `${SITE}/p`, pretendToBeVisual: true });
    const guest = dom.window as unknown as Window;
    // The guest's parent is the admin's frame: its posts arrive as the frame's message events.
    let host: LivePreviewHost | undefined;
    // What the host holds as the iframe's window: the guest, as the admin sees it.
    const framed = {
      postMessage(data: unknown, target: string) {
        expect(target).toBe(SITE);
        const ev = new dom.window.Event('message');
        Object.assign(ev, { data: structuredClone(data), origin: ADMIN, source: parent });
        guest.dispatchEvent(ev);
      },
    };
    const parent = {
      postMessage(data: unknown, target: string) {
        expect(target).toBe(ADMIN);
        host?.receive({ data: structuredClone(data), origin: SITE, source: framed });
      },
    };
    Object.defineProperty(guest, 'parent', { value: parent });
    host = new LivePreviewHost({
      origin: SITE,
      origins: [SITE],
      frame: () => framed,
      onStatus: () => {},
    });
    host.setAllowed(ADMIN_CAPABILITIES);
    host.setEntry(entry(), null);
    const rendered: LiveFields[] = [];
    const preview = connectPreview({
      adminOrigin: ADMIN,
      capabilities: ['select', 'patch.fields', 'patch.blocks', 'scroll'],
      window: guest,
      onState: (_id, _locale, fields) => {
        rendered.push(fields);
      },
    });
    expect(preview.connected).toBe(true);
    expect(preview.capabilities).toEqual(['select', 'patch.fields', 'patch.blocks', 'scroll']);
    preview.emit('page', {
      url: `${SITE}/p`,
      entries: [{ entryId: 'e1', contentType: 'page', locale: 'en-US' }],
    });
    await vi.waitFor(() => expect(rendered.at(-1)?.title).toBe('Home'));
    host.setEntry(entry('Homepage'), titled('Homepage'));
    await vi.waitFor(() => expect(rendered.at(-1)?.title).toBe('Homepage'));
    host.setEntry(
      entry('Homepage', {
        fields: { title: 'Homepage', body: [{ _type: 'cta', _key: 'k1', label: 'Start' }] },
      }),
      {
        fields: {},
        blocks: [
          {
            field: 'body',
            ops: [
              { op: 'update', field: 'body', locale: 'en-US', key: 'k1', set: { label: 'Start' } },
            ],
          },
        ],
      },
    );
    await vi.waitFor(() =>
      expect(((rendered.at(-1)?.body ?? []) as { label: string }[])[0]?.label).toBe('Start'),
    );
    await vi.waitFor(() => expect(host?.rendered).toBe(3));
    preview.close();
  });
  it('shows Coworker’s proposal as ghosts the page never saves, and Not now takes them away', async () => {
    const dom = new JSDOM('<main id="app"></main>', { url: `${SITE}/p`, pretendToBeVisual: true });
    const guest = dom.window as unknown as Window;
    let host: LivePreviewHost | undefined;
    const framed = {
      postMessage(data: unknown) {
        const ev = new dom.window.Event('message');
        Object.assign(ev, { data: structuredClone(data), origin: ADMIN, source: parent });
        guest.dispatchEvent(ev);
      },
    };
    const parent = {
      postMessage(data: unknown) {
        host?.receive({ data: structuredClone(data), origin: SITE, source: framed });
      },
    };
    Object.defineProperty(guest, 'parent', { value: parent });
    const shown = vi.fn();
    host = new LivePreviewHost({
      origin: SITE,
      origins: [SITE],
      frame: () => framed,
      onStatus: () => {},
      onProposal: shown,
    });
    host.setAllowed(capabilitiesFor(['content:write'], { assistant: true }));
    host.setEntry(entry(), null);
    const views: { fields: LiveFields; ghosts: string[]; withProposals: LiveFields }[] = [];
    const preview = connectPreview({
      adminOrigin: ADMIN,
      capabilities: ['select', 'patch.fields', 'patch.blocks', 'scroll', 'proposals'],
      window: guest,
      onState: (_id, _locale, fields, view) => {
        views.push({
          fields,
          ghosts: [...view.ghosts.inserted],
          withProposals: view.withProposals,
        });
      },
    });
    preview.emit('page', {
      url: `${SITE}/p`,
      entries: [{ entryId: 'e1', contentType: 'page', locale: 'en-US' }],
    });
    await vi.waitFor(() => expect(views.at(-1)?.fields.title).toBe('Home'));
    // The dry run's applied insert, keyed.
    host.setProposal([
      {
        op: 'insert',
        field: 'body',
        locale: 'en-US',
        index: 1,
        block: { _type: 'cta', _key: 'g1', label: 'Proposed by Coworker' },
      },
    ]);
    await vi.waitFor(() => expect(views.at(-1)?.ghosts).toEqual(['g1']));
    const last = views.at(-1);
    expect(last?.withProposals.body).toHaveLength(2);
    // What the page holds as the entry's state never has it.
    expect(last?.fields.body).toHaveLength(1);
    expect(shown).toHaveBeenLastCalledWith(true, false);
    host.setProposal(null);
    await vi.waitFor(() => expect(views.at(-1)?.ghosts).toEqual([]));
    expect(views.at(-1)?.withProposals.body).toHaveLength(1);
    preview.close();
  });
});

/** A host and a scripted page: what the page says, and what the host posted it. */
function setup(allowed: readonly Capability[] = ADMIN_CAPABILITIES) {
  const frame = { postMessage: vi.fn() };
  const onStatus = vi.fn();
  const onPointer = vi.fn();
  const onNote = vi.fn();
  const onSession = vi.fn();
  const onProposal = vi.fn();
  const host = new LivePreviewHost({
    origin: SITE,
    origins: [SITE, 'https://shop.example'],
    frame: () => frame,
    onStatus,
    onPointer,
    onNote,
    onSession,
    onProposal,
  });
  const channel = newChannel();
  const say = (
    kind: string,
    body: Record<string, unknown> = {},
    from: Partial<{ origin: string; source: unknown; channel: string; v: number }> = {},
  ) =>
    host.receive({
      data: { v: from.v ?? 1, channel: from.channel ?? channel, kind, ...body },
      origin: from.origin ?? SITE,
      source: 'source' in from ? from.source : frame,
    });
  const offer = (
    versions = [1],
    caps: string[] = ['select', 'patch.fields', 'patch.blocks', 'scroll', 'layout', 'proposals'],
    ch = channel,
  ) =>
    say(
      'connect.offer',
      { versions, capabilities: caps, sdk: { name: '@contentworker/sdk', version: '0.2.0' } },
      { channel: ch, v: versions[0] },
    );
  const page = (entries = ['e1']) =>
    say('page', {
      url: `${SITE}/p`,
      entries: entries.map((entryId) => ({ entryId, contentType: 'page', locale: 'en-US' })),
    });
  const sent = (kind?: string) => {
    for (const [, target] of frame.postMessage.mock.calls)
      expect([SITE, 'https://shop.example']).toContain(target);
    return frame.postMessage.mock.calls
      .map(([m]) => m as Record<string, unknown> & { kind: string; rev?: number })
      .filter((m) => !kind || m.kind === kind);
  };
  host.setAllowed(allowed);
  return {
    host,
    frame,
    onStatus,
    onPointer,
    onNote,
    onSession,
    onProposal,
    channel,
    say,
    offer,
    page,
    sent,
  };
}

describe('what the page may do for a person', () => {
  it('lets someone who edits content send values, and anyone else only select', () => {
    expect(capabilitiesFor(['content:read', 'content:write'])).toEqual(ADMIN_CAPABILITIES);
    expect(capabilitiesFor(['content:read', 'preview:read'])).toEqual(SELECT_ONLY);
    expect(SELECT_ONLY).not.toContain('patch.fields');
    expect(SELECT_ONLY).not.toContain('patch.blocks');
  });
});

describe('the live preview host', () => {
  it('drops an offer from another window, and says so for one from another origin', () => {
    const t = setup();
    t.say(
      'connect.offer',
      { versions: [1], capabilities: [], sdk: { name: 'x', version: '1' } },
      { source: {} },
    );
    t.say(
      'connect.offer',
      { versions: [1], capabilities: [], sdk: { name: 'x', version: '1' } },
      { source: null },
    );
    expect(t.sent()).toEqual([]);
    t.say(
      'connect.offer',
      { versions: [1], capabilities: [], sdk: { name: 'x', version: '1' } },
      { origin: 'https://www.site.example' },
    );
    expect(t.sent()).toEqual([]);
    expect(t.onStatus).toHaveBeenLastCalledWith('origin', 'https://www.site.example');
  });

  it('drops a malformed channel, and after connect anything on another channel or version', () => {
    const t = setup();
    t.offer([1], ['select'], 'short');
    expect(t.sent()).toEqual([]);
    t.offer();
    expect(t.sent('connect.accept')).toHaveLength(1);
    t.say(
      'pointer',
      { pointer: 'click', ref: 'r', rect: { x: 0, y: 0, w: 1, h: 1 } },
      { channel: newChannel() },
    );
    t.say('pointer', { pointer: 'click', ref: 'r', rect: { x: 0, y: 0, w: 1, h: 1 } }, { v: 2 });
    expect(t.onPointer).not.toHaveBeenCalled();
    t.say('pointer', { pointer: 'click', ref: 'r', rect: { x: 0, y: 0, w: 1, h: 1 } });
    expect(t.onPointer).toHaveBeenCalledWith('click', 'r', { x: 0, y: 0, w: 1, h: 1 });
  });

  it('accepts the highest shared version, narrowed to what the admin uses; rejects with both lists', () => {
    const t = setup();
    t.offer([3, 1]);
    const accept = t.sent('connect.accept')[0];
    expect(accept).toMatchObject({ v: 1, channel: t.channel, version: 1 });
    // Proposals wait for Coworker's side: offered, but not accepted.
    expect(accept?.capabilities).toEqual([
      'select',
      'patch.fields',
      'patch.blocks',
      'scroll',
      'layout',
    ]);
    expect(t.onStatus).toHaveBeenLastCalledWith('live', undefined);

    const u = setup();
    u.offer([99]);
    expect(u.sent('connect.reject')[0]).toMatchObject({
      v: 99,
      reason: 'unsupported-version',
      versions: [1],
    });
    expect(u.sent('connect.accept')).toEqual([]);
    expect(u.onStatus).toHaveBeenLastCalledWith('unsupported', 'new');
  });

  it('holds an offer until the editor says what the person may allow, then answers it', () => {
    const frame = { postMessage: vi.fn() };
    const host = new LivePreviewHost({
      origin: SITE,
      origins: [SITE],
      frame: () => frame,
      onStatus: () => {},
    });
    const channel = newChannel();
    host.receive({
      data: {
        v: 1,
        channel,
        kind: 'connect.offer',
        versions: [1],
        capabilities: ['select', 'patch.fields'],
        sdk: { name: 'x', version: '1' },
      },
      origin: SITE,
      source: frame,
    });
    expect(frame.postMessage).not.toHaveBeenCalled();
    host.setAllowed(['select']);
    expect(frame.postMessage.mock.calls[0]?.[0]).toMatchObject({
      kind: 'connect.accept',
      capabilities: ['select'],
    });
  });

  it('narrows a live session when the person may do less, and sends no values after', () => {
    const t = setup();
    t.offer();
    t.host.setEntry(entry(), null);
    t.page();
    expect(t.sent('entry.state')).toHaveLength(1);
    t.host.setAllowed(SELECT_ONLY);
    t.host.setEntry(entry('Typed'), titled('Typed'));
    expect(t.sent('entry.patch')).toEqual([]);
    expect(t.host.capabilities).toEqual(['select', 'scroll', 'layout']);
  });

  it('a role that may only select gets clicks, and the page is never sent its values', () => {
    const t = setup(['select', 'scroll']);
    t.offer();
    t.host.setEntry(entry(), null);
    t.page();
    t.host.setEntry(entry('Typed'), titled('Typed'));
    expect(t.sent('entry.state')).toEqual([]);
    expect(t.sent('entry.patch')).toEqual([]);
    t.host.select('ref', true);
    expect(t.sent('select')).toHaveLength(1);
    expect(t.sent('scroll')).toHaveLength(1);
  });

  it('sends the state only once the page reports the entry, then numbered patches per entry', () => {
    const t = setup();
    t.offer();
    t.host.setEntry(entry(), null);
    expect(t.sent('entry.state')).toEqual([]);
    t.page(['other']);
    expect(t.onStatus).toHaveBeenLastCalledWith('elsewhere', undefined);
    expect(t.sent('entry.state')).toEqual([]);
    t.page(['other', 'e1']);
    expect(t.sent('entry.state')[0]).toMatchObject({
      rev: 1,
      entryId: 'e1',
      locale: 'en-US',
      fields: { title: 'Home' },
    });
    t.host.setEntry(entry('A'), titled('A'));
    t.host.setEntry(entry('A'), {
      fields: {},
      blocks: [
        { field: 'body', ops: [{ op: 'remove', field: 'body', locale: 'en-US', key: 'k1' }] },
      ],
    });
    expect(t.sent('entry.patch')[0]).toMatchObject({ rev: 2, fields: { title: 'A' } });
    expect(t.sent('blocks.patch')[0]).toMatchObject({ rev: 3, field: 'body' });
    // A new locale is a whole state.
    t.host.setEntry(entry('A', { locale: 'de' }), titled('A'));
    expect(t.sent('entry.state').at(-1)).toMatchObject({ rev: 4, locale: 'de' });
  });

  it('answers a gap with a fresh state, ignores failures that state covers, counts acks that skip', () => {
    const t = setup();
    t.offer();
    t.host.setEntry(entry(), null);
    t.page();
    t.host.setEntry(entry('A'), titled('A'));
    t.host.setEntry(entry('B'), titled('B'));
    t.say('failed', { rev: 2, reason: 'gap', entryId: 'e1' });
    expect(t.onNote).toHaveBeenCalledWith('gap');
    expect(t.sent('entry.state').at(-1)).toMatchObject({ rev: 4, fields: { title: 'B' } });
    t.say('failed', { rev: 3, reason: 'gap', entryId: 'e1' });
    expect(t.sent('entry.state')).toHaveLength(2);
    t.say('applied', { rev: 4, entryId: 'e1' });
    expect(t.host.rendered).toBe(4);
    t.say('applied', { rev: 9, entryId: 'e1' });
    expect(t.host.rendered).toBe(4);
    // Another entry's acknowledgements aren't this one's.
    t.say('failed', { rev: 5, reason: 'gap', entryId: 'other' });
    expect(t.sent('entry.state')).toHaveLength(2);
  });

  it('never resends a state the page refused as invalid: the entry can’t be previewed', () => {
    const t = setup();
    t.offer();
    t.host.setEntry(entry(), null);
    t.page();
    t.say('failed', { rev: 1, reason: 'invalid', entryId: 'e1' });
    expect(t.onStatus).toHaveBeenLastCalledWith('unpreviewable', undefined);
    t.host.setEntry(entry('A'), titled('A'));
    expect(t.sent('entry.state')).toHaveLength(1);
    expect(t.sent('entry.patch')).toEqual([]);
  });

  it('sends blocks fields whole once the page refuses block ops again right after a recovery', () => {
    const t = setup();
    t.offer();
    t.host.setEntry(entry(), null);
    t.page();
    const edit = {
      fields: {},
      blocks: [
        {
          field: 'body',
          ops: [{ op: 'remove' as const, field: 'body', locale: 'en-US', key: 'k1' }],
        },
      ],
    };
    t.host.setEntry(entry('Home', { fields: { title: 'Home', body: [] } }), edit);
    t.say('failed', { rev: 2, reason: 'conflict', entryId: 'e1' });
    expect(t.host.wholeFields).toBe(false);
    t.host.setEntry(entry('Home', { fields: { title: 'Home', body: [] } }), edit);
    t.say('failed', { rev: 4, reason: 'conflict', entryId: 'e1' });
    expect(t.host.wholeFields).toBe(true);
    t.host.setEntry(entry('Home', { fields: { title: 'Home', body: [] } }), edit);
    expect(t.sent('entry.patch').at(-1)).toMatchObject({ fields: { body: [] } });
  });

  it('a fresh offer from the same window replaces the session; the state goes again on its page', () => {
    const t = setup();
    t.offer();
    t.host.setEntry(entry(), null);
    t.page();
    const second = newChannel();
    t.offer([1], ['select', 'patch.fields'], second);
    expect(t.sent('connect.accept').at(-1)).toMatchObject({ channel: second });
    t.say(
      'page',
      { url: `${SITE}/p`, entries: [{ entryId: 'e1', contentType: 'page', locale: 'en-US' }] },
      { channel: second },
    );
    expect(t.sent('entry.state').at(-1)).toMatchObject({ channel: second });
    // The old channel is gone.
    t.say('pointer', { pointer: 'click', ref: 'r', rect: { x: 0, y: 0, w: 1, h: 1 } });
    expect(t.onPointer).not.toHaveBeenCalled();
  });

  it('follows a navigation only to an origin the space previews on, else says it moved away', () => {
    const t = setup();
    t.offer();
    t.say('navigated', { url: 'https://shop.example/cart' });
    const next = newChannel();
    t.say(
      'connect.offer',
      { versions: [1], capabilities: ['select'], sdk: { name: 'x', version: '1' } },
      { origin: 'https://shop.example', channel: next },
    );
    expect(t.sent('connect.accept').at(-1)).toMatchObject({ channel: next });

    const u = setup();
    u.offer();
    u.say('navigated', { url: 'https://elsewhere.example/' });
    expect(u.onStatus).toHaveBeenLastCalledWith('navigated', undefined);
    u.say(
      'connect.offer',
      { versions: [1], capabilities: ['select'], sdk: { name: 'x', version: '1' } },
      { origin: 'https://elsewhere.example', channel: newChannel() },
    );
    expect(u.sent('connect.accept')).toHaveLength(1);
  });

  it('says a loaded page that never offers isn’t connected, and a frame that never loads failed', () => {
    vi.useFakeTimers();
    const t = setup();
    t.host.start();
    t.host.frameLoaded();
    vi.advanceTimersByTime(CONNECT_MS);
    expect(t.onStatus).toHaveBeenLastCalledWith('not-connected', undefined);

    const u = setup();
    u.host.start();
    vi.advanceTimersByTime(LOAD_MS);
    expect(u.onStatus).toHaveBeenLastCalledWith('failed', undefined);
  });

  it('takes an offer before the load event as that page’s, and a later load without one as moving away', () => {
    vi.useFakeTimers();
    const t = setup();
    t.host.start();
    t.offer();
    t.host.frameLoaded();
    vi.advanceTimersByTime(CONNECT_MS);
    expect(t.onStatus).toHaveBeenLastCalledWith('live', undefined);
    t.host.frameLoaded();
    vi.advanceTimersByTime(CONNECT_MS);
    expect(t.onStatus).toHaveBeenLastCalledWith('navigated', undefined);
  });

  it('passes over a load that never offers when the page after it offers before its own load', () => {
    vi.useFakeTimers();
    const t = setup();
    t.host.start();
    // A redirect or sign-in hand-off page loads first and never offers…
    t.host.frameLoaded();
    vi.advanceTimersByTime(CONNECT_MS / 2);
    // …then the entry's page offers, as pages do, before its own load event.
    t.offer();
    expect(t.onStatus).toHaveBeenLastCalledWith('live', undefined);
    t.host.frameLoaded();
    vi.advanceTimersByTime(CONNECT_MS * 2);
    expect(t.onStatus).toHaveBeenLastCalledWith('live', undefined);
    expect(t.onStatus).not.toHaveBeenCalledWith('navigated', undefined);
    expect(t.onStatus).not.toHaveBeenCalledWith('not-connected', undefined);
    // Still connected: the entry goes once the page reports it.
    t.host.setEntry(entry(), null);
    t.page();
    expect(t.sent('entry.state')).toHaveLength(1);
  });

  it('passes over a load that never offers when the page after it offers after its own load', () => {
    vi.useFakeTimers();
    const t = setup();
    t.host.start();
    t.offer();
    t.host.frameLoaded();
    expect(t.onStatus).toHaveBeenLastCalledWith('live', undefined);
    // The connected page leaves (it says so), a hand-off page loads and never offers…
    t.say('navigated', { url: `${SITE}/handoff` });
    t.host.frameLoaded();
    vi.advanceTimersByTime(CONNECT_MS - 1);
    // …and the next page loads, then offers within the time from its load.
    t.host.frameLoaded();
    vi.advanceTimersByTime(CONNECT_MS - 1);
    t.offer(undefined, undefined, newChannel());
    vi.advanceTimersByTime(CONNECT_MS * 2);
    expect(t.onStatus).toHaveBeenLastCalledWith('live', undefined);
    expect(t.onStatus).not.toHaveBeenCalledWith('navigated', undefined);
  });

  it('counts a fresh offer on a page already loaded as no later load’s', () => {
    vi.useFakeTimers();
    const t = setup();
    t.host.start();
    t.offer();
    t.host.frameLoaded();
    // The page remounts and offers again; then the frame loads something that never offers.
    t.offer(undefined, undefined, newChannel());
    t.host.frameLoaded();
    vi.advanceTimersByTime(CONNECT_MS);
    expect(t.onStatus).toHaveBeenLastCalledWith('navigated', undefined);
  });

  it('says the page moved away only when no offer comes in the time after the last load', () => {
    vi.useFakeTimers();
    const t = setup();
    t.host.start();
    t.offer();
    t.host.frameLoaded();
    // A page that had connected leaves, and what replaces it never offers.
    t.say('navigated', { url: `${SITE}/elsewhere` });
    t.host.frameLoaded();
    t.host.frameLoaded();
    vi.advanceTimersByTime(CONNECT_MS - 1);
    expect(t.onStatus).toHaveBeenLastCalledWith('live', undefined);
    vi.advanceTimersByTime(1);
    expect(t.onStatus).toHaveBeenLastCalledWith('navigated', undefined);
  });

  it('turns editing off and on', () => {
    const t = setup();
    t.offer();
    t.host.setEditing(false);
    expect(t.sent('editing').at(-1)).toMatchObject({ on: false });
    t.host.setEditing(true);
    expect(t.sent('editing').at(-1)).toMatchObject({ on: true });
  });
});

describe('Coworker’s proposals on the page', () => {
  const ghost = {
    op: 'insert',
    field: 'body',
    locale: 'en-US',
    after: 'k1',
    block: { _type: 'cta', _key: 'g1', label: 'Proposed' },
  } as const;
  const proposing = () => {
    const t = setup([...ADMIN_CAPABILITIES, 'proposals']);
    t.offer();
    t.host.setEntry(entry(), null);
    t.page();
    return t;
  };

  it('lets a writer’s page show them only with Coworker on', () => {
    expect(capabilitiesFor(['content:write'], { assistant: true })).toContain('proposals');
    expect(capabilitiesFor(['content:write'])).not.toContain('proposals');
    expect(capabilitiesFor(['content:read'], { assistant: true })).toEqual(SELECT_ONLY);
  });

  it('sends a proposal only on a session that accepted them, marked proposed', () => {
    const t = setup();
    t.offer();
    t.host.setEntry(entry(), null);
    t.page();
    expect(t.host.setProposal([ghost])).toBe(false);
    expect(t.sent('blocks.patch')).toHaveLength(0);

    // Let through for this person, but not offered by the page: still nothing.
    const n = setup([...ADMIN_CAPABILITIES, 'proposals']);
    n.offer(undefined, ['select', 'patch.fields', 'patch.blocks', 'scroll', 'layout']);
    n.host.setEntry(entry(), null);
    n.page();
    expect(n.host.setProposal([ghost])).toBe(false);

    const u = proposing();
    expect(u.host.setProposal([ghost])).toBe(true);
    expect(u.sent('blocks.patch').at(-1)).toMatchObject({
      rev: 2,
      field: 'body',
      ops: [{ ...ghost, proposed: true }],
    });
    expect(u.onProposal).toHaveBeenLastCalledWith(true, false);
  });

  it('sends it again after every whole state, and only in the locale the page shows', () => {
    const t = proposing();
    t.host.setProposal([
      ghost,
      { ...ghost, locale: 'de-DE', block: { ...ghost.block, _key: 'g2' } },
    ]);
    expect(t.sent('blocks.patch').at(-1)?.ops).toHaveLength(1);
    // A gap: the page gets the whole entry, which clears its ghosts, then the proposal again.
    t.say('failed', { rev: 2, reason: 'gap', entryId: 'e1' });
    expect(
      t
        .sent()
        .slice(-2)
        .map((m) => m.kind),
    ).toEqual(['entry.state', 'blocks.patch']);
    // Another session (the page reloaded): the same.
    const channel = newChannel();
    t.offer(undefined, undefined, channel);
    t.say(
      'page',
      { url: `${SITE}/p`, entries: [{ entryId: 'e1', contentType: 'page', locale: 'en-US' }] },
      { channel },
    );
    expect(
      t
        .sent()
        .slice(-2)
        .map((m) => m.kind),
    ).toEqual(['entry.state', 'blocks.patch']);
  });

  it('takes it back with a fresh state on Not now, and sends no more of it', () => {
    const t = proposing();
    t.host.setProposal([ghost]);
    const before = t.sent().length;
    expect(t.host.setProposal(null)).toBe(false);
    expect(
      t
        .sent()
        .slice(before)
        .map((m) => m.kind),
    ).toEqual(['entry.state']);
    expect(t.onProposal).toHaveBeenLastCalledWith(false, false);
    t.say('failed', { rev: 3, reason: 'gap', entryId: 'e1' });
    expect(t.sent().at(-1)?.kind).toBe('entry.state');
    expect(t.sent('blocks.patch')).toHaveLength(1);
  });

  it('shows the saved entry after Confirm, with nothing proposed on it', () => {
    const t = proposing();
    t.host.setProposal([ghost]);
    t.host.setProposal(null);
    // The card saved it: the editor reads the entry again and sends it, the block now real.
    const saved = entry('Home', {
      fields: { title: 'Home', body: [{ _type: 'cta', _key: 'k1', label: 'Go' }, ghost.block] },
    });
    t.host.setEntry(saved, null);
    expect(t.sent().at(-1)).toMatchObject({ kind: 'entry.state', fields: saved.fields });
    expect(t.sent('blocks.patch')).toHaveLength(1);
  });

  it('drops a proposal the page refuses, rather than sending it to fail again', () => {
    const t = proposing();
    t.host.setProposal([ghost]);
    t.say('failed', { rev: 2, reason: 'conflict', entryId: 'e1' });
    expect(t.sent().at(-1)?.kind).toBe('entry.state');
    expect(t.onProposal).toHaveBeenLastCalledWith(false, true);
    t.say('failed', { rev: 3, reason: 'gap', entryId: 'e1' });
    expect(t.sent().at(-1)?.kind).toBe('entry.state');
    expect(t.sent('blocks.patch')).toHaveLength(1);
  });
});
