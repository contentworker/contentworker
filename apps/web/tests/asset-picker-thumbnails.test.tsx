// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntityPicker } from '~/cms/components/EntityPicker';
import type { PickOption } from '~/cms/components/EntryForm';

const conn = { space: 's', environment: 'main', locale: 'en-US' };
vi.mock('~/cms/lib/client-context', () => ({ useClient: () => ({ client: {}, conn }) }));
const ASSETS = [
  {
    id: 'img',
    title: { 'en-US': 'Coastline' },
    file: {
      fileName: 'coast.png',
      contentType: 'image/png',
      url: 'https://api.example.com/media/s/main/img/coast.png?exp=1&sig=abc',
    },
  },
  {
    id: 'doc',
    title: { 'en-US': 'Press kit' },
    file: { fileName: 'kit.pdf', contentType: 'application/pdf', url: '/media/s/main/doc/kit.pdf' },
  },
];
vi.mock('~/cms/lib/queries', () => ({
  useContentTypesQuery: () => ({ data: [] }),
  useAllEntriesQuery: () => ({ data: [] }),
  useAssetsQuery: () => ({ data: ASSETS }),
}));

const { useEntryPickers } = await import('~/cms/lib/pickers');

afterEach(cleanup);

const IMAGE: PickOption = {
  id: 'img',
  label: 'Coastline',
  mimeType: 'image/png',
  thumbnailUrl: '/media/s/main/img/coast.png?sig=abc',
};
const DOC: PickOption = { id: 'doc', label: 'Press kit', mimeType: 'application/pdf' };
const ENTRY: PickOption = { id: 'e1', label: 'Home (page)', title: 'Home', contentType: 'page' };

const thumbs = (root: HTMLElement) => root.querySelectorAll('img');

describe('asset picker options', () => {
  it('carry a same-origin thumbnail for an image, and none for a document', () => {
    const { result } = renderHook(() => useEntryPickers());
    const [image, doc] = result.current.pickers.assets;
    expect(image?.thumbnailUrl).toBe('/media/s/main/img/coast.png?exp=1&sig=abc');
    expect(doc?.thumbnailUrl).toBeUndefined();
  });
});

describe('an asset reference field', () => {
  const renderPicker = (value: string, options: readonly PickOption[] = [IMAGE, DOC]) =>
    render(
      <EntityPicker
        id="hero"
        ariaLabel="Hero image"
        options={options}
        value={value}
        onChange={() => {}}
      />,
    );

  it('shows the picked image beside its name', () => {
    const { container } = renderPicker('img');
    const field = screen.getByRole('combobox', { name: 'Hero image' }) as HTMLInputElement;
    expect(field.value).toBe('Coastline');
    const [img] = thumbs(container);
    expect(img?.getAttribute('src')).toBe(IMAGE.thumbnailUrl);
    // Decorative: the name in the field is what is read out.
    expect(img?.getAttribute('alt')).toBe('');
  });

  it('draws each option with its thumbnail, a document with its file icon', () => {
    renderPicker('');
    fireEvent.click(screen.getByRole('combobox', { name: 'Hero image' }));
    const list = screen.getByRole('listbox');
    const image = within(list).getByRole('option', { name: 'Coastline' });
    expect(image.querySelector('img')?.getAttribute('src')).toBe(IMAGE.thumbnailUrl);
    const doc = within(list).getByRole('option', { name: 'Press kit' });
    expect(doc.querySelector('img')).toBeNull();
    expect(within(doc).getByTestId('asset-thumb-fallback')).toBeTruthy();
  });

  it('falls back to the file icon when the image fails to load', () => {
    const { container } = renderPicker('img');
    const [img] = thumbs(container);
    fireEvent.error(img as HTMLImageElement);
    expect(thumbs(container)).toHaveLength(0);
    expect(screen.getByTestId('asset-thumb-fallback')).toBeTruthy();
  });

  it('draws no thumbnail for an entry reference', () => {
    const { container } = renderPicker('e1', [ENTRY]);
    expect(thumbs(container)).toHaveLength(0);
    expect(screen.queryByTestId('asset-thumb-fallback')).toBeNull();
  });
});
