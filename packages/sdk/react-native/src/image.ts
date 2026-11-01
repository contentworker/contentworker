import { assetUrl, type DeliveredAsset } from '@contentworker/sdk-core';

export interface ImageOptions {
  /** Layout width in density-independent pixels. */
  readonly width?: number;
  /** Device pixel ratio (e.g. `PixelRatio.get()`); multiplies `width`. Default 1. */
  readonly dpr?: number;
  /** A rendition name; wins over `width` when the asset has it. */
  readonly rendition?: string;
}

/**
 * The URL to load an image asset at: the named rendition, else the width step at or above
 * `width × dpr` (so a 3× screen gets a sharp image and a 1× screen doesn't download it), else the
 * original. Every one is a URL the server built, never one with parameters added here: a delivered
 * URL is immutable on the media origin, and a Preview URL is signed.
 */
export function imageUrl(
  asset: Pick<DeliveredAsset, 'url' | 'renditions' | 'srcset'>,
  o: ImageOptions = {},
): string {
  if (o.rendition !== undefined) {
    const named = assetUrl(asset, { rendition: o.rendition });
    if (named) return named;
  }
  if (o.width !== undefined) {
    return assetUrl(asset, { width: Math.ceil(o.width * (o.dpr ?? 1)) }) ?? asset.url;
  }
  return asset.url;
}
