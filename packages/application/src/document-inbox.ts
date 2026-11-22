import { createHash } from 'node:crypto';
import type { Scope } from '@contentworker/domain';
import type {
  AssetIngestParams,
  AssetIngestQueue,
  AssetIngestStarter,
  BlobStore,
  UploadedPart,
  WorkflowSteps,
} from '@contentworker/ports';
import { createUploadDraft, prepareUploadDraft } from './assets';
import type { AppContext } from './context';

const formats: Record<string, string> = {
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  key: 'application/vnd.apple.keynote',
};
const prefix = (scope: Scope) =>
  `imports/document-inbox/${encodeURIComponent(scope.spaceId)}/${encodeURIComponent(scope.environmentId)}/`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const receipt = (key: string, etag: string) =>
  `imports/document-receipts/${digest(JSON.stringify([key, etag]))}`;
const copyStep = {
  retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' as const },
  timeout: '30 minutes',
};
const partBytes = 256 * 1024 * 1024;
const maxSize = 1_000_000_000_000;

export async function scanDocumentInbox(
  ctx: AppContext,
  blob: BlobStore,
  starter: AssetIngestStarter,
  scope: Scope,
  folderId: string | null,
) {
  if (!blob.listKeys || !blob.reserve || !blob.head)
    throw new Error('Document inbox storage unavailable');
  const sourcePrefix = prefix(scope);
  const checkpoint = `imports/document-cursors/${digest(sourcePrefix)}`;
  const cursor = await blob.get(checkpoint);
  const page = await blob.listKeys(sourcePrefix, 16, cursor || undefined);
  for (const key of page.keys) {
    if (!key.startsWith(sourcePrefix) || !/\.(pdf|pptx|key)$/i.test(key)) continue;
    const head = await blob.head(key);
    if (
      !head?.etag ||
      !head.size ||
      head.size > maxSize ||
      head.size > (ctx.maxUploadBytes ?? maxSize)
    )
      continue;
    const base = receipt(key, head.etag);
    if (await blob.head(`${base}/done`)) continue;
    const assetId = await blob.reserve(`${base}/id`, ctx.ids.newId());
    await starter.start(`inbox-${digest(base)}`, {
      scope,
      assetId,
      version: 1,
      inbox: { key, etag: head.etag, size: head.size, folderId },
    });
  }
  await blob.put(checkpoint, page.cursor ?? '', 'text/plain');
}

/** Imported originals have their own DAM key. One immutable inbox revision owns one draft. */
export async function importDocumentInbox(
  steps: Pick<WorkflowSteps, 'do'>,
  ctx: AppContext,
  blob: BlobStore,
  queue: AssetIngestQueue,
  params: AssetIngestParams,
) {
  const src = params.inbox;
  const multipart = blob.multipart;
  if (
    !src?.key.startsWith(prefix(params.scope)) ||
    !Number.isSafeInteger(src.size) ||
    src.size < 1 ||
    src.size > maxSize ||
    !multipart?.copyPart ||
    !blob.head
  )
    throw new Error('Invalid document inbox input');
  const fileName = src.key.split('/').at(-1)!;
  const ext = fileName.split('.').at(-1)!.toLowerCase();
  if (!Object.hasOwn(formats, ext)) throw new Error('Unsupported inbox format');
  const draft = await steps.do('prepare-inbox-draft', copyStep, () =>
    prepareUploadDraft(
      ctx,
      blob,
      params.scope,
      { fileName, contentType: formats[ext]! },
      { reservedId: params.assetId, folderId: src.folderId ?? undefined },
    ),
  );
  const { uploadId } = await steps.do('open-inbox-upload', copyStep, () =>
    multipart.create(draft.key, draft.contentType),
  );
  try {
    const parts: UploadedPart[] = [];
    const count = Math.ceil(src.size / partBytes);
    // Eight pinned streams per checkpoint keeps a terabyte below 500 durable steps.
    for (let first = 1; first <= count; first += 8) {
      const batch = await steps.do(`copy-inbox-${first}`, copyStep, async () => {
        const uploaded: UploadedPart[] = [];
        for (let n = first; n <= Math.min(count, first + 7); n++) {
          const offset = (n - 1) * partBytes;
          uploaded.push(
            await multipart.copyPart!(
              src.key,
              src.etag,
              offset,
              Math.min(partBytes, src.size - offset),
              draft.key,
              uploadId,
              n,
            ),
          );
        }
        return uploaded;
      });
      parts.push(...batch);
    }
    await steps.do('complete-inbox-upload', copyStep, async () => {
      if (!(await blob.head!(draft.key))) await multipart.complete(draft.key, uploadId, parts);
      const head = await blob.head!(draft.key);
      if (!head?.etag || head.size !== src.size) throw new Error('Incomplete inbox import');
      if (!(await ctx.store.assets.get(params.scope, params.assetId)))
        await createUploadDraft(ctx, params.scope, {
          ...draft.asset,
          file: { ...draft.asset.file, size: src.size },
        });
      await queue.objectCreated(draft.key, head.etag);
      await blob.put(`${receipt(src.key, src.etag)}/done`, params.assetId, 'text/plain');
    });
  } catch (error) {
    await steps.do('abort-inbox-upload', copyStep, () => multipart.abort(draft.key, uploadId));
    throw error;
  }
}
