import { describe, expect, it } from 'vitest';
import {
  adminEditUrl,
  blockKeyOf,
  type ContentRef,
  formatContentRef,
  formatFieldPath,
  parseContentRef,
  parseFieldPath,
  topLevelField,
} from '../src/index.js';

const base = {
  space: 's1',
  environment: 'main',
  entryId: 'e1',
  contentType: 'landing',
  locale: 'en-US',
} as const;

describe('field paths in refs', () => {
  const paths: [string, Parameters<typeof formatFieldPath>[0]][] = [
    ['title', { field: 'title', steps: [] }],
    ['body[0192f]', { field: 'body', steps: [{ key: '0192f' }] }],
    ['body[0192f].heading', { field: 'body', steps: [{ key: '0192f' }, { field: 'heading' }] }],
    [
      'body[0192f].ctas[0192e].label',
      {
        field: 'body',
        steps: [{ key: '0192f' }, { field: 'ctas' }, { key: '0192e' }, { field: 'label' }],
      },
    ],
  ];
  for (const [text, path] of paths) {
    it(`round-trips ${text}`, () => {
      expect(formatFieldPath(path)).toBe(text);
      expect(parseFieldPath(text)).toEqual(path);
      const ref: ContentRef = { ...base, field: text };
      expect(parseContentRef(formatContentRef(ref))).toEqual(ref);
    });
  }

  it('still parses an old six-part ref, its field a plain apiId', () => {
    const old = 's1|main|e1|landing|title|en-US';
    expect(parseContentRef(old)).toEqual({ ...base, field: 'title' });
    expect(parseFieldPath('title')).toEqual({ field: 'title', steps: [] });
  });

  it('keeps a path ref six parts, so an older parser reads the path as a field name', () => {
    const serialized = formatContentRef({ ...base, field: 'body[k1].heading' });
    const parts = serialized.split('|');
    expect(parts).toHaveLength(6);
    expect(decodeURIComponent(parts[4] as string)).toBe('body[k1].heading');
  });

  it('refuses what is not a path, and names that would make one', () => {
    for (const bad of [
      '',
      '[k1]',
      'body.heading',
      'body[k1][k2]',
      'body[]',
      'body[k1].',
      'body[k1',
    ]) {
      expect(parseFieldPath(bad)).toBeUndefined();
    }
    expect(() => formatFieldPath({ field: 'a.b', steps: [] })).toThrow();
    expect(() => formatFieldPath({ field: 'body', steps: [{ key: '' }] })).toThrow();
  });

  it('round-trips any stored key, brackets and escapes included', () => {
    for (const key of ['a]b', '[x]', '100%', '%5B', 'a%25]']) {
      const path = { field: 'body', steps: [{ key }, { field: 'heading' }] };
      const text = formatFieldPath(path);
      expect(parseFieldPath(text)).toEqual(path);
      expect(blockKeyOf(formatFieldPath({ field: 'body', steps: [{ key }] }))).toBe(key);
      const ref = { ...base, field: text };
      expect(parseContentRef(formatContentRef(ref))).toEqual(ref);
    }
  });

  it('reads a malformed escape as no ref, rather than throwing', () => {
    expect(parseContentRef('s1|main|e1|landing|%E0|en-US')).toBeUndefined();
  });

  it('names the top-level field and the block a path is in', () => {
    expect(topLevelField('body[k1].ctas[k2].label')).toBe('body');
    expect(topLevelField('title')).toBe('title');
    expect(blockKeyOf('body[k1].ctas[k2]')).toBe('k2');
    expect(blockKeyOf('body[k1].heading')).toBeUndefined();
    expect(blockKeyOf('title')).toBeUndefined();
  });

  it('passes a path whole to the entry form, which opens its top-level field', () => {
    const url = new URL(adminEditUrl('https://admin.test', { ...base, field: 'body[k1].heading' }));
    expect(url.pathname).toBe('/content/landing/e1');
    const field = url.searchParams.get('field') as string;
    expect(field).toBe('body[k1].heading');
    expect(topLevelField(field)).toBe('body');
  });
});
