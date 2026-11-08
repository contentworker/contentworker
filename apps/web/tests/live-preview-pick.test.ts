// A click in the framed page names what it hit by its content ref, whose field is a path
// (`body[k1].items[k2].label`). The form opens the top-level field, focuses the innermost block
// the path passes through, in the ref's locale; and only for this entry, in this space and
// environment, of this type, which the page said it renders. The form names its focused field
// back the same way, the path found through every block that holds it. And the side pane offers
// Site only for a type with a preview URL.
import type { ContentType, FieldDefinition } from '@contentworker/domain';
import { formatContentRef, parseContentRef, topLevelField } from '@contentworker/sdk-core';
import { describe, expect, it } from 'vitest';
import { paneViews } from '~/cms/components/pane/use-pane-layout';
import { focusForRef, type PickContext, refForField } from '~/cms/lib/live-preview/pick';

const type: Pick<ContentType, 'apiId' | 'fields'> = {
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
    { apiId: 'body', name: 'Body', type: 'Array', localized: false, required: false, position: 1 },
  ] as FieldDefinition[],
};

const ctx: PickContext = {
  space: 's',
  environment: 'main',
  entryId: 'e1',
  contentType: type,
  locales: ['en-US', 'de'],
  pageEntries: ['e1', 'e2'],
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

describe('a click in the framed page', () => {
  it('focuses the field a ref names, in its locale', () => {
    expect(focusForRef(ref(), ctx)).toEqual({ apiId: 'title', locale: 'de' });
    expect(focusForRef(ref({ locale: 'fr' }), ctx)).toEqual({ apiId: 'title' });
  });

  it('focuses the innermost block a path passes through, in its top-level field', () => {
    expect(focusForRef(ref({ field: 'body[k1]' }), ctx)).toEqual({
      apiId: 'body',
      locale: 'de',
      blockKey: 'k1',
    });
    expect(focusForRef(ref({ field: 'body[k1].items[k2].label' }), ctx)).toMatchObject({
      apiId: 'body',
      blockKey: 'k2',
    });
  });

  it('ignores a ref the page didn’t report, to another entry, space or type, or no ref at all', () => {
    expect(focusForRef(ref(), { ...ctx, pageEntries: ['e2'] })).toBeUndefined();
    expect(focusForRef(ref({ entryId: 'e2' }), ctx)).toBeUndefined();
    expect(focusForRef(ref({ space: 'other' }), ctx)).toBeUndefined();
    expect(focusForRef(ref({ environment: 'staging' }), ctx)).toBeUndefined();
    expect(focusForRef(ref({ contentType: 'post' }), ctx)).toBeUndefined();
    expect(focusForRef(ref({ field: 'nope' }), ctx)).toBeUndefined();
    expect(focusForRef(ref({ field: 'body[' }), ctx)).toBeUndefined();
    expect(focusForRef('not a ref', ctx)).toBeUndefined();
  });
});

describe('the form’s focused field on the page', () => {
  it('names a field, and a block by every block and slot holding it', () => {
    const at = { space: 's', environment: 'main', entryId: 'e1', contentType: type };
    expect(parseContentRef(refForField(at, 'en-US', 'title'))?.field).toBe('title');
    const body = [{ _type: 'cols', _key: 'k1', items: [{ _type: 'cta', _key: 'k2' }] }];
    expect(parseContentRef(refForField(at, 'en-US', 'body', 'k2', body))?.field).toBe(
      'body[k1].items[k2]',
    );
    // A key the value doesn't hold names the field alone.
    expect(parseContentRef(refForField(at, 'en-US', 'body', 'gone', body))?.field).toBe('body');
  });

  it('opens an inline-edit deep link’s top-level field from its path', () => {
    expect(topLevelField('body[k1].heading')).toBe('body');
    expect(topLevelField('title')).toBe('title');
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
