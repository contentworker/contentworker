import { createHash } from 'node:crypto';
import { type Asset, NotFoundError, type Scope, ValidationError } from '@contentworker/domain';
import type {
  AssetIngestParams,
  BlobStore,
  DocumentPageRequest,
  DocumentParser,
  WorkflowSteps,
} from '@contentworker/ports';
import {
  assetDerivedPrefix,
  assetFileKey,
  assetTextKey,
  getAsset,
  READ_URL_TTL_SECONDS,
} from './assets';
import type { AppContext } from './context';

export interface DocumentPage {
  readonly page: number;
  readonly pages: number;
  readonly text: string;
  readonly textMethod: 'native' | 'ocr';
  readonly preview: 'preview.png' | null;
  readonly media: readonly { readonly part: string; readonly sha256: string }[];
  readonly warnings: readonly string[];
  readonly status: 'complete' | 'partial';
}

const pageStep = {
  retries: { limit: 2, delay: '15 seconds', backoff: 'exponential' as const },
  timeout: '10 minutes',
};

function documentFormat(asset: Asset): DocumentPageRequest['format'] | undefined {
  const extension = asset.file.fileName.split('.').at(-1)?.toLowerCase();
  if (extension === 'key' || extension === 'pdf' || extension === 'pptx') return extension;
  return undefined;
}

function documentPrefix(prefix: string, etag: string): string {
  return `${prefix}document/${createHash('sha256').update(etag).digest('hex')}/`;
}

async function current(ctx: AppContext, params: AssetIngestParams) {
  const asset = await ctx.store.assets.get(params.scope, params.assetId);
  return asset && (asset.version ?? 1) === params.version ? asset : undefined;
}

/** The parser writes a manifest last: a retried page with a manifest has all of its bytes. */
export async function parseAssetDocument(
  steps: Pick<WorkflowSteps, 'do'>,
  ctx: AppContext,
  blob: BlobStore,
  parser: DocumentParser,
  params: AssetIngestParams,
): Promise<{ chars: number; pages: number; partial: boolean } | null> {
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
      format,
      sourceKey,
      etag: object.etag,
      size: object.size,
      outputPrefix: documentPrefix(prefix, object.etag),
    };
  });
  if (!source) return null;
  let pages = 1;
  let partial = false;
  for (let page = 1; page <= pages; page++) {
    const result = await steps.do(`document-page-${page}`, pageStep, async () => {
      if (!(await current(ctx, params))) return null;
      const cached = await blob.get(`${source.outputPrefix}pages/${page}/manifest.json`);
      if (cached) {
        const manifest: DocumentPage = JSON.parse(cached);
        return { pages: manifest.pages, partial: manifest.status === 'partial' };
      }
      return parser.render({ ...source, page });
    });
    if (!result) return null;
    pages = result.pages;
    partial ||= result.partial;
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
      JSON.stringify({ pages, status: partial ? 'partial' : 'complete' }),
      'application/json',
    );
    return excerpt.length;
  });
  return { chars, pages, partial };
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
  const status: 'processing' | 'partial' | 'complete' = summary
    ? JSON.parse(summary).status
    : 'processing';
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
    documentStatus: status,
    assetId: id,
    version: asset.version ?? 1,
    ...(next < stored.media.length ? { nextMediaOffset: next } : {}),
    ...(stored.preview === 'preview.png'
      ? { previewUrl: await url(`pages/${page}/preview.png`) }
      : {}),
  };
}
