import type { Asset } from '@contentworker/domain';
import { Button } from '@contentworker/ui/button';
import { RotateCw } from 'lucide-react';
import { StatusBadge, ToneBadge } from '~/cms/components/status';
import { ingestState } from '~/cms/lib/assets';

/**
 * What ingest found about an asset, beside its status: a possible duplicate (opening the asset it
 * duplicates), and ingest still running or failed (the reason on hover, and Retry). Nothing once
 * ingest is done and found no twin.
 */
export function AssetIngestBadges(props: {
  asset: Asset;
  name: string;
  onOpenOriginal?: (id: string) => void;
  onRetry?: (asset: Asset) => void;
}) {
  const { asset, name } = props;
  const ingest = ingestState(asset);
  const duplicateOf = asset.duplicateOf;
  if (!ingest && !duplicateOf) return null;
  return (
    <>
      {duplicateOf &&
        (props.onOpenOriginal ? (
          <button
            type="button"
            aria-label={`Possible duplicate: open the asset “${name}” duplicates`}
            onClick={() => props.onOpenOriginal?.(duplicateOf)}
            className="rounded-4xl outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
          >
            <ToneBadge tone="wait" label="Possible duplicate" />
          </button>
        ) : (
          <ToneBadge tone="wait" label="Possible duplicate" />
        ))}
      {ingest?.state === 'processing' && <StatusBadge status="processing" label="Processing" />}
      {ingest?.state === 'failed' && (
        <span className="inline-flex items-center gap-0.5" title={ingest.error}>
          <StatusBadge status="failed" label="Processing failed" />
          {ingest.error && <span className="sr-only">: {ingest.error}</span>}
          {props.onRetry && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Retry processing “${name}”`}
              onClick={() => props.onRetry?.(asset)}
            >
              <RotateCw aria-hidden="true" />
            </Button>
          )}
        </span>
      )}
    </>
  );
}
