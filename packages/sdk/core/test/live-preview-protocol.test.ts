import { describe, expect, it } from 'vitest';
import {
  type AdminMessage,
  acceptMessage,
  CAPABILITIES,
  capabilityAllows,
  contentValueIssue,
  type FrontendMessage,
  isChannel,
  isSafeTokenValue,
  MAX_MESSAGE_BYTES,
  MAX_PATCH_OPS,
  narrowCapabilities,
  negotiateVersion,
  newChannel,
  OFFERED_VERSIONS,
  parseAdminMessage,
  parseFrontendMessage,
  SUPPORTED_VERSIONS,
} from '../src/live-preview.js';

const ADMIN = 'https://admin.test';
const SITE = 'https://site.test';
const parentWindow = { name: 'admin window' };
const frameWindow = { name: 'frame window' };
const CHANNEL = 'AAAAAAAAAAAAAAAAAAAAAA';

describe('the three checks', () => {
  // Each side, as its `Expected`: who may send, on which channel, at which version.
  const sides = {
    frontend: { origin: ADMIN, source: parentWindow, channel: CHANNEL, version: 1 },
    admin: { origin: SITE, source: frameWindow, channel: CHANNEL, version: 1 },
  } as const;
  const good = { v: 1, channel: CHANNEL, kind: 'select', ref: null };

  // One row per factor: removing a check fails the row that names it.
  const rows: [string, (e: { origin: string; source: unknown; data: unknown }) => void][] = [
    ['the wrong origin', (e) => (e.origin = 'https://evil.test')],
    ['the wrong sender', (e) => (e.source = { name: 'another window' })],
    ['no sender', (e) => (e.source = null)],
    ['the wrong channel', (e) => (e.data = { ...good, channel: 'BBBBBBBBBBBBBBBBBBBBBB' })],
    ['a missing channel', (e) => (e.data = { ...good, channel: undefined })],
    ['a malformed channel', (e) => (e.data = { ...good, channel: 'short' })],
    ['an unknown version', (e) => (e.data = { ...good, v: 2 })],
    ['a missing version', (e) => (e.data = { ...good, v: undefined })],
    ['data that is not an object', (e) => (e.data = 'select')],
  ];

  for (const [side, expected] of Object.entries(sides)) {
    const event = () => ({ origin: expected.origin, source: expected.source, data: { ...good } });

    it(`${side}: takes a message that passes all three`, () => {
      expect(acceptMessage(event(), expected)).toEqual(good);
    });

    for (const [factor, spoil] of rows) {
      it(`${side}: drops a message with ${factor}`, () => {
        const e = event();
        spoil(e);
        expect(acceptMessage(e, expected)).toBeUndefined();
      });
    }
  }

  it('admin, before connect: takes an offer on any well-formed new channel', () => {
    const offer = { v: 1, channel: newChannel(), kind: 'connect.offer' };
    const waiting = { origin: SITE, source: frameWindow };
    expect(
      acceptMessage({ origin: SITE, source: frameWindow, data: offer }, waiting),
    ).toBeDefined();
    expect(
      acceptMessage(
        { origin: SITE, source: frameWindow, data: { ...offer, channel: 'x' } },
        waiting,
      ),
    ).toBeUndefined();
  });

  it('mints 128-bit base64url channels, a new one each time', () => {
    const a = newChannel();
    expect(isChannel(a)).toBe(true);
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(new Set(Array.from({ length: 50 }, () => newChannel())).size).toBe(50);
  });
});

describe('version negotiation', () => {
  const matrix: [string, unknown[], number[], number | undefined][] = [
    ['a shared version', [1], [1], 1],
    ['the highest shared version', [3, 2, 1], [1, 2], 2],
    ['no shared version', [2], [1], undefined],
    ['unknown versions in the offer', [99, 'x', -1, 1.5, 1], [1], 1],
    ['an empty offer', [], [1], undefined],
  ];
  for (const [name, offered, supported, want] of matrix) {
    it(name, () => expect(negotiateVersion(offered, supported)).toBe(want));
  }

  it('keeps every version this SDK offers on the admin’s list', () => {
    for (const v of OFFERED_VERSIONS) expect(SUPPORTED_VERSIONS).toContain(v);
  });

  it('parses a reject carrying the admin’s versions', () => {
    const reject = {
      v: 1,
      channel: CHANNEL,
      kind: 'connect.reject',
      reason: 'unsupported-version',
      versions: [3, 4],
    };
    expect(parseAdminMessage(reject)).toEqual({ ok: true, message: reject });
  });
});

