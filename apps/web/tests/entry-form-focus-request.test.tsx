// @vitest-environment jsdom
import type { ContentType } from '@contentworker/domain';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntryForm } from '~/cms/components/EntryForm';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const TYPE: ContentType = {
  apiId: 'page',
  name: 'Page',
  displayField: 'title',
  version: 1,
  status: 'published',
  fields: [
    {
      apiId: 'title',
      name: 'Title',
      type: 'Symbol',
      localized: false,
      required: false,
      position: 0,
    },
  ],
};

const form = (seq: number) => (
  <EntryForm
    contentType={TYPE}
    initial={{}}
    locales={['en-US']}
    defaultLocale="en-US"
    pickers={{ entries: [], assets: [] }}
    focusRequest={{ seq, apiId: 'title' }}
    onSave={() => {}}
    onCancel={() => {}}
  />
);

function reducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
    onchange: null,
  })) as typeof window.matchMedia;
}

describe('a pick from the Site frame focusing its field', () => {
  it('has focused the field by the time the scroll starts, so a smooth scroll cannot race it', () => {
    reducedMotion(false);
    let focusedAtScroll: Element | null = null;
    HTMLElement.prototype.scrollIntoView = vi.fn(function (this: HTMLElement) {
      focusedAtScroll = document.activeElement;
    });
    const view = render(form(0));
    view.rerender(form(1));
    const title = document.getElementById('field-title');
    expect(document.activeElement).toBe(title);
    expect(focusedAtScroll).toBe(title);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
      behavior: 'smooth',
    });
  });

  it('scrolls instantly when the person prefers reduced motion', () => {
    reducedMotion(true);
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const view = render(form(0));
    view.rerender(form(1));
    expect(document.activeElement).toBe(document.getElementById('field-title'));
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
      behavior: 'auto',
    });
  });
});
