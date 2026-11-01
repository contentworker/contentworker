import type { DeliveredAsset } from '@contentworker/sdk-core';
import { describe, expect, it } from 'vitest';
import { imageUrl } from '../src/image.js';

const asset: Pick<DeliveredAsset, 'url' | 'renditions' | 'srcset'> = {
  url: 'https://media.test/s/main/a/v1/Q2p8kT1vXn4bR7sW0yZa3c/o/a.jpg',
  renditions: { thumb: 'https://media.test/s/main/a/v1/Q2p8kT1vXn4bR7sW0yZa3c/r-thumb/a.jpg' },
  srcset: [
    { width: 320, url: 'https://media.test/s/main/a/v1/Q2p8kT1vXn4bR7sW0yZa3c/w320/a.jpg?fm=auto' },
    { width: 640, url: 'https://media.test/s/main/a/v1/Q2p8kT1vXn4bR7sW0yZa3c/w640/a.jpg?fm=auto' },
    { width: 960, url: 'https://media.test/s/main/a/v1/Q2p8kT1vXn4bR7sW0yZa3c/w960/a.jpg?fm=auto' },
  ],
};

describe('imageUrl', () => {
  it('takes the width step at or above width × dpr', () => {
    expect(imageUrl(asset, { width: 300 })).toBe(asset.srcset[0]?.url);
    expect(imageUrl(asset, { width: 300, dpr: 2 })).toBe(asset.srcset[1]?.url);
    expect(imageUrl(asset, { width: 300, dpr: 3 })).toBe(asset.srcset[2]?.url);
  });

  it('prefers a rendition the asset has, and falls back when it has none', () => {
    expect(imageUrl(asset, { rendition: 'thumb', width: 900 })).toBe(asset.renditions.thumb);
    expect(imageUrl(asset, { rendition: 'nope', width: 600 })).toBe(asset.srcset[1]?.url);
    expect(imageUrl(asset, { rendition: 'nope' })).toBe(asset.url);
  });

  it('never adds parameters to the URL it was given', () => {
    const signed = { ...asset, url: 'https://media.test/media/k?exp=1&sig=x', srcset: [] };
    expect(imageUrl(signed, { width: 400, dpr: 2 })).toBe(signed.url);
    expect(imageUrl(signed)).toBe(signed.url);
  });
});
