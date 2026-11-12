import { describe, expect, it } from 'vitest';
import { CONTENT_TYPE_ICON_WORDS, suggestContentTypeIcon } from '../src/index';

describe('the icon a content type’s name suggests', () => {
  it('reads the name’s words, plural or not', () => {
    expect(suggestContentTypeIcon({ name: 'Article' })).toBe('newspaper');
    expect(suggestContentTypeIcon({ name: 'Authors' })).toBe('user');
    expect(suggestContentTypeIcon({ name: 'Categories' })).toBe('tag');
    expect(suggestContentTypeIcon({ name: 'EVENT' })).toBe('calendar');
    expect(suggestContentTypeIcon({ apiId: 'FAQPage' })).toBe('file-text');
  });

  it('takes the last word that names one, the noun', () => {
    expect(suggestContentTypeIcon({ name: 'Landing page' })).toBe('file-text');
    expect(suggestContentTypeIcon({ name: 'Media contact' })).toBe('user');
    expect(suggestContentTypeIcon({ name: 'Press release' })).toBe('megaphone');
    expect(suggestContentTypeIcon({ name: 'Product review' })).toBe('star');
  });

  it('falls back to the API id only when the name says nothing', () => {
    expect(suggestContentTypeIcon({ name: 'Happening', apiId: 'eventListing' })).toBe('calendar');
    expect(suggestContentTypeIcon({ name: 'Recipe', apiId: 'eventListing' })).toBe('book-open');
  });

  it('suggests nothing for a name it has no word for, or an inherited key', () => {
    expect(suggestContentTypeIcon({ name: 'Widget', apiId: 'widget' })).toBeUndefined();
    expect(suggestContentTypeIcon({ name: 'constructor', apiId: 'toString' })).toBeUndefined();
    expect(suggestContentTypeIcon({})).toBeUndefined();
  });

  it('gives each word to one icon', () => {
    const words = Object.values(CONTENT_TYPE_ICON_WORDS).flat();
    expect(new Set(words).size).toBe(words.length);
  });
});
