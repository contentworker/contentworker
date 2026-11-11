import { cn } from '@contentworker/ui/lib/utils';
import { type ReactNode, useState } from 'react';

/**
 * A catalog block's picture beside its name (`useBlockThumbnails`). Decorative: the name beside it
 * says what the block is, so it is `alt=""` and adds nothing to the accessible name. Without a
 * picture, or when it fails to load (an expired signed URL, a deleted file), it is `fallback` (by
 * default nothing, so the block is its name as before), never a broken-image glyph.
 */
export function BlockThumbnail(props: {
  readonly src: string | undefined;
  readonly className?: string;
  readonly fallback?: ReactNode;
}) {
  // Remember which source failed, so a new one gets a fresh try (as AssetPreview does).
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const { src } = props;
  if (!src || failedSrc === src) return props.fallback ?? null;
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      data-block-thumbnail
      onError={() => setFailedSrc(src)}
      className={cn('shrink-0 bg-card object-cover', props.className)}
    />
  );
}
