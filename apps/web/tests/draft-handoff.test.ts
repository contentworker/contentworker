// One draft, two views: what the entry form and the canvas hand each other as they switch.
import { afterEach, describe, expect, it } from 'vitest';
import {
  changedFields,
  clearHandedDraft,
  draftId,
  handOffDraft,
  isOtherView,
  peekDraft,
  settleDraft,
} from '~/cms/lib/draft-handoff';

afterEach(() => clearHandedDraft());

describe('isOtherView', () => {
  it('is the same entry’s form and canvas, either way', () => {
    expect(isOtherView('/content/page/e1', '/content/page/e1/canvas')).toBe(true);
    expect(isOtherView('/content/page/e1/canvas', '/content/page/e1')).toBe(true);
    expect(isOtherView('/content/page/e1/', '/content/page/e1/canvas')).toBe(true);
  });

  it('is never another entry, the same view, or anything but an entry', () => {
    expect(isOtherView('/content/page/e1', '/content/page/e2/canvas')).toBe(false);
    expect(isOtherView('/content/page/e1', '/content/page/e1')).toBe(false);
    expect(isOtherView('/content/page/e1', '/content/page')).toBe(false);
    expect(isOtherView('/content/page', '/content/page/canvas')).toBe(false);
    expect(isOtherView('/assets/a1', '/assets/a1/canvas')).toBe(false);
  });
});

describe('changedFields', () => {
  it('keeps only the top-level fields whose value differs', () => {
    const base = { title: { 'en-US': 'Home' }, body: { 'en-US': [{ _key: 'a' }] } };
    expect(changedFields({ ...base, title: { 'en-US': 'Start' } }, base)).toEqual({
      title: { 'en-US': 'Start' },
    });
    expect(changedFields(base, base)).toEqual({});
    expect(changedFields({ ...base, slug: { 'en-US': 'home' } }, base)).toEqual({
      slug: { 'en-US': 'home' },
    });
  });
});

describe('the handed draft', () => {
  const id = draftId('sp', 'main', 'e1');

  it('waits for its own entry only, and is read without being taken', () => {
    handOffDraft(id, 3, { title: { 'en-US': 'Mine' } }, 1_000);
    expect(peekDraft(draftId('sp', 'main', 'e2'), 1_000)).toBeNull();
    expect(peekDraft(draftId('sp', 'other', 'e1'), 1_000)).toBeNull();
    const held = peekDraft(id, 1_500);
    expect(held?.version).toBe(3);
    expect(peekDraft(id, 1_500)).toBe(held);
  });

  it('is gone once settled, and a settle of an older draft leaves a newer one', () => {
    handOffDraft(id, 3, {}, 1_000);
    const first = peekDraft(id, 1_000);
    handOffDraft(id, 4, {}, 1_100);
    if (first) settleDraft(first);
    expect(peekDraft(id, 1_100)?.version).toBe(4);
    const second = peekDraft(id, 1_100);
    if (second) settleDraft(second);
    expect(peekDraft(id, 1_100)).toBeNull();
  });

  it('is dropped when no view took it in within 30 seconds', () => {
    handOffDraft(id, 3, {}, 0);
    expect(peekDraft(id, 30_000)).not.toBeNull();
    expect(peekDraft(id, 30_001)).toBeNull();
  });
});
