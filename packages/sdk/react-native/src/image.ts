export interface ImageTransform {
  readonly width?: number;
  readonly height?: number;
  /** 1–100 */
  readonly quality?: number;
  readonly format?: 'webp' | 'jpeg' | 'png' | 'avif';
  /** Device pixel ratio multiplier applied to width/height (e.g. 2 or 3). */
  readonly dpr?: number;
}

/**
 * Appends image-CDN transform params to an asset URL — device-DPI sizing so
 * mobile fetches appropriately-scaled images. Param names match common image
 * CDNs (`w`, `h`, `q`, `fm`, `dpr`); point your CDN/origin at the asset bucket.
 */
export function imageUrl(url: string, t: ImageTransform = {}): string {
  const u = new URL(url);
  if (t.width !== undefined) u.searchParams.set('w', String(t.width));
  if (t.height !== undefined) u.searchParams.set('h', String(t.height));
  if (t.quality !== undefined) u.searchParams.set('q', String(t.quality));
  if (t.format) u.searchParams.set('fm', t.format);
  if (t.dpr !== undefined) u.searchParams.set('dpr', String(t.dpr));
  return u.toString();
}
