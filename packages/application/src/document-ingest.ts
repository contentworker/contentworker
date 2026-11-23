import { createHash } from 'node:crypto';
import { type Asset, NotFoundError, type Scope, ValidationError } from '@contentworker/domain';
import type {
  AssetIngestParams,
  AssetIngestStarter,
  BlobStore,
  DocumentIngestOptions,
  DocumentParser,
  WorkflowSteps,
} from '@contentworker/ports';
import {
  assetDerivedPrefix,
  assetFileKey,
  assetTextKey,
  createUploadDraft,
  getAsset,
  prepareUploadDraft,
  READ_URL_TTL_SECONDS,
} from './assets';
import type { AppContext } from './context';
import { documentFileFormat } from './document-format';
import { getDocumentTemplate } from './document-template';

export interface DocumentPage {
  readonly page: number;
  readonly pages: number;
  readonly text: string;
  readonly textMethod: 'native' | 'ocr';
  readonly preview: 'preview.png' | null;
  readonly media: readonly {
    readonly part: string;
    readonly sha256: string;
    readonly assetId?: string;
  }[];
  readonly warnings: readonly string[];
  readonly status: 'complete' | 'partial';
}

const pageStep = {
  retries: { limit: 2, delay: '15 seconds', backoff: 'exponential' as const },
  timeout: '10 minutes',
};

export const DOCUMENT_MEDIA_ACTOR = 'system:document-parser';

function documentFormat(asset: Asset) {
  if (asset.createdBy === DOCUMENT_MEDIA_ACTOR && (asset.version ?? 1) === 1) return undefined;
  return documentFileFormat(asset.file.fileName);
}

function documentPrefix(prefix: string, etag: string): string {
  return `${prefix}document/${createHash('sha256').update(etag).digest('hex')}/`;
}

async function current(ctx: AppContext, params: AssetIngestParams) {
  const asset = await ctx.store.assets.get(params.scope, params.assetId);
  return asset && (asset.version ?? 1) === params.version ? asset : undefined;
}

const mediaTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

