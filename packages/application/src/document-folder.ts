import { createHash } from 'node:crypto';
import { nextCronOccurrence, type Scope } from '@contentworker/domain';
import type { AssetIngestQueue, AssetIngestStarter, BlobStore } from '@contentworker/ports';
import { assetFileKey } from './assets';
import type { AppContext } from './context';
import { documentFileFormat } from './document-format';
import { scanDocumentInbox } from './document-inbox';
import { DOCUMENT_MEDIA_ACTOR } from './document-ingest';

export interface DocumentFolderSchedule extends Scope {
  readonly folderId: string | null;
  readonly cron: string;
  readonly inbox?: boolean;
}

/** Scan one bounded page on each due firing. Redelivery uses the same per-file run id. */
export async function queueScheduledDocuments(
  ctx: AppContext,
  blob: BlobStore,
  queue: AssetIngestQueue,
  schedule: DocumentFolderSchedule,
  scheduledTime: number,
  starter?: AssetIngestStarter,
): Promise<number> {
  const { spaceId, environmentId, folderId, cron } = schedule;
  if (!spaceId || !environmentId || (folderId !== null && !folderId))
    throw new Error('Document schedule requires a space, environment and folder');
  const minute = Math.floor(scheduledTime / 60_000) * 60_000;
  if (nextCronOccurrence(cron, new Date(minute - 60_000)).getTime() !== minute) return 0;
  const scope = { spaceId, environmentId };
  const hash = createHash('sha256')
    .update(JSON.stringify([spaceId, environmentId, folderId]))
    .digest('hex');
  const key = `imports/document-schedules/${hash}`;
  const state = JSON.parse((await blob.get(key)) ?? '{}') as { cursor?: string; minute?: number };
  if (state.minute !== undefined && state.minute >= minute) return 0;
  if (schedule.inbox) {
    if (!starter) throw new Error('Document inbox workflow unavailable');
    await scanDocumentInbox(ctx, blob, starter, scope, folderId);
  }
  const page = await ctx.store.assets.list(scope, {
    limit: 50,
    cursor: state.cursor,
    filters: { folderId },
    sort: { field: 'createdAt', direction: 'asc' },
  });
  const candidates = page.items.filter(
    (a) =>
      (a.createdBy !== DOCUMENT_MEDIA_ACTOR || (a.version ?? 1) > 1) &&
      documentFileFormat(a.file.fileName) &&
      (!a.ingestStatus || a.ingestStatus === 'error'),
  );
  const found = await Promise.all(candidates.map((a) => blob.head?.(assetFileKey(scope, a))));
  const requests = candidates
    .filter((_, i) => found[i])
    .map((a) => ({
      scope,
      assetId: a.id,
      version: a.version ?? 1,
      rerun: `folder-${hash}-${minute}`,
    }));
  if (requests.length) await queue.request(requests);
  await blob.put(key, JSON.stringify({ minute, cursor: page.nextCursor }), 'application/json');
  return requests.length;
}
