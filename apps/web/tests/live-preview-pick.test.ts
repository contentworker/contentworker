// A click in the Site pane's page names a field (its content ref) or a block (its key); the form is
// asked to show the field, in its locale, or the block in the blocks field holding it. And the side
// pane offers Site only for an entry whose type has a preview URL.
import type { ContentType, FieldDefinition } from '@contentworker/domain';
import { formatContentRef } from '@contentworker/sdk-core';
import { describe, expect, it } from 'vitest';
import { paneViews } from '~/cms/components/pane/use-pane-layout';
import { focusForPick, type PickContext } from '~/cms/lib/live-preview/pick';

const field = (apiId: string, extra: Partial<FieldDefinition> = {}) =>
  ({
    apiId,
    name: apiId,
    type: 'Symbol',
    localized: true,
    required: false,
    position: 0,
    ...extra,
  }) as FieldDefinition;

const type: Pick<ContentType, 'fields'> = {
  fields: [
    field('title'),
    field('body', {
      type: 'Array',
      localized: true,
      items: { type: 'Component', variants: [{ apiId: 'cta', name: 'CTA', fields: [] }] },
    } as Partial<FieldDefinition>),
  ],
};

const ctx: PickContext = {
  contentType: type,
  entryId: 'e1',
  locales: ['en-US', 'de'],
  locale: 'en-US',
  fields: {
    title: { 'en-US': 'Home' },
    body: {
      'en-US': [{ _type: 'cta', _key: 'a' }],
      de: [{ _type: 'cta', _key: 'b', items: [{ _type: 'cta', _key: 'deep' }] }],
    },
  },
};

const ref = (over: Partial<Parameters<typeof formatContentRef>[0]> = {}) =>
  formatContentRef({
    space: 's',
    environment: 'main',
    entryId: 'e1',
    contentType: 'page',
    field: 'title',
    locale: 'de',
    ...over,
  });

describe('a pick in the framed page', () => {
  it('focuses the field a ref names, in its locale', () => {
    expect(focusForPick({ ref: ref() }, ctx)).toEqual({ apiId: 'title', locale: 'de' });
    expect(focusForPick({ ref: ref({ locale: 'fr' }) }, ctx)).toEqual({ apiId: 'title' });
  });

  it('ignores a ref to another entry, a field the type lacks, or no ref at all', () => {
    expect(focusForPick({ ref: ref({ entryId: 'other' }) }, ctx)).toBeUndefined();
    expect(focusForPick({ ref: ref({ field: 'nope' }) }, ctx)).toBeUndefined();
    expect(focusForPick({ ref: 'not a ref' }, ctx)).toBeUndefined();
  });

  it('focuses the block a key names, in the blocks field and locale holding it, however deep', () => {
    expect(focusForPick({ key: 'a' }, ctx)).toEqual({
      apiId: 'body',
      locale: 'en-US',
      blockKey: 'a',
    });
    expect(focusForPick({ key: 'deep' }, ctx)).toEqual({
      apiId: 'body',
      locale: 'de',
      blockKey: 'deep',
    });
    expect(focusForPick({ key: 'missing' }, ctx)).toBeUndefined();
  });
});

describe('the side pane’s segments', () => {
  it('offers Site only when the type has a preview URL, before Activity', () => {
    expect(paneViews({ isEdit: true, hasSite: false, isAdmin: false })).toEqual([
      'details',
      'preview',
    ]);
    expect(paneViews({ isEdit: true, hasSite: true, isAdmin: true })).toEqual([
      'details',
      'preview',
      'site',
      'activity',
    ]);
    expect(paneViews({ isEdit: false, hasSite: true, isAdmin: true })).toEqual([]);
  });
});
