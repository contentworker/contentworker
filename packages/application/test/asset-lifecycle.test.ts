import {
  AssetInUseError,
  type DomainEvent,
  InvalidStateError,
  MAX_ASSET_USAGE_SHOWN,
} from '@contentworker/domain';
import {
  FakeBlobStore,
  FakeVideoHost,
  FixedClock,
  InMemoryContentStore,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  archiveAsset,
  createAsset,
  createContentType,
  createEntry,
  createEnvironment,
  createSpace,
  createVideoAsset,
  deleteAsset,
  dispatchEvent,
  getAsset,
  getPublishedAsset,
  publishAsset,
  publishContentType,
  publishEntry,
  restoreAsset,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };

function setup() {
  const store = new InMemoryContentStore();
  const blob = new FakeBlobStore();
  const video = new FakeVideoHost();
  const ctx: AppContext = {
    store,
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('a'),
    video,
  };
  let dispatched = 0;
  /** Runs the outbox's new events through dispatch, as the engine does. */
  const drain = async () => {
    const events = store.allEvents();
    for (const e of events.slice(dispatched)) {
      await dispatchEvent(ctx, { sender: new RecordingWebhookSender(), blob }, e as DomainEvent);
    }
    dispatched = events.length;
  };
  return { ctx, store, blob, video, drain };
}

async function upload(h: ReturnType<typeof setup>, fileName = 'hero.png') {
  const { asset } = await createAsset(h.ctx, h.blob, scope, {
    fileName,
    contentType: 'image/png',
  });
  await h.blob.put(asset.r2Key ?? '', 'bytes', 'image/png');
  return asset;
}

async function linkFromEntry(h: ReturnType<typeof setup>, assetId: string) {
  await createContentType(h.ctx, scope, {
    apiId: 'page',
    name: 'Page',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
      {
        apiId: 'hero',
        name: 'Hero',
        type: 'Link',
        localized: false,
        required: false,
        position: 1,
        linkType: 'Asset',
      },
    ],
  });
  await publishContentType(h.ctx, scope, 'page');
  const created = await createEntry(h.ctx, scope, {
    contentTypeApiId: 'page',
    fields: {
      title: { 'en-US': 'Home' },
      hero: { 'en-US': { id: assetId, linkType: 'Asset' } },
    },
  });
  await publishEntry(h.ctx, scope, created.entry.id);
  return created.entry.id;
}