describe('capabilities', () => {
  it('drops proposals without patch.blocks: there is no state to lay them on', () => {
    expect(narrowCapabilities(['select', 'proposals'])).toEqual(['select']);
    expect(narrowCapabilities(['patch.blocks', 'proposals'])).toEqual([
      'patch.blocks',
      'proposals',
    ]);
  });

  it('narrows, never widens', () => {
    expect(narrowCapabilities(['select', 'scroll', 'telepathy'], ['select'])).toEqual(['select']);
    expect(narrowCapabilities(['select'], CAPABILITIES)).toEqual(['select']);
  });

  const msg = (kind: string, body: Record<string, unknown>) =>
    ({ v: 1, channel: CHANNEL, kind, ...body }) as unknown as AdminMessage;
  const at = { rev: 1, entryId: 'e1', locale: 'en-US' };
  const cases: [string, AdminMessage | FrontendMessage, string[], boolean][] = [
    [
      'entry.patch needs patch.fields',
      msg('entry.patch', { ...at, fields: {} }),
      ['patch.blocks'],
      false,
    ],
    [
      'entry.patch with patch.fields',
      msg('entry.patch', { ...at, fields: {} }),
      ['patch.fields'],
      true,
    ],
    [
      'entry.state needs a patch capability',
      msg('entry.state', { ...at, fields: {} }),
      ['select'],
      false,
    ],
    [
      'entry.state with patch.blocks',
      msg('entry.state', { ...at, fields: {} }),
      ['patch.blocks'],
      true,
    ],
    [
      'a proposed op needs proposals',
      msg('blocks.patch', {
        ...at,
        field: 'body',
        ops: [{ op: 'remove', key: 'k', proposed: true }],
      }),
      ['patch.blocks'],
      false,
    ],
    [
      'a real op needs patch.blocks',
      msg('blocks.patch', { ...at, field: 'body', ops: [{ op: 'remove', key: 'k' }] }),
      ['proposals'],
      false,
    ],
    ['select needs select', msg('select', { ref: null }), ['scroll'], false],
    ['scroll needs scroll', msg('scroll', { ref: 'r' }), ['select'], false],
    ['pointer needs select', msg('pointer', {}) as unknown as FrontendMessage, [], false],
    ['layout needs layout', msg('layout', {}) as unknown as FrontendMessage, ['select'], false],
    ['applied needs nothing', msg('applied', { rev: 1 }) as unknown as FrontendMessage, [], true],
  ];
  for (const [name, message, accepted, allowed] of cases) {
    it(name, () => expect(capabilityAllows(message, accepted as never)).toBe(allowed));
  }
});

