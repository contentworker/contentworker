import { describe, expect, it } from 'vitest';
import { linkedFieldApiId } from '../app/cms/lib/entry-url';

describe('linkedFieldApiId', () => {
  it('focuses a top-level field as named', () => {
    expect(linkedFieldApiId('title')).toBe('title');
  });

  it('focuses the top-level field a path into blocks starts at', () => {
    expect(linkedFieldApiId('body[0192f1].heading')).toBe('body');
    expect(linkedFieldApiId('body[0192f1].ctas[0192e2].label')).toBe('body');
    expect(linkedFieldApiId('meta.title')).toBe('meta');
  });

  it('focuses nothing without a field', () => {
    expect(linkedFieldApiId(null)).toBeNull();
    expect(linkedFieldApiId('')).toBeNull();
    expect(linkedFieldApiId('[k].x')).toBeNull();
  });
});
