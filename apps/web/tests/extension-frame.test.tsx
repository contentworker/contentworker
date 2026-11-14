// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtensionFrame } from '~/cms/components/ExtensionFrame';

afterEach(cleanup);

const extension = {
  id: 'x1',
  name: 'Colour picker',
  target: 'field-editor' as const,
  entryUrl: 'about:blank',
  active: true,
  createdAt: '2026-11-03T00:00:00Z',
};

/** A message as the guest frame posts it: only one from the frame's own window is trusted. */
function postFromGuest(data: unknown) {
  const frame = screen.getByTitle('Colour picker') as HTMLIFrameElement;
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source: frame.contentWindow }));
  });
}

const context = (readOnly: boolean) => ({
  target: 'field-editor' as const,
  spaceId: 's1',
  environmentId: 'main',
  field: { apiId: 'colour', type: 'Symbol', locale: 'en-US' },
  value: '#fff',
  readOnly,
});

describe('a field editor extension', () => {
  it('takes the guest’s value while the field is open, and ignores it while read-only', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ExtensionFrame extension={extension} context={context(false)} onChange={onChange} />,
    );
    postFromGuest({ type: 'contentworker-extension:setValue', value: '#000' });
    expect(onChange).toHaveBeenCalledWith('#000');

    onChange.mockClear();
    rerender(<ExtensionFrame extension={extension} context={context(true)} onChange={onChange} />);
    postFromGuest({ type: 'contentworker-extension:setValue', value: '#f00' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('sends the guest `readOnly` in its context', () => {
    render(<ExtensionFrame extension={extension} context={context(true)} />);
    const frame = screen.getByTitle('Colour picker') as HTMLIFrameElement;
    const sent = vi.spyOn(frame.contentWindow as Window, 'postMessage');
    postFromGuest({ type: 'contentworker-extension:ready' });
    expect(sent).toHaveBeenCalledWith(
      {
        type: 'contentworker-extension:init',
        context: expect.objectContaining({ readOnly: true }),
      },
      '*',
    );
  });
});

describe('a sidebar extension', () => {
  const sidebar = { ...extension, name: 'Discoverability', target: 'sidebar' as const };

  it('is told the entry’s fields, their values and the admin’s theme, and again on a change', () => {
    document.documentElement.dataset.theme = 'dark';
    const context = {
      target: 'sidebar' as const,
      spaceId: 's1',
      environmentId: 'main',
      entryId: 'e1',
      locale: 'en-US',
      displayField: 'title',
      fields: [{ apiId: 'title', name: 'Title', type: 'Symbol' }],
      values: { title: { 'en-US': 'Winter tyres' } },
    };
    const { rerender } = render(<ExtensionFrame extension={sidebar} context={context} />);
    const frame = screen.getByTitle('Discoverability') as HTMLIFrameElement;
    const sent = vi.spyOn(frame.contentWindow as Window, 'postMessage');
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'contentworker-extension:ready' },
          source: frame.contentWindow,
        }),
      );
    });
    expect(sent).toHaveBeenLastCalledWith(
      { type: 'contentworker-extension:init', context: { ...context, theme: 'dark' } },
      '*',
    );

    const edited = { ...context, values: { title: { 'en-US': 'Winter tyres, explained' } } };
    rerender(<ExtensionFrame extension={sidebar} context={edited} />);
    expect(sent).toHaveBeenLastCalledWith(
      { type: 'contentworker-extension:init', context: { ...edited, theme: 'dark' } },
      '*',
    );
    document.documentElement.dataset.theme = 'light';
  });
});