describe('schemas', () => {
  const env = { v: 1, channel: CHANNEL };
  const at = { rev: 2, entryId: 'e1', locale: 'en-US' };

  it('rebuilds a message from its validated fields only', () => {
    const parsed = parseAdminMessage({ ...env, kind: 'select', ref: 'r', onclick: 'alert(1)' });
    expect(parsed).toEqual({ ok: true, message: { ...env, kind: 'select', ref: 'r' } });
  });

  it('fills each block op’s field and locale from the message', () => {
    const parsed = parseAdminMessage({
      ...env,
      kind: 'blocks.patch',
      ...at,
      field: 'body',
      ops: [
        { op: 'remove', key: 'k1' },
        { op: 'insert', block: { _type: 'cta' }, proposed: true },
      ],
    });
    expect(parsed.ok && parsed.message.kind === 'blocks.patch' && parsed.message.ops).toEqual([
      { op: 'remove', key: 'k1', field: 'body', locale: 'en-US' },
      { op: 'insert', block: { _type: 'cta' }, proposed: true, field: 'body', locale: 'en-US' },
    ]);
  });

  const malformed: [string, Record<string, unknown>][] = [
    ['entry.state without fields', { kind: 'entry.state', ...at }],
    ['entry.state with a negative rev', { kind: 'entry.state', ...at, rev: -1, fields: {} }],
    [
      'entry.patch with a prototype field',
      { kind: 'entry.patch', ...at, fields: JSON.parse('{"__proto__":{"x":1}}') },
    ],
    ['blocks.patch with no ops', { kind: 'blocks.patch', ...at, field: 'body', ops: [] }],
    [
      'blocks.patch over the op cap',
      {
        kind: 'blocks.patch',
        ...at,
        field: 'body',
        ops: Array.from({ length: MAX_PATCH_OPS + 1 }, () => ({ op: 'remove', key: 'k' })),
      },
    ],
    [
      'blocks.patch with an op on another field',
      {
        kind: 'blocks.patch',
        ...at,
        field: 'body',
        ops: [{ op: 'remove', key: 'k', field: 'aside' }],
      },
    ],
    [
      'blocks.patch with an unknown op',
      { kind: 'blocks.patch', ...at, field: 'body', ops: [{ op: 'eval', key: 'k' }] },
    ],
    [
      'blocks.patch with proposed: false',
      {
        kind: 'blocks.patch',
        ...at,
        field: 'body',
        ops: [{ op: 'remove', key: 'k', proposed: false }],
      },
    ],
    ['select with a number', { kind: 'select', ref: 3 }],
    ['scroll without a ref', { kind: 'scroll' }],
    ['editing with a string', { kind: 'editing', on: 'yes' }],
    ['accept with a version of 0', { kind: 'connect.accept', version: 0, capabilities: [] }],
    ['a Map anywhere', { kind: 'entry.state', ...at, fields: { title: new Map() } }],
  ];
  for (const [name, body] of malformed) {
    it(`drops ${name} whole`, () => {
      expect(parseAdminMessage({ ...env, ...body })).toEqual({ ok: false, reason: 'invalid' });
    });
  }

  it('drops a message over the cap as too large, and ignores an unknown kind', () => {
    const big = {
      ...env,
      kind: 'entry.patch',
      ...at,
      fields: { title: 'x'.repeat(MAX_MESSAGE_BYTES) },
    };
    expect(parseAdminMessage(big)).toEqual({ ok: false, reason: 'too-large' });
    expect(parseAdminMessage({ ...env, kind: 'run.script' })).toEqual({
      ok: false,
      reason: 'unknown',
    });
  });

  it('drops fuzzed messages whole, never throwing', () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    const values = [
      null,
      0,
      -1,
      1.5,
      '',
      'x',
      '__proto__',
      [],
      {},
      true,
      Number.NaN,
      'https://site.test/',
      [1, 2],
    ];
    const kinds = [
      'entry.state',
      'entry.patch',
      'blocks.patch',
      'select',
      'scroll',
      'editing',
      'connect.accept',
      'page',
      'pointer',
      'layout',
      'failed',
    ];
    const keys = [
      'rev',
      'entryId',
      'locale',
      'fields',
      'field',
      'ops',
      'ref',
      'on',
      'url',
      'entries',
      'pointer',
      'rect',
      'reason',
      'version',
      'capabilities',
    ];
    for (let i = 0; i < 2000; i++) {
      const m: Record<string, unknown> = { ...env, kind: kinds[Math.floor(rand() * kinds.length)] };
      for (const k of keys) if (rand() < 0.5) m[k] = values[Math.floor(rand() * values.length)];
      for (const parse of [parseAdminMessage, parseFrontendMessage]) {
        const result = parse(m);
        if (result.ok) {
          // Whatever passes is a fresh object holding only known fields.
          expect(result.message).not.toBe(m);
          expect(JSON.stringify(result.message)).not.toContain('__proto__');
        }
      }
    }
  });

  it('refuses a page message the admin should not act on', () => {
    const bad = [
      { kind: 'navigated', url: 'javascript:alert(1)' },
      { kind: 'navigated', url: 'http://site.test/' },
      { kind: 'pointer', pointer: 'click', ref: null, rect: null },
      { kind: 'pointer', pointer: 'hover', ref: 'r', rect: { x: Number.NaN, y: 0, w: 0, h: 0 } },
      {
        kind: 'page',
        url: 'https://site.test/',
        entries: [{ entryId: 'constructor', contentType: 't', locale: 'en' }],
      },
      { kind: 'failed', rev: 1, reason: 'boom' },
      { kind: 'connect.offer', versions: [], capabilities: [], sdk: { name: 'x', version: '1' } },
    ];
    for (const m of bad)
      expect(parseFrontendMessage({ ...env, ...m })).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses a tiny message holding a huge list or a typed array, at once', () => {
    const at = { rev: 1, entryId: 'e1', locale: 'en-US' };
    const layout = {
      scroll: { x: 0, y: 0 },
      viewport: { w: 1, h: 1 },
      docHeight: 1,
      slots: [],
      fields: [],
    };
    const started = performance.now();
    for (const blocks of [new Array(1e8), new Uint8Array(3e7)]) {
      const result = parseFrontendMessage({ ...env, kind: 'layout', ...layout, blocks });
      expect(result.ok).toBe(false);
    }
    expect(
      parseAdminMessage({ ...env, kind: 'entry.state', ...at, fields: { body: new Array(1e8) } })
        .ok,
    ).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('types values: rich text is a document, never a string of HTML', () => {
    expect(contentValueIssue('RichText', { nodeType: 'document', content: ['<b>x</b>'] })).toMatch(
      /never as HTML/,
    );
    expect(
      contentValueIssue('RichText', {
        nodeType: 'document',
        content: [
          { nodeType: 'paragraph', content: [{ nodeType: 'text', value: 'Hi', marks: [] }] },
        ],
      }),
    ).toBeUndefined();
    expect(contentValueIssue('RichText', '<p>Hello <b>world</b></p>')).toMatch(/never as HTML/);
    expect(contentValueIssue('RichText', { nodeType: 'document', content: [] })).toBeUndefined();
    expect(contentValueIssue('Symbol', 'a < b')).toBeUndefined();
  });
});

describe('isSafeTokenValue', () => {
  const allowed = [
    '1rem',
    '#7c3aed',
    'var(--cw-space-lg)',
    'calc(1rem + 2px)',
    'calc((1rem + 2px) * 2)',
    'clamp(1rem, 2vw, 3rem)',
    'min(10px, 5vw)',
    'max(10px, 5vw)',
    'rgb(0 0 0 / 50%)',
    'hsl(260 80% 50%)',
    'oklch(0.6 0.2 290)',
    'CALC(1px + 1px)',
    'Inter, system-ui, sans-serif',
  ];
  for (const value of allowed)
    it(`accepts ${value}`, () => expect(isSafeTokenValue(value)).toBe(true));

  const refused = [
    'url(https://evil.test/x.png)',
    'URL(https://evil.test/x.png)',
    'uRl (x)',
    'u\\rl(x)',
    'u\\72 l(x)',
    '@import "x.css"',
    '@IMPORT "x.css"',
    'expression(alert(1))',
    'EXPRESSION(alert(1))',
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '<script>',
    'a > b',
    'calc(1px + url(x))',
    'var(--x, url(x))',
    'rgba(0, 0, 0, 0.5)',
    'image-set("x.png" 1x)',
    'attr(data-x)',
    'env(safe-area-inset-top)',
    'red; background: red',
    'red } body { color: red',
    'u/**/rl(x)',
    'ur&#108(https://evil.test/x)',
    '&#117rl(x)',
    'a" onfocus="alert(1)',
    "a' onfocus='x",
    '`x`',
    '"Inter", sans-serif',
    'red\nblue',
    'x'.repeat(300),
  ];
  for (const value of refused) {
    it(`refuses ${JSON.stringify(value).slice(0, 40)}`, () =>
      expect(isSafeTokenValue(value)).toBe(false));
  }

  it('refuses anything that is not a string', () => {
    for (const value of [null, undefined, 1, {}, ['red']])
      expect(isSafeTokenValue(value)).toBe(false);
  });
});
