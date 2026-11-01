import { DomainError, InvalidStateError, ValidationError } from '../errors';
import type { ReferenceEdge } from '../reference/references';
import type { LocalizedValue } from '../types';

/** Metadata describing the stored binary (the bytes live in the BlobStore). */
export interface AssetFile {
  /** Download URL (presigned or public). */
  readonly url: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly size?: number;
  readonly width?: number;
  readonly height?: number;
  /**
   * Present on video assets hosted by a video service (Cloudflare Stream):
   * the bytes live there, not in the BlobStore, and playback is adaptive
   * streaming rather than a single download URL.
   */
  readonly video?: AssetVideo;
}

/** Processing lifecycle of a hosted video, normalized across providers. */
export type AssetVideoStatus = 'pending' | 'processing' | 'ready' | 'error';

/** Where a hosted video lives and how to play it. */
export interface AssetVideo {
  /** Video host that owns the bytes, e.g. `stream`. */
  readonly provider: string;
  /** The host's id for the video. */
  readonly videoId: string;
  readonly status: AssetVideoStatus;
  /** HLS manifest URL, once the host can serve it. */
  readonly hlsUrl?: string;
  /** DASH manifest URL, once the host can serve it. */
  readonly dashUrl?: string;
  /** Poster frame URL. */
  readonly thumbnailUrl?: string;
  readonly durationSeconds?: number;
  /** Host-reported reason when `status` is `error`. */
  readonly errorReason?: string;
}

/** True when an asset's bytes are a hosted video rather than a blob. */
export function isHostedVideo(asset: { readonly file: AssetFile }): boolean {
  return asset.file.video !== undefined;
}

export type AssetStatus = 'draft' | 'published' | 'archived';

/**
 * What an asset is, for filtering and for choosing how to show it. Derived from the content
 * type (never chosen by a client), so two assets with the same bytes always agree.
 */
export type AssetKind = 'image' | 'video' | 'audio' | 'document' | 'other';

export const ASSET_KINDS: readonly AssetKind[] = ['image', 'video', 'audio', 'document', 'other'];

/** Office, PDF and text formats an editor thinks of as documents rather than files. */
const DOCUMENT_TYPES = new Set([
  'application/pdf',
  'application/rtf',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/epub+zip',
]);

/** The {@link AssetKind} a content type belongs to; parameters (`; charset=…`) are ignored. */
export function assetKind(contentType: string): AssetKind {
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (
    mime.startsWith('text/') ||
    DOCUMENT_TYPES.has(mime) ||
    mime.startsWith('application/vnd.openxmlformats-officedocument.')
  ) {
    return 'document';
  }
  return 'other';
}

/**
 * Usage rights carried with an asset. `expiresAt` is when it must stop being delivered and
 * `embargoUntil` the earliest it may be (both ISO-8601); enforcing them is the scheduler's job.
 */
export interface AssetRights {
  readonly license?: string;
  readonly credit?: string;
  readonly expiresAt?: string;
  readonly embargoUntil?: string;
}

/**
 * A relative focal point (0..1 on each axis) marking the visually important
 * region of an image, so transforms can crop toward it instead of the center.
 */
export interface FocalPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Editorial media metadata ("Aspects"): localized alt text for accessibility,
 * a focal point for smart cropping, taxonomy tag ids, and free-form custom
 * fields. Distinct from {@link AssetFile}, which describes the stored bytes.
 */
export interface AssetMetadata {
  readonly altText: LocalizedValue;
  readonly tags: readonly string[];
  readonly focalPoint?: FocalPoint;
  readonly fields?: Readonly<Record<string, unknown>>;
}

/** The metadata a freshly-created asset carries before anyone edits it. */
export const emptyAssetMetadata: AssetMetadata = { altText: {}, tags: [] };

/**
 * An asset: a managed binary (image, document, …) with localized title and
 * description. One current file; `version` counts its replacements, so every
 * file it has had can be addressed apart.
 */
export interface Asset {
  readonly id: string;
  readonly status: AssetStatus;
  readonly file: AssetFile;
  readonly title: LocalizedValue;
  readonly description: LocalizedValue;
  readonly metadata: AssetMetadata;
  /** The folder it is filed in; absent at the library's root. */
  readonly folderId?: string;
  /** Starts at 1 and goes up each time the file is replaced. Absent reads as 1. */
  readonly version?: number;
  /** Where the bytes live in blob storage; absent for a hosted video. */
  readonly r2Key?: string;
  /** SHA-256 of the bytes (hex), once ingest has read them. */
  readonly contentHash?: string;
  readonly createdAt?: string;
  /** Who created it, as the audit log names actors. */
  readonly createdBy?: string;
  /** When it was archived; present only while `status` is `archived`. */
  readonly archivedAt?: string;
  readonly rights?: AssetRights;
}

/**
 * Merges a metadata patch onto an asset, validating the focal point stays
 * within the unit square. Only keys present (non-`undefined`) in the patch
 * override existing values, so a partial update never clears omitted fields.
 * Returns a new asset; the caller persists it.
 */
