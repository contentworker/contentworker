import type { Asset, ReferenceEdge, Tag } from '@contentworker/domain';
import { Badge } from '@contentworker/ui/badge';
import { Button } from '@contentworker/ui/button';
import { Input } from '@contentworker/ui/input';
import { Label } from '@contentworker/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentworker/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@contentworker/ui/sheet';
import { SkeletonText } from '@contentworker/ui/skeleton';
import { Textarea } from '@contentworker/ui/textarea';
import { useEffect, useRef, useState } from 'react';
import { AssetPreview, FallbackTile } from '~/cms/components/AssetPreview';
import { AssetIngestBadges, BADGE_BUTTON_FOCUS } from '~/cms/components/assets/AssetIngestBadges';
import { InlineConfirm } from '~/cms/components/InlineConfirm';
import { LoadingStatus } from '~/cms/components/loading';
import { StatusBadge, StatusDot, ToneBadge } from '~/cms/components/status';
import { useClient } from '../lib/client-context';
import type { ImageTransform } from '../lib/management';
import { useToast } from '../lib/toast';

/**
 * Edits an asset's media "Aspects": localized alt text, a click-to-set focal
 * point for smart cropping, taxonomy tags, and the list of entries using it.
 * Saving patches metadata; the caller refreshes the library on close.
 */
