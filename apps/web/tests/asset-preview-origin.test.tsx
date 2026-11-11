import type { Asset } from '@contentworker/domain';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AssetPreview, previewUrl } from '../app/cms/components/AssetPreview';

// In a deployment the API signs a read URL absolute on its own host (`MEDIA_BASE_URL`), which the
// admin's `img-src 'self'` refuses; the admin draws the same signed path from its own origin.
const asset = (file: Partial<Asset['file']>): Asset =>
  ({
    id: 'a1',
    title: { 'en-US': 'Hero' },
    file: { fileName: 'hero.png', contentType: 'image/png', size: 1, url: '', ...file },
  }) as unknown as Asset;

describe('asset previews draw from the admin origin', () => {
  it('turns an absolute api-host media URL into its same-origin path, keeping the signature', () => {
    const url = 'https://api.example.com/media/s1/main/a1/hero.png?exp=1&sig=abc';
    expect(previewUrl(asset({ url }))).toBe('/media/s1/main/a1/hero.png?exp=1&sig=abc');
  });

  it('keeps a root-relative media URL as it is', () => {
    expect(previewUrl(asset({ url: '/media/s1/main/a1/hero.png?sig=x' }))).toBe(
      '/media/s1/main/a1/hero.png?sig=x',
    );
  });

  it("leaves a hosted video's poster, on its own host, alone", () => {
    const poster = 'https://videos.example.net/abc/thumbnail.jpg';
    expect(
      previewUrl(
        asset({ contentType: 'video/mp4', video: { thumbnailUrl: poster } as never, url: 'x' }),
      ),
    ).toBe(poster);
  });

  it('renders the image from the same-origin path', () => {
    render(
      <AssetPreview
        asset={asset({ url: 'https://api.example.com/media/s1/main/a1/hero.png?sig=abc' })}
        alt="Hero"
      />,
    );
    expect(screen.getByRole('img', { name: 'Hero' }).getAttribute('src')).toBe(
      '/media/s1/main/a1/hero.png?sig=abc',
    );
  });
});
