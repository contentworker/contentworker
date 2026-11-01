import type { Asset } from '@contentworker/domain';
import { Button } from '@contentworker/ui/button';
import { Card } from '@contentworker/ui/card';
import { ImageIcon, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { AssetDetailSheet } from '~/cms/components/AssetDetailSheet';
import { AssetPreview } from '~/cms/components/AssetPreview';
import { EmptyState, PageHeader } from '~/cms/components/page';
import { StatusBadge } from '~/cms/components/status';
import { humanize } from '~/cms/lib/format';
import { useClient } from '../lib/client-context';
import { ApiError } from '../lib/management';
import { useAssetsQuery, useInvalidate } from '../lib/queries';
import { useToast } from '../lib/toast';

function assetName(asset: Asset, locale: string): string {
  return String(asset.title?.[locale] ?? asset.file.fileName);
}

/** Label for a hosted video's processing state, shown beside the asset status. */
const VIDEO_STATUS_LABEL: Record<string, string> = {
  pending: 'Awaiting upload',
  processing: 'Processing',
  ready: 'Ready',
  error: 'Failed',
};

/** Media library: lists assets, uploads (blob or hosted video), publishes. */
export function MediaLibrary(props: { locale: string }) {
  const { locale } = props;
  const { client } = useClient();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Asset | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const assets = useAssetsQuery().data ?? [];
  const reload = () => invalidate(['assets']);

  const onUpload = async (file: File) => {
    setBusy(true);
    try {
      if (file.type.startsWith('video/')) {
        try {
          // Hosted video (Cloudflare Stream): adaptive playback + poster.
          await client.uploadVideo(file);
          toast.success(`Uploaded ${file.name} — publish once processing finishes`);
        } catch (e) {
          // 501: no video host bound on this deployment; store it as a plain file.
          if (!(e instanceof ApiError && e.status === 501)) throw e;
          await client.uploadAsset(file);
          toast.success(`Uploaded ${file.name}`);
        }
      } else {
        await client.uploadAsset(file); // create → signed PUT → publish
        toast.success(`Uploaded ${file.name}`);
      }
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e));

  const publish = (id: string) => void client.publishAsset(id).then(reload).catch(fail);

  // Unpublish is only offered on a published asset, so republishing restores
  // exactly what was live: an Undo, not an up-front confirm (as for entries).
  const unpublish = (asset: Asset) =>
    void client
      .unpublishAsset(asset.id)
      .then(reload)
      .then(() =>
        toast.success(`Unpublished “${assetName(asset, locale)}”`, {
          action: {
            label: 'Undo',
            onAction: () =>
              void client
                .publishAsset(asset.id)
                .then(reload)
                .then(() => toast.success(`Republished “${assetName(asset, locale)}”`))
                .catch(fail),
          },
        }),
      )
      .catch(fail);

  return (
    <div className="space-y-4">
      <PageHeader title="Media" subtitle="Images, video and files you can reference from entries.">
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          aria-label="Upload asset file"
          onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])}
        />
        <Button type="button" size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
          <Upload aria-hidden="true" /> {busy ? 'Uploading…' : 'Upload asset'}
        </Button>
      </PageHeader>
      {assets.length === 0 ? (
        <EmptyState
          icon={ImageIcon}
          title="No assets yet"
          description="Upload an image, video or file to start building your media library."
        >
          <Button type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
            Upload asset
          </Button>
        </EmptyState>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
          {assets.map((a) => {
            const name = assetName(a, locale);
            const video = a.file.video;
            return (
              <li key={a.id} className="flex">
                <Card
                  size="sm"
                  // A Ledger board card: hover and the open button's focus tint the
                  // card muted; the card's own actions sit beside the open button, not inside it.
                  className="w-full gap-2 p-2 transition-[background-color] hover:bg-muted/60 has-[[data-open-asset]:focus-visible]:bg-muted/60 has-[[data-open-asset]:focus-visible]:ring-2 has-[[data-open-asset]:focus-visible]:ring-ring/50"
                >
                  {/* The card's open action is a real button: reachable by Tab, activated by
                      Enter/Space, named for screen readers. Publish stays a sibling button. */}
                  <button
                    type="button"
                    data-open-asset=""
                    onClick={() => setSelected(a)}
                    aria-label={`Open “${name}”`}
                    className="-m-1 flex flex-col gap-2 rounded-xl p-1 text-left outline-none"
                  >
                    <AssetPreview
                      asset={a}
                      alt={String(a.metadata.altText?.[locale] ?? a.file.fileName)}
                      className="h-28 w-full"
                    />
                    <span className="truncate font-medium text-sm">{name}</span>
                  </button>
                  <div className="flex items-center justify-between gap-1">
                    <div className="flex flex-wrap items-center gap-1">
                      <StatusBadge status={a.status} />
                      {video && (
                        <StatusBadge
                          status={video.status === 'ready' ? 'completed' : video.status}
                          label={VIDEO_STATUS_LABEL[video.status] ?? humanize(video.status)}
                        />
                      )}
                    </div>
                    {a.status === 'published' ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        aria-label={`Unpublish “${name}”`}
                        onClick={() => unpublish(a)}
                      >
                        Unpublish
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        aria-label={`Publish “${name}”`}
                        onClick={() => publish(a.id)}
                      >
                        Publish
                      </Button>
                    )}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      <AssetDetailSheet
        asset={selected}
        locale={locale}
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
        onSaved={() => void reload()}
        onAssetChange={(next) => {
          setSelected(next);
          void reload();
        }}
      />
    </div>
  );
}