export function AssetDetailSheet(props: {
  asset: Asset | null;
  locale: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  /** Called with a refreshed asset (e.g. a video's new processing status). */
  onAssetChange?: (asset: Asset) => void;
  /** Opens another asset by id (the original a possible duplicate points at). */
  onOpenAsset?: (id: string) => void;
}) {
  const { asset, locale } = props;
  const { client } = useClient();
  const toast = useToast();
  const [altText, setAltText] = useState('');
  const [focal, setFocal] = useState<{ x: number; y: number } | undefined>();
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [usage, setUsage] = useState<ReferenceEdge[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [width, setWidth] = useState('400');
  const [fit, setFit] = useState<NonNullable<ImageTransform['fit']>>('crop');
  const [format, setFormat] = useState<ImageTransform['format'] | 'original'>('original');
  const [preview, setPreview] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // The original a possible duplicate points at, waiting on "discard your edits?".
  const [confirmOpen, setConfirmOpen] = useState<string | null>(null);
  const imgRef = useRef<HTMLButtonElement>(null);
  // The values the form was filled from: what "changed" and "unsaved" are measured against.
  const [base, setBase] = useState<FormValues>({ altText: '', tagIds: [] });

  // Hydrate the form when the sheet opens on an asset, and only then: the same asset coming back
  // refreshed (a Retry, a video's new status, a poll) keeps what the editor has typed.
  const assetRef = useRef(asset);
  assetRef.current = asset;
  const assetId = asset?.id;
  useEffect(() => {
    const asset = assetRef.current;
    if (!asset || !props.open) return;
    const values = formValues(asset, locale);
    setBase(values);
    setAltText(values.altText);
    setFocal(values.focal);
    setTagIds([...values.tagIds]);
    setConfirmOpen(null);
    setUsage(null);
    setPreview(null);
    setPreviewFailed(false);
    setImageFailed(false);
    client
      .listTags()
      .then(setAllTags)
      .catch(() => setAllTags([]));
    client
      .assetUsage(asset.id)
      .then(setUsage)
      .catch(() => setUsage([]));
  }, [assetId, props.open, locale, client]);

  if (!asset) return null;
  const isImage = asset.file.contentType.startsWith('image/');
  const video = asset.file.video;

  const refreshVideo = async () => {
    setRefreshing(true);
    try {
      props.onAssetChange?.(await client.refreshVideoAsset(asset.id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  const retryIngest = async () => {
    try {
      props.onAssetChange?.(await client.reingestAsset(asset.id));
      toast.success('Processing again');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const altChanged = altText !== base.altText;
  const tagsChanged = !sameSet(tagIds, base.tagIds);
  const dirty = altChanged || tagsChanged || !sameFocal(focal, base.focal);

  // Opening the original replaces this form: with edits in it, that is asked in place first.
  const openOriginal = (id: string) => {
    if (dirty) setConfirmOpen(id);
    else props.onOpenAsset?.(id);
  };

  // What ingest filled from a model and no one has saved yet. A save sends alt text and tags only
  // when they changed here, and the API clears the mark only on what changed (this locale's alt
  // text, the tags added or removed), so saving the focal point leaves suggestions marked. The
  // alt text badge goes as soon as the value here differs from the suggestion.
  const altSuggested =
    asset.aiSuggestions?.altText?.includes(locale) === true &&
    altText === String(asset.metadata.altText?.[locale] ?? '');
  const suggestedTags = new Set(asset.aiSuggestions?.tags ?? []);
  const showIngest = Boolean(
    asset.duplicateOf ||
      asset.ingestStatus === 'error' ||
      asset.ingestStatus === 'pending' ||
      asset.ingestStatus === 'processing',
  );

  const pickFocal = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = imgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    setFocal({ x: Number(x.toFixed(3)), y: Number(y.toFixed(3)) });
  };

  const toggleTag = (id: string) => {
    setTagIds((ids) => (ids.includes(id) ? ids.filter((t) => t !== id) : [...ids, id]));
  };

  const applyTransform = async () => {
    try {
      const { url } = await client.transformAsset(asset.id, {
        width: width ? Number(width) : undefined,
        fit,
        format: format === 'original' ? undefined : format,
      });
      setPreviewFailed(false);
      setPreview(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const suggestAlt = async () => {
    try {
      const { altText: suggestion } = await client.generateAltText(asset.id, { locale });
      setAltText(suggestion);
      toast.success('Alt text suggested — review and save');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const suggestTags = async () => {
    try {
      const { tagIds: matched, newTags } = await client.autoTagAsset(asset.id);
      setTagIds((ids) => Array.from(new Set([...ids, ...matched])));
      toast.success(
        newTags.length
          ? `Tagged. New tag ideas: ${newTags.join(', ')} (add in Taxonomy)`
          : 'Tags suggested — review and save',
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      await client.setAssetMetadata(asset.id, {
        ...(altChanged ? { altText: { ...asset.metadata.altText, [locale]: altText } } : {}),
        ...(tagsChanged ? { tags: tagIds } : {}),
        focalPoint: focal,
      });
      toast.success('Metadata saved');
      props.onSaved();
      props.onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="truncate">{asset.file.fileName}</SheetTitle>
          <SheetDescription className="font-mono text-xs">
            {asset.file.contentType}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-5 px-4 pb-4">
          {showIngest && (
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-1">
                <AssetIngestBadges
                  asset={asset}
                  name={asset.file.fileName}
                  {...(props.onOpenAsset ? { onOpenOriginal: openOriginal } : {})}
                  onRetry={() => void retryIngest()}
                />
              </div>
              {confirmOpen && (
                <InlineConfirm
                  message="Open the original and discard your changes?"
                  note="Alt text, tags and the focal point here are not saved."
                  cancelLabel="Keep editing"
                  onCancel={() => setConfirmOpen(null)}
                >
                  {/* The ink pill: nothing stored is deleted, only this form's unsaved values. */}
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      const id = confirmOpen;
                      setConfirmOpen(null);
                      props.onOpenAsset?.(id);
                    }}
                  >
                    Discard and open
                  </Button>
                </InlineConfirm>
              )}
              {asset.duplicateOf && (
                <p className="text-muted-foreground text-xs">
                  The same file is already in the library.
                </p>
              )}
            </div>
          )}

          {video && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Video</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={refreshVideo}
                  disabled={refreshing}
                >
                  {refreshing ? 'Checking…' : 'Refresh status'}
                </Button>
              </div>
              <AssetPreview asset={asset} alt={altText || asset.file.fileName} className="w-full" />
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <StatusBadge
                  status={video.status === 'ready' ? 'completed' : video.status}
                  label={video.status}
                />
                {video.durationSeconds !== undefined && (
                  <span className="text-muted-foreground">
                    {Math.round(video.durationSeconds)}s
                  </span>
                )}
                {video.errorReason && <span className="text-destructive">{video.errorReason}</span>}
              </div>
              {video.hlsUrl && (
                <p className="break-all font-mono text-xs text-muted-foreground">
                  HLS {video.hlsUrl}
                </p>
              )}
            </div>
          )}

          {isImage && (
            <div className="space-y-1.5">
              <Label>Focal point</Label>
              <button
                type="button"
                ref={imgRef}
                onClick={pickFocal}
                className="relative block w-full cursor-crosshair overflow-hidden rounded-md border"
              >
                {imageFailed ? (
                  <FallbackTile asset={asset} className="h-40 w-full" />
                ) : (
                  <img
                    src={asset.file.url}
                    alt={altText || asset.file.fileName}
                    onError={() => setImageFailed(true)}
                    className="w-full"
                  />
                )}
                {focal && (
                  <span
                    className="-translate-x-1/2 -translate-y-1/2 pointer-events-none absolute size-5 rounded-full border-2 border-white bg-primary/60 shadow"
                    style={{ left: `${focal.x * 100}%`, top: `${focal.y * 100}%` }}
                  />
                )}
              </button>
              <p className="text-muted-foreground text-xs">
                {focal
                  ? `x ${focal.x}, y ${focal.y} — click to move`
                  : 'Click the image to set a focal point for smart cropping.'}
              </p>
            </div>
          )}

          {isImage && (
            <div className="space-y-2">
              <Label>Transform preview</Label>
              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1">
                  <Label htmlFor="t-width" className="text-muted-foreground text-xs">
                    Width
                  </Label>
                  <Input
                    id="t-width"
                    type="number"
                    value={width}
                    onChange={(e) => setWidth(e.target.value)}
                    className="h-8 w-24"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-muted-foreground text-xs">Fit</Label>
                  <Select
                    value={fit}
                    onValueChange={(v) => setFit(v as NonNullable<ImageTransform['fit']>)}
                  >
                    <SelectTrigger aria-label="Image fit" className="h-8 w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(['clip', 'crop', 'fill', 'max', 'scale'] as const).map((f) => (
                        <SelectItem key={f} value={f}>
                          {f}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-muted-foreground text-xs">Format</Label>
                  <Select
                    value={format}
                    onValueChange={(v) => setFormat(v as ImageTransform['format'] | 'original')}
                  >
                    <SelectTrigger aria-label="Image format" className="h-8 w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(['original', 'auto', 'jpg', 'png', 'webp', 'avif'] as const).map((f) => (
                        <SelectItem key={f} value={f}>
                          {f}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={applyTransform}>
                  Apply
                </Button>
              </div>
              {preview && (
                <div className="space-y-1">
                  {previewFailed ? (
                    <FallbackTile asset={asset} className="h-32 w-full" />
                  ) : (
                    <img
                      src={preview}
                      alt="Transformed preview"
                      onError={() => setPreviewFailed(true)}
                      className="max-h-48 rounded-md border"
                    />
                  )}
                  <p className="break-all font-mono text-xs text-muted-foreground">{preview}</p>
                </div>
              )}
              <p className="text-muted-foreground text-xs">
                Crop honors the saved focal point — save metadata first to see its effect.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Label htmlFor="asset-alt">Alt text ({locale})</Label>
                {altSuggested && <ToneBadge tone="ai" label="AI suggestion" />}
              </div>
              {isImage && (
                <Button type="button" variant="ghost" size="xs" onClick={suggestAlt}>
                  ✨ Generate
                </Button>
              )}
            </div>
            <Textarea
              id="asset-alt"
              value={altText}
              onChange={(e) => setAltText(e.target.value)}
              placeholder="Describe the image for accessibility and SEO."
              rows={3}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Label>Tags</Label>
                {[...suggestedTags].some((id) => tagIds.includes(id)) && (
                  <ToneBadge tone="ai" label="AI suggestion" />
                )}
              </div>
              {isImage && (
                <Button type="button" variant="ghost" size="xs" onClick={suggestTags}>
                  ✨ Auto-tag
                </Button>
              )}
            </div>
            {allTags.length === 0 ? (
              <p className="text-muted-foreground text-sm">No tags defined in this space yet.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {allTags.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={tagIds.includes(t.id)}
                    onClick={() => toggleTag(t.id)}
                    className={BADGE_BUTTON_FOCUS}
                  >
                    <Badge variant={tagIds.includes(t.id) ? 'default' : 'outline'}>
                      {suggestedTags.has(t.id) && tagIds.includes(t.id) && (
                        <StatusDot status="suggested" className="ring-1 ring-background" />
                      )}
                      {t.name}
                      {suggestedTags.has(t.id) && tagIds.includes(t.id) && (
                        <>
                          <span aria-hidden="true" className="font-normal">
                            AI
                          </span>
                          <span className="sr-only"> (AI suggestion)</span>
                        </>
                      )}
                    </Badge>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Used by {usage ? `(${usage.length})` : ''}</Label>
            {usage === null ? (
              <div className="space-y-1 text-xs">
                <LoadingStatus>Loading where this asset is used…</LoadingStatus>
                <SkeletonText width="78%" />
                <SkeletonText width="64%" />
              </div>
            ) : usage.length === 0 ? (
              <p className="text-muted-foreground text-sm">Not referenced by any entry.</p>
            ) : (
              <ul className="space-y-1">
                {usage.map((u) => (
                  <li key={`${u.fromEntryId}:${u.fromField}`} className="font-mono text-xs">
                    {u.fromEntryId}
                    <span className="text-muted-foreground"> · {u.fromField}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <SheetFooter>
          <Button type="button" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save metadata'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

interface FormValues {
  readonly altText: string;
  readonly tagIds: readonly string[];
  readonly focal?: { x: number; y: number };
}

/** The editable values of an asset, in `locale`, as the form starts them. */
function formValues(asset: Asset, locale: string): FormValues {
  return {
    altText: String(asset.metadata.altText?.[locale] ?? ''),
    tagIds: [...asset.metadata.tags],
    ...(asset.metadata.focalPoint ? { focal: asset.metadata.focalPoint } : {}),
  };
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

const sameFocal = (a?: { x: number; y: number }, b?: { x: number; y: number }) =>
  a?.x === b?.x && a?.y === b?.y;
