/**
 * The pictures a block catalog names for its blocks, for the places that list blocks to pick (the
 * canvas dock, the entry form's Add block menu, Build → Blocks). Only `{ assetId }` thumbnails are
 * drawn: an asset is read through the management API, whose signed read URL is a `/media/…` path
 * the web Worker's gateway forwards to the api, so drawn from this origin the admin's
 * `img-src 'self'` takes it. A `{ url }` thumbnail is on the developer's own host, which that
 * policy refuses, so the block stays its name.
 *
 * Every asset a catalog names is read in one listing (`GET …/assets?ids=`, 100 a call; a catalog
 * holds at most 200 blocks), never one request per block. An asset that's gone, archived, not an
 * image, or not readable leaves its block without a picture. So does a hosted video: its poster is
 * on the video host's origin, which `img-src` refuses as it does a `{ url }` thumbnail.
 */
import type { Asset, BlockCatalog } from '@contentworker/domain';
import { useMemo } from 'react';
import { useClient } from './client-context';
import { sameOriginUpload } from './management';
import { useScopedQuery } from './queries';

/** The most ids one `GET …/assets?ids=` names. */
export const THUMBNAIL_LOOKUP_SIZE = 100;

/**
 * An image asset's signed read URL as this origin serves it, else null: never a URL the admin's
 * `img-src 'self'` would refuse. In a deployment the URL is absolute on the api's host
 * (`MEDIA_BASE_URL`); its signature covers the path and query, not the host, so its same-origin
 * path is the same read, through the gateway (`sameOriginUpload`).
 */
export function sameOriginImage(asset: Asset): string | null {
  const { url, contentType } = asset.file;
  if (!url || asset.file.video || !contentType.startsWith('image/')) return null;
  const path = sameOriginUpload(url);
  return path.startsWith('/media/') ? path : null;
}

/** The distinct asset ids a catalog's thumbnails name, sorted (so the lookup's key is stable). */
export function thumbnailAssetIds(catalog: BlockCatalog | null | undefined): string[] {
  const ids = new Set<string>();
  for (const b of catalog?.blocks ?? []) {
    if (b.thumbnail && 'assetId' in b.thumbnail) ids.add(b.thumbnail.assetId);
  }
  return [...ids].sort();
}

/** A catalog's pictures: `of(blockId)` its URL, and whether any block has one to draw. */
export interface BlockThumbnails {
  readonly of: (blockId: string) => string | undefined;
  /** Some block draws a picture: a list then holds each name's place for one, so names align. */
  readonly any: boolean;
}

/** No pictures: a form or a list drawn without a catalog's lookup. */
export const NO_THUMBNAILS: BlockThumbnails = { of: () => undefined, any: false };

/**
 * Each catalog block's thumbnail URL, by block id: undefined for a block without one the admin can
 * draw (none, a `{ url }` one, or an asset that couldn't be read). Silent: a failed lookup just
 * leaves the names.
 */
export function useBlockThumbnails(catalog: BlockCatalog | null | undefined): BlockThumbnails {
  const { client } = useClient();
  const ids = useMemo(() => thumbnailAssetIds(catalog), [catalog]);
  // Under `assets`, so a change in the library refreshes it as it does the library's own lists.
  const lookup = useScopedQuery(
    ['assets', 'block-thumbnails', ...ids],
    async () => {
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += THUMBNAIL_LOOKUP_SIZE) {
        chunks.push(ids.slice(i, i + THUMBNAIL_LOOKUP_SIZE));
      }
      const pages = await Promise.all(
        chunks.map((chunk) => client.listAssets({ ids: chunk, limit: chunk.length })),
      );
      const urls = new Map<string, string>();
      for (const asset of pages.flatMap((p) => p.items)) {
        const url = sameOriginImage(asset);
        if (url) urls.set(asset.id, url);
      }
      return urls;
    },
    { enabled: ids.length > 0, silent: true },
  );
  const urls = lookup.data;
  return useMemo(() => {
    const byBlock = new Map<string, string>();
    for (const b of catalog?.blocks ?? []) {
      const url = b.thumbnail && 'assetId' in b.thumbnail ? urls?.get(b.thumbnail.assetId) : null;
      if (url) byBlock.set(b.id, url);
    }
    return { of: (blockId: string) => byBlock.get(blockId), any: byBlock.size > 0 };
  }, [catalog, urls]);
}
