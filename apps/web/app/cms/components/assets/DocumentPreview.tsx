import type { Asset } from '@contentworker/domain';
import { Button } from '@contentworker/ui/button';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useClient } from '~/cms/lib/client-context';
import { ApiError, apiErrorMessage, sameOriginUpload } from '~/cms/lib/management';

export function DocumentPreview({
  asset,
  onOpen,
  onReingest,
  onLatest,
}: {
  asset: Asset;
  onOpen?: (id: string) => void;
  onReingest: () => Promise<void>;
  onLatest?: (asset: Asset) => void;
}) {
  const { client, conn } = useClient();
  const [page, setPage] = useState(1);
  const [sending, setSending] = useState(false);
  const isPdf = /\.pdf$/i.test(asset.file.fileName);
  const unit = isPdf ? 'Page' : 'Slide';
  const running = asset.ingestStatus === 'pending' || asset.ingestStatus === 'processing';
  const live = useQuery({
    queryKey: [
      conn.space,
      conn.environment,
      'preview-ingest-status',
      asset.id,
      asset.version ?? 1,
      asset.ingestStatus,
    ],
    queryFn: () => client.getAsset(asset.id),
    enabled: running,
    retry: false,
    refetchInterval: running ? 5000 : false,
    gcTime: 0,
  });
  useEffect(() => {
    if (
      running &&
      live.data &&
      (live.data.ingestStatus !== asset.ingestStatus || live.data.version !== asset.version)
    )
      onLatest?.(live.data);
  }, [running, live.data, asset.ingestStatus, asset.version, onLatest]);
  const query = useInfiniteQuery({
    queryKey: [
      conn.space,
      conn.environment,
      'document-preview',
      asset.id,
      asset.version ?? 1,
      asset.ingestStatus,
      page,
    ],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => client.documentPage(asset.id, page, pageParam, signal),
    getNextPageParam: (result) => result.nextMediaOffset,
    retry: false,
    refetchInterval: (q) =>
      asset.ingestStatus !== 'error' &&
      (running || q.state.data?.pages[0]?.documentStatus === 'processing')
        ? 5000
        : false,
  });
  const result = query.data?.pages[0];
  const media = query.data?.pages.flatMap((group) => group.media) ?? [];
  const missing = query.error instanceof ApiError && query.error.status === 404;
  const partial = result?.documentStatus === 'partial' || result?.status === 'partial';
  const reingest = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={running || sending}
      onClick={async () => {
        setSending(true);
        try {
          await onReingest();
        } finally {
          setSending(false);
        }
      }}
    >
      {running || sending ? 'Ingest queued or running' : 'Reingest document'}
    </Button>
  );
  if (query.data?.pages.some((group) => group.version !== (asset.version ?? 1))) {
    return (
      <section aria-label="Document preview" className="space-y-2">
        <p role="status">The file has been replaced.</p>
        {onLatest && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={live.isFetching}
            onClick={async () => {
              const latest = await live.refetch();
              if (latest.isSuccess) onLatest(latest.data);
            }}
          >
            Load current version
          </Button>
        )}
        {live.isError && (
          <p role="alert" className="text-sm">
            {apiErrorMessage(live.error)}
          </p>
        )}
      </section>
    );
  }
  return (
    <section aria-label="Document preview" className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">
          {unit} {page}
          {result && ` of ${result.pages}`}
        </h3>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page === 1}
            onClick={() => setPage(page - 1)}
          >
            Previous {unit.toLowerCase()}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!result || page >= result.pages}
            onClick={() => setPage(page + 1)}
          >
            Next {unit.toLowerCase()}
          </Button>
        </div>
      </div>
      {query.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading {unit.toLowerCase()}…
        </p>
      )}
      {query.isError && (
        <div className="space-y-2">
          <p role="status" className="text-sm">
            {missing
              ? running
                ? 'Waiting for the document preview.'
                : 'No preview is available for this file version.'
              : apiErrorMessage(query.error)}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
            Refresh preview
          </Button>
          {missing && !running && asset.ingestStatus !== 'error' && reingest}
        </div>
      )}
      {result && (
        <>
          {result.previewUrl && (
            <img
              src={sameOriginUpload(result.previewUrl)}
              alt={`${unit} ${page} of ${asset.file.fileName}`}
              className="max-h-96 max-w-full rounded-md border object-contain"
            />
          )}
          {partial && (
            <div className="space-y-2 rounded-md border p-3">
              <p className="text-sm font-medium">
                {result.status === 'partial'
                  ? `${unit} ${page} was partially extracted.`
                  : isPdf
                    ? 'Some pages were partially extracted.'
                    : 'Some slides were partially extracted.'}
              </p>
              {!!result.warnings.length && (
                <ul className="list-disc space-y-1 break-words pl-5 text-sm">
                  {result.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
              {result.status !== 'partial' &&
                result.firstPartialPage &&
                result.firstPartialPage !== page && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(result.firstPartialPage!)}
                  >
                    View {unit.toLowerCase()} {result.firstPartialPage}
                  </Button>
                )}
              {reingest}
            </div>
          )}
          <div className="space-y-1">
            <h4 className="text-sm font-medium">Extracted text</h4>
            <p className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-sm">
              {result.text.trim() || 'No text extracted.'}
            </p>
          </div>
          {!!media.length && (
            <div className="space-y-1">
              <h4 className="text-sm font-medium">Embedded files</h4>
              <ul>
                {media.map((item, i) => (
                  <li key={i} className="min-w-0 break-words text-sm">
                    {item.assetId && onOpen ? (
                      <button
                        type="button"
                        className="hit-area text-left underline"
                        onClick={() => onOpen(item.assetId!)}
                      >
                        {item.part}
                      </button>
                    ) : (
                      <a className="hit-area underline" href={sameOriginUpload(item.url)} download>
                        {item.part}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
              {query.hasNextPage && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={query.isFetchingNextPage}
                  onClick={() => void query.fetchNextPage()}
                >
                  More embedded files
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
