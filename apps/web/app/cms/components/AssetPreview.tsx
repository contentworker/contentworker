import type { Asset } from '@contentworker/domain';
import { cn } from '@contentworker/ui/lib/utils';
import {
  FileArchiveIcon,
  FileAudioIcon,
  FileIcon,
  FileTextIcon,
  FileVideoIcon,
  ImageIcon,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { sameOriginUpload } from '../lib/management';

/** A file-type icon for the fallback tile, from the MIME type. */
export function fileTypeIcon(contentType: string): LucideIcon {
  if (contentType.startsWith('image/')) return ImageIcon;
  if (contentType.startsWith('video/')) return FileVideoIcon;
  if (contentType.startsWith('audio/')) return FileAudioIcon;
  if (contentType.startsWith('text/') || contentType === 'application/pdf') return FileTextIcon;
  if (/zip|tar|gzip|compressed/.test(contentType)) return FileArchiveIcon;
  return FileIcon;
}

/**
 * The URL to show as an asset's thumbnail: the image itself, or a hosted
 * video's poster frame. `null` when there is nothing visual to show yet.
 *
 * An image is drawn from its same-origin `/media/…` path: in a deployment the
 * API signs it absolute on its own host (`MEDIA_BASE_URL`, `api.<domain>`),
 * which the admin's `img-src 'self'` refuses. The signature covers the path and
 * query, and the web Worker's gateway forwards `/media/`, so it is the same read.
 */
export function previewUrl(asset: Asset): string | null {
  if (asset.file.video) return asset.file.video.thumbnailUrl ?? null;
  if (asset.file.contentType.startsWith('image/') && asset.file.url) {
    return sameOriginUpload(asset.file.url);
  }
  return null;
}

/**
 * Fallback tile: file-type icon + file name. Shown for non-visual files, for a
 * video without a poster yet, and when an image fails to load (expired signed
 * URL, deleted object, unsupported format) — never a broken-image glyph.
 */
export function FallbackTile(props: { asset: Asset; className?: string }) {
  const Icon = fileTypeIcon(props.asset.file.contentType);
  return (
    <div
      data-testid="asset-fallback"
      className={cn(
        'tile grid place-items-center content-center gap-1.5 px-2 text-muted-foreground',
        props.className,
      )}
    >
      <Icon aria-hidden className="size-6" />
      <span className="max-w-full truncate text-xs">{props.asset.file.fileName}</span>
    </div>
  );
}

/** Thumbnail for an asset, degrading to {@link FallbackTile} on any load error. */
export function AssetPreview(props: { asset: Asset; alt: string; className?: string }) {
  const src = previewUrl(props.asset);
  // Remember WHICH source failed: a new one (e.g. a video poster arriving
  // after processing) gets a fresh try without an effect to reset state.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!src || failedSrc === src) {
    return <FallbackTile asset={props.asset} className={props.className} />;
  }
  return (
    <img
      src={src}
      alt={props.alt}
      loading="lazy"
      onError={() => setFailedSrc(src)}
      className={cn('rounded-xl object-cover', props.className)}
    />
  );
}