async function registerMedia(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
  parent: Asset,
  prefix: string,
  manifest: DocumentPage,
) {
  if (!manifest.media.length) return;
  if (!blob.reserve || !blob.copyOnce) throw new Error('Document media storage unavailable');
  const media = [];
  for (const item of manifest.media) {
    if (!/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid embedded media digest');
    const key = `${prefix}media/${item.sha256}`;
    const id = await blob.reserve(`${key}.asset`, ctx.ids.newId());
    if (!(await ctx.store.assets.get(scope, id))) {
      const fileName = item.part.split('/').at(-1) || 'file';
      const ext = fileName.split('.').at(-1)?.toLowerCase() ?? '';
      const contentType = Object.hasOwn(mediaTypes, ext)
        ? mediaTypes[ext]!
        : 'application/octet-stream';
      const draft = await prepareUploadDraft(
        ctx,
        blob,
        scope,
        { fileName, contentType },
        { reservedId: id, folderId: parent.folderId ?? undefined, createdBy: DOCUMENT_MEDIA_ACTOR },
      );
      await blob.copyOnce(key, draft.key, draft.contentType);
      try {
        await createUploadDraft(ctx, scope, draft.asset);
      } catch (err) {
        if (!(await ctx.store.assets.get(scope, id))) throw err;
      }
    }
    media.push({ ...item, assetId: id });
  }
  await blob.put(
    `${prefix}pages/${manifest.page}/manifest.json`,
    JSON.stringify({ ...manifest, media }),
    'application/json',
  );
}

/** The parser writes a manifest last: a retried page with a manifest has all of its bytes. */
export async function parseAssetDocument(
  steps: Pick<WorkflowSteps, 'do'>,
  ctx: AppContext,
  blob: BlobStore,
  parser: DocumentParser,
  params: AssetIngestParams,
  continuation?: { starter: AssetIngestStarter; instanceId: string },
): Promise<
  | { chars: number; pages: number; partial: boolean; template: DocumentIngestOptions }
  | 'continued'
  | 'stale'
  | null
> {
  const prefix = assetDerivedPrefix(params.scope, params.assetId, params.version);
  if (!prefix || !blob.head) return null;
  const source = await steps.do('document-source', pageStep, async () => {
    const asset = await current(ctx, params);
    const format = asset && documentFormat(asset);
    if (!asset || !format) return null;
    const sourceKey = assetFileKey(params.scope, asset);
    const object = await blob.head?.(sourceKey);
    if (!object?.etag) throw new Error('Document source unavailable');
    return {
      template: params.documentCursor?.template ?? (await getDocumentTemplate(ctx, params.scope)),
      format,
      sourceKey,
      etag: object.etag,
      size: object.size,
      outputPrefix: documentPrefix(prefix, object.etag),
    };
  });
  if (!source) return params.documentCursor ? 'stale' : null;
  const cursor = params.documentCursor;
  if (cursor && cursor.etag !== source.etag) return 'stale';
  const first = cursor?.page ?? 1;
  let pages = cursor?.pages ?? 1;
  let partial = cursor?.partial ?? false;
  let firstPartialPage = cursor?.firstPartialPage;
  for (let page = first; page <= pages; page++) {
    if (page - first === 128 && continuation) {
      const nextId = createHash('sha256')
        .update(`${continuation.instanceId}/${page}`)
        .digest('hex');
      await steps.do('continue-document', pageStep, () =>
        continuation.starter.start(nextId, {
          ...params,
          documentCursor: {
            page,
            pages,
            partial,
            firstPartialPage,
            etag: source.etag,
            template: source.template,
          },
        }),
      );
      return 'continued';
    }
    const result = await steps.do(`document-page-${page}`, pageStep, async () => {
      const parent = await current(ctx, params);
      if (!parent) return null;
      const key = `${source.outputPrefix}pages/${page}/manifest.json`;
      let raw = await blob.get(key);
      if (
        !raw ||
        (params.retryPartialPages && (JSON.parse(raw) as DocumentPage).status === 'partial')
      ) {
        await parser.render({ ...source, page });
        raw = await blob.get(key);
      }
      if (!raw) throw new Error('Missing rendered document page');
      const manifest: DocumentPage = JSON.parse(raw);
      if (source.template.createMediaDrafts)
        await registerMedia(ctx, blob, params.scope, parent, source.outputPrefix, manifest);
      return { pages: manifest.pages, partial: manifest.status === 'partial' };
    });
    if (!result) return 'stale';
    pages = result.pages;
    partial ||= result.partial;
    if (result.partial) firstPartialPage ??= page;
  }
  const chars = await steps.do('document-text', pageStep, async () => {
    if (!(await current(ctx, params))) return 0;
    let excerpt = '';
    // Full text lives page by page. Keep a bounded search excerpt from the front of the document.
    for (let page = 1; page <= Math.min(32, pages) && excerpt.length < 64_000; page++) {
      const stored = await blob.get(`${source.outputPrefix}pages/${page}/manifest.json`);
      if (!stored) throw new Error('Missing parsed document page');
      const manifest: DocumentPage = JSON.parse(stored);
      excerpt += `${manifest.text}\n`.slice(0, 64_000 - excerpt.length);
    }
    const textKey = assetTextKey(params.scope, params.assetId, params.version);
    if (textKey) await blob.put(textKey, excerpt, 'text/plain; charset=utf-8');
    await blob.put(
      `${source.outputPrefix}summary.json`,
      JSON.stringify({ pages, firstPartialPage, status: partial ? 'partial' : 'complete' }),
      'application/json',
    );
    return excerpt.length;
  });
  return { chars, pages, partial, template: source.template };
}

/** One numbered page of the current DAM file, within its owning environment. */
export async function getDocumentPage(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
  id: string,
  page: number,
  mediaOffset = 0,
) {
  if (!Number.isSafeInteger(mediaOffset) || mediaOffset < 0)
    throw new ValidationError([{ field: 'mediaOffset', message: 'Expected a nonnegative offset' }]);
  if (!Number.isSafeInteger(page) || page < 1)
    throw new ValidationError([{ field: 'page', message: 'Expected a positive page number' }]);
  const asset = await getAsset(ctx, scope, id);
  const derived = assetDerivedPrefix(scope, id, asset.version ?? 1);
  const source = await blob.head?.(assetFileKey(scope, asset));
  const prefix = derived && source?.etag && documentPrefix(derived, source.etag);
  const raw = prefix && (await blob.get(`${prefix}pages/${page}/manifest.json`));
  if (!raw) throw new NotFoundError('Document page', String(page));
  const stored: DocumentPage = JSON.parse(raw);
  const summary = await blob.get(`${prefix}summary.json`);
  const progress = summary
    ? (JSON.parse(summary) as { status: 'partial' | 'complete'; firstPartialPage?: number })
    : undefined;
  const url = (suffix: string) =>
    blob.getDownloadUrl(`${prefix}${suffix}`, { expiresInSeconds: READ_URL_TTL_SECONDS });
  const media = await Promise.all(
    stored.media.slice(mediaOffset, mediaOffset + 100).map(async (item) => {
      if (!/^[a-f0-9]{64}$/.test(item.sha256))
        throw new Error('Invalid stored document media reference');
      return { ...item, url: await url(`media/${item.sha256}`) };
    }),
  );
  const next = mediaOffset + media.length;
  return {
    ...stored,
    media,
    documentStatus: progress?.status ?? ('processing' as const),
    ...(progress?.firstPartialPage ? { firstPartialPage: progress.firstPartialPage } : {}),
    assetId: id,
    version: asset.version ?? 1,
    ...(next < stored.media.length ? { nextMediaOffset: next } : {}),
    ...(stored.preview === 'preview.png'
      ? { previewUrl: await url(`pages/${page}/preview.png`) }
      : {}),
  };
}