describe('archiving and restoring an asset', () => {
  let h: ReturnType<typeof setup>;
  beforeEach(async () => {
    h = setup();
    await createSpace(h.ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('takes a published asset out of Delivery in the same unit as its event', async () => {
    const asset = await upload(h);
    await publishAsset(h.ctx, scope, asset.id);
    const before = h.store.allEvents().length;

    const archived = await archiveAsset(h.ctx, scope, asset.id);

    expect(archived).toMatchObject({ status: 'archived', archivedAt: '2026-01-01T00:00:00.000Z' });
    await expect(getPublishedAsset(h.ctx, scope, asset.id)).rejects.toThrow(/not.*found/i);
    expect(h.store.allEvents().slice(before)).toEqual([
      expect.objectContaining({ type: 'asset.unpublished', assetId: asset.id }),
    ]);
  });

  it('archives a draft with an unpublish event, and a second archive changes nothing', async () => {
    const asset = await upload(h);
    const before = h.store.allEvents().length;
    await archiveAsset(h.ctx, scope, asset.id);
    const again = await archiveAsset(h.ctx, scope, asset.id);
    expect(again.status).toBe('archived');
    // Sent whatever the read saw (see the race below); a no-op downstream for a draft.
    expect(h.store.allEvents().slice(before)).toEqual([
      expect.objectContaining({ type: 'asset.unpublished', assetId: asset.id }),
    ]);
  });

  it('takes the asset out of Delivery when a publish lands between its read and its commit', async () => {
    const asset = await upload(h);
    // The unit reads a draft; a publish commits before the archive does.
    const get = h.store.assets.get.bind(h.store.assets);
    h.store.assets.get = async (s, id) => {
      h.store.assets.get = get;
      const read = await get(s, id);
      await publishAsset(h.ctx, scope, asset.id);
      return read;
    };
    const before = h.store.allEvents().length;

    await archiveAsset(h.ctx, scope, asset.id);

    expect(await getAsset(h.ctx, scope, asset.id)).toMatchObject({ status: 'archived' });
    await expect(getPublishedAsset(h.ctx, scope, asset.id)).rejects.toThrow(/not.*found/i);
    expect(h.store.allEvents().slice(before).at(-1)).toMatchObject({
      type: 'asset.unpublished',
      assetId: asset.id,
    });
  });

  it('cannot publish while archived, and restores as a draft', async () => {
    const asset = await upload(h);
    await archiveAsset(h.ctx, scope, asset.id);
    await expect(publishAsset(h.ctx, scope, asset.id)).rejects.toBeInstanceOf(InvalidStateError);

    const restored = await restoreAsset(h.ctx, scope, asset.id);
    expect(restored.status).toBe('draft');
    expect(restored.archivedAt).toBeUndefined();
    // Restoring a draft is a no-op, not an error: a retried request is harmless.
    expect((await restoreAsset(h.ctx, scope, asset.id)).status).toBe('draft');
  });
});

describe('deleting an asset', () => {
  let h: ReturnType<typeof setup>;
  beforeEach(async () => {
    h = setup();
    await createSpace(h.ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('is refused while an entry links to it, naming the links', async () => {
    const asset = await upload(h);
    await publishAsset(h.ctx, scope, asset.id);
    const entryId = await linkFromEntry(h, asset.id);

    const refused = await deleteAsset(h.ctx, scope, asset.id).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AssetInUseError);
    expect((refused as AssetInUseError).usage).toEqual([
      expect.objectContaining({ fromEntryId: entryId, toId: asset.id }),
    ]);
    expect(await getAsset(h.ctx, scope, asset.id)).toMatchObject({ id: asset.id });
  });

  it('names each linking entry by type and title, and caps the list while counting all', async () => {
    const asset = await upload(h);
    await publishAsset(h.ctx, scope, asset.id);
    const entryId = await linkFromEntry(h, asset.id);
    const edges = Array.from({ length: 60 }, (_, i) => ({
      fromEntryId: `gone-${String(i).padStart(2, '0')}`,
      fromField: 'hero',
      toId: asset.id,
      toType: 'Asset' as const,
    }));
    for (const edge of edges)
      await h.store.references.replaceForEntry(scope, edge.fromEntryId, [edge]);

    const refused = (await deleteAsset(h.ctx, scope, asset.id).catch(
      (e: unknown) => e,
    )) as AssetInUseError;
    expect(refused).toBeInstanceOf(AssetInUseError);
    expect(refused.total).toBe(61);
    expect(refused.usage).toHaveLength(MAX_ASSET_USAGE_SHOWN);
    expect(refused.usage).toContainEqual({
      fromEntryId: entryId,
      fromField: 'hero',
      toId: asset.id,
      toType: 'Asset',
      contentTypeApiId: 'page',
      entryTitle: 'Home',
    });
    // An entry the store no longer has keeps the bare edge.
    expect(refused.usage.find((u) => u.fromEntryId.startsWith('gone-'))).not.toHaveProperty(
      'entryTitle',
    );
  });

  it('refuses a link made after the check: the store re-checks at commit', async () => {
    const asset = await upload(h);
    await publishAsset(h.ctx, scope, asset.id);
    // The link lands between the use-case's check and its commit.
    const original = h.store.references.findReverse.bind(h.store.references);
    let calls = 0;
    h.store.references.findReverse = async (s, id) => {
      calls += 1;
      if (calls === 1) {
        const found = await original(s, id);
        await h.store.references.replaceForEntry(s, 'late-entry', [
          { fromEntryId: 'late-entry', fromField: 'hero', toId: asset.id, toType: 'Asset' },
        ]);
        return found;
      }
      return original(s, id);
    };

    await expect(deleteAsset(h.ctx, scope, asset.id)).rejects.toBeInstanceOf(AssetInUseError);
    expect(await getAsset(h.ctx, scope, asset.id)).toMatchObject({ id: asset.id });
    expect(h.store.allEvents().some((e) => e.type === 'asset.deleted')).toBe(false);
  });

  it('deletes the row with its events, and the engine then removes the bytes', async () => {
    const asset = await upload(h);
    await publishAsset(h.ctx, scope, asset.id);
    const before = h.store.allEvents().length;

    await deleteAsset(h.ctx, scope, asset.id);

    await expect(getAsset(h.ctx, scope, asset.id)).rejects.toThrow(/not.*found/i);
    await expect(getPublishedAsset(h.ctx, scope, asset.id)).rejects.toThrow(/not.*found/i);
    expect(
      h.store
        .allEvents()
        .slice(before)
        .map((e) => e.type),
    ).toEqual(['asset.unpublished', 'asset.deleted']);
    // The bytes outlive the row until the event is handled.
    expect(h.blob.keys()).toContain(asset.r2Key);
    await h.drain();
    expect(h.blob.keys()).not.toContain(asset.r2Key);
  });

  it('removes the bytes once even when the event is delivered twice', async () => {
    const asset = await upload(h);
    await deleteAsset(h.ctx, scope, asset.id);
    const deleted = h.store.allEvents().find((e) => e.type === 'asset.deleted') as DomainEvent;
    await h.drain();
    await dispatchEvent(h.ctx, { sender: new RecordingWebhookSender(), blob: h.blob }, deleted);
    expect(h.blob.deletes.filter((k) => k === asset.r2Key)).toHaveLength(1);
  });

  it('deletes a hosted video from the video host', async () => {
    const { asset } = await createVideoAsset(h.ctx, scope, {
      fileName: 'intro.mp4',
      contentType: 'video/mp4',
    });
    await deleteAsset(h.ctx, scope, asset.id);
    await h.drain();
    expect(h.video.deleted).toEqual([asset.file.video?.videoId]);
  });

  it('keeps the bytes while another environment still has the asset (an import shares them)', async () => {
    const asset = await upload(h);
    await createEnvironment(h.ctx, 'shop', 'staging');
    const staging = { spaceId: 'shop', environmentId: 'staging' };
    // As an environment import copies it: same id, same file.
    await h.store.assets.create(staging, { ...asset });

    await deleteAsset(h.ctx, scope, asset.id);
    await h.drain();
    expect(h.blob.keys()).toContain(asset.r2Key);

    await deleteAsset(h.ctx, staging, asset.id);
    await h.drain();
    expect(h.blob.keys()).not.toContain(asset.r2Key);
  });

  it('never reaches into another space, whatever the key says', async () => {
    await h.blob.put('other/main/x/file.png', 'bytes', 'image/png');
    await dispatchEvent(
      h.ctx,
      { sender: new RecordingWebhookSender(), blob: h.blob },
      {
        id: 'evt-forged',
        type: 'asset.deleted',
        scope,
        occurredAt: '2026-01-01T00:00:00.000Z',
        assetId: 'x',
        r2Key: 'other/main/x/file.png',
      },
    );
    expect(h.blob.keys()).toContain('other/main/x/file.png');
  });
});