export function applyAssetMetadata(asset: Asset, patch: Partial<AssetMetadata>): Asset {
  const focalPoint = patch.focalPoint ?? asset.metadata.focalPoint;
  if (
    focalPoint &&
    (focalPoint.x < 0 || focalPoint.x > 1 || focalPoint.y < 0 || focalPoint.y > 1)
  ) {
    throw new ValidationError([
      { field: 'focalPoint', message: 'Focal point coordinates must be between 0 and 1' },
    ]);
  }
  const fields = patch.fields ?? asset.metadata.fields;
  return {
    ...asset,
    metadata: {
      altText: patch.altText ?? asset.metadata.altText,
      tags: patch.tags ?? asset.metadata.tags,
      ...(focalPoint ? { focalPoint } : {}),
      ...(fields ? { fields } : {}),
    },
  };
}

export function publishAsset(asset: Asset): Asset {
  if (asset.status === 'archived') throw new InvalidStateError('Cannot publish an archived asset');
  return { ...asset, status: 'published' };
}

export function unpublishAsset(asset: Asset): Asset {
  if (asset.status !== 'published') throw new InvalidStateError('Asset is not published');
  return { ...asset, status: 'draft' };
}

/**
 * Takes an asset out of use without deleting it: it leaves Delivery (the caller removes the
 * published snapshot) and can't be published until it is restored.
 */
export function archiveAsset(asset: Asset, at: string): Asset {
  if (asset.status === 'archived') throw new InvalidStateError('Asset is already archived');
  return { ...asset, status: 'archived', archivedAt: at };
}

/** Brings an archived asset back as a draft; publishing it again is a separate step. */
export function restoreAsset(asset: Asset): Asset {
  if (asset.status !== 'archived') throw new InvalidStateError('Asset is not archived');
  const { archivedAt: _archivedAt, ...rest } = asset;
  return { ...rest, status: 'draft' };
}

/**
 * One link that holds an asset, with what a person needs to recognise the entry: its content type
 * and its display title (absent when the entry is gone or has no title).
 */
export interface AssetUsage extends ReferenceEdge {
  readonly contentTypeApiId?: string;
  readonly entryTitle?: string;
}

/** Most links an {@link AssetInUseError} carries; `total` still counts them all. */
export const MAX_ASSET_USAGE_SHOWN = 50;

/**
 * Deleting an asset that entries still link to would leave those links dangling in Delivery, so
 * it is refused; `usage` names the links (the first {@link MAX_ASSET_USAGE_SHOWN}) and `total`
 * counts them, for the caller to show or to clear first.
 */
export class AssetInUseError extends DomainError {
  readonly usage: readonly AssetUsage[];
  readonly total: number;
  constructor(assetId: string, usage: readonly AssetUsage[], total = usage.length) {
    const shown = usage.slice(0, MAX_ASSET_USAGE_SHOWN);
    super(
      'asset_in_use',
      `Asset "${assetId}" is linked from ${total} entr${total === 1 ? 'y' : 'ies'}; remove those links before deleting it, or archive it instead`,
      { usage: shown, total },
    );
    this.usage = shown;
    this.total = total;
  }
}

/**
 * A folder in the asset library. Folders nest; `path` is the materialized path of ids from the
 * root (`/a/b/` for `b` inside `a`), so a subtree is one prefix match and a move rewrites one
 * prefix.
 */
export interface AssetFolder {
  readonly id: string;
  readonly name: string;
  /** The folder it sits in; absent at the root. */
  readonly parentId?: string;
  readonly path: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Folders nest at most this deep, so a path (and the tree an editor reads) stays bounded. */
export const MAX_ASSET_FOLDER_DEPTH = 16;

/** Trims and checks a folder name: 1..128 characters, no `/` (paths are built from ids, but a
 *  slash in a name reads as nesting). */
export function assetFolderName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 128 || trimmed.includes('/')) {
    throw new ValidationError([
      { field: 'name', message: 'Folder names are 1 to 128 characters, without "/"' },
    ]);
  }
  return trimmed;
}

/** The materialized path of folder `id` placed under `parent` (or at the root). */
export function assetFolderPath(parent: Pick<AssetFolder, 'path'> | null, id: string): string {
  const path = `${parent?.path ?? '/'}${id}/`;
  if (path.split('/').length - 2 > MAX_ASSET_FOLDER_DEPTH) {
    throw new ValidationError([
      {
        field: 'parentId',
        message: `Folders nest at most ${MAX_ASSET_FOLDER_DEPTH} deep`,
      },
    ]);
  }
  return path;
}

/**
 * Checks that `folder` may move under `parent`: never into itself or anything inside it, which
 * would cut the subtree off from the root.
 */
export function assertFolderMove(folder: AssetFolder, parent: AssetFolder | null): void {
  if (parent?.path.startsWith(folder.path)) {
    throw new ValidationError([
      { field: 'parentId', message: 'A folder cannot move into itself or one of its subfolders' },
    ]);
  }
}
