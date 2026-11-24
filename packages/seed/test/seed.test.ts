import type { AppContext } from '@contentworker/application';
import {
  assetObjectKey,
  countPendingApprovals,
  createAsset,
  deleteTag,
  getEntry,
  getPreviewEntry,
  listAgentReviews,
  listAgentRuns,
  listAssets,
  listAuditLog,
  listContentTypes,
  listModerationHolds,
  listPreviewEntries,
  listReleases,
  listScheduledActions,
  listTags,
  listWebhooks,
  listWorkflows,
} from '@contentworker/application';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import { type SeedConfig, seedDev, volumes } from '../src/index';

const config: SeedConfig = {
  spaceId: 'space-1',
  environmentId: 'main',
  defaultLocale: 'en-US',
  locales: ['en-US', 'de-DE'],
  cmaKey: 'dev-cma-key',
  cdaKey: 'dev-cda-key',
  cpaKey: 'dev-cpa-key',
};
const scope = { spaceId: config.spaceId, environmentId: config.environmentId };

function makeContext(): AppContext {
  const store = new InMemoryContentStore();
  return { store, clock: new FixedClock(), ids: new SequenceIdGenerator('s') };
}

// Every test here seeds a corpus through the real use-cases — hundreds to
// thousands of entries — so they are legitimately slow, and the sibling tests
// were running at 2.4s against vitest 4's 5s default: a margin thin enough to
// flip on a loaded runner. Scoped to this suite rather than raised globally,
// because the shorter default is a useful signal everywhere else and a
// project-wide bump would hide the next slow test.
describe('seedDev', { timeout: 60_000 }, () => {
  it('seeds every capability surface against a fresh store', async () => {
    const ctx = makeContext();
    await seedDev(ctx, config, { blob: new FakeBlobStore() });

    const vol = volumes(1);
    const articles = await listPreviewEntries(ctx, scope, {
      contentTypeApiId: 'article',
      locale: 'en-US',
      limit: vol.articles + 10,
    });
    expect(articles.length).toBe(vol.articles);
    // Status mix: drafts, changed, and published all present.
    const statuses = new Set(articles.map((a) => a.status));
    expect(statuses).toContain('draft');
    expect(statuses).toContain('changed');
    expect(statuses).toContain('published');

    expect((await listAssets(ctx, scope)).items.length).toBeGreaterThan(0);
    expect((await listReleases(ctx, scope)).map((r) => r.title)).toContain('Autumn launch');
    expect((await listWorkflows(ctx, scope)).length).toBe(2);
    expect((await listWebhooks(ctx, scope)).length).toBe(3);
    expect((await listScheduledActions(ctx, scope)).length).toBeGreaterThan(0);
    expect((await listAgentRuns(ctx, scope, {})).length).toBeGreaterThan(0);
    expect((await listAuditLog(ctx, config.spaceId)).items.length).toBeGreaterThan(0);
    // The completion marker lands last.
    expect((await listTags(ctx, scope)).map((t) => t.name)).toContain('demo-seed-v3');
    // All three scheduled actions: release publish, entry publish, entry unpublish.
    expect((await listScheduledActions(ctx, scope)).length).toBe(3);
  });

  it('proposes real rewrites of each entry, with the reason only in the notes', async () => {
    const ctx = makeContext();
    await seedDev(ctx, config, { blob: new FakeBlobStore() });

    const reviews = await listAgentReviews(ctx, scope, { status: 'pending' });
    expect(reviews.length).toBe(8);
    expect(new Set(reviews.map((r) => Object.keys(r.proposed)[0]))).toEqual(
      new Set(['summary', 'body']),
    );
    for (const review of reviews) {
      const entry = await getPreviewEntry(ctx, scope, review.entryId);
      expect(review.notes.length).toBeGreaterThan(0);
      for (const [field, byLocale] of Object.entries(review.proposed)) {
        const proposed = byLocale['en-US'];
        const current = (entry.fields[field] as Record<string, unknown>)['en-US'];
        expect(typeof proposed).toBe('string');
        // A value Approvals would diff as "no change", or one that is really a label, fails here.
        expect(proposed).not.toBe(current);
        expect(proposed).not.toMatch(/agent proposal|seeded review/i);
        for (const note of review.notes) expect(proposed).not.toContain(note);
      }
    }
  });

  it('holds two published articles for moderation, offline and waiting in Approvals', async () => {
    const ctx = makeContext();
    await seedDev(ctx, config, { blob: new FakeBlobStore() });
    const holds = await listModerationHolds(ctx, scope, { status: 'open' });
    expect(holds.map((h) => h.flags)).toEqual(
      expect.arrayContaining([['harassment'], ['house_rules', 'other_unsafe']]),
    );
    expect(holds).toHaveLength(2);
    for (const hold of holds) {
      const { entry } = await getEntry(ctx, scope, hold.entryId);
      expect(entry.publishedVersion).toBeNull();
      expect(hold).toMatchObject({
        contentTypeApiId: 'article',
        entryVersion: entry.currentVersion,
      });
    }
    expect((await countPendingApprovals(ctx, scope)).moderationHolds).toBe(2);
    // The same two, run after run: the seed is deterministic.
    const again = makeContext();
    await seedDev(again, config, { blob: new FakeBlobStore() });
    const ids = async (c: AppContext) =>
      (await listModerationHolds(c, scope, { status: 'open' })).map((h) => h.entryId).sort();
    expect(await ids(again)).toEqual(await ids(ctx));
    // A second run over the same space holds nothing more.
    await seedDev(ctx, config, { blob: new FakeBlobStore() });
    expect(await listModerationHolds(ctx, scope)).toHaveLength(2);
  });

  it('seeds content types that show the nav in every state', async () => {
    const ctx = makeContext();
    await seedDev(ctx, config, { blob: new FakeBlobStore() });
    const types = await listContentTypes(ctx, scope);
    const by = (apiId: string) => types.find((t) => t.apiId === apiId);
    // The demo model's eight, ungrouped, beside two groups.
    expect(types.filter((t) => !t.group).length).toBeGreaterThanOrEqual(8);
    expect(new Set(types.flatMap((t) => (t.group ? [t.group] : [])))).toEqual(
      new Set(['Newsroom', 'Site']),
    );
    // An icon from the name, one picked by hand, and a name that suggests none.
    expect(by('pressRelease')?.icon).toBe('megaphone');
    expect(by('investorBriefing')?.icon).toBe('briefcase');
    expect(by('widget')?.icon).toBeUndefined();
    expect(by('siteSettings')?.singleton).toBe(true);
    // One left unpublished; every other type is live.
    expect(types.filter((t) => t.status !== 'published').map((t) => t.apiId)).toEqual([
      'testimonial',
    ]);
  });

  it('is idempotent — a second run creates nothing new', async () => {
    const ctx = makeContext();
    const blob = new FakeBlobStore();
    await seedDev(ctx, config, { blob });

    const before = {
      entries: (await listPreviewEntries(ctx, scope, { locale: 'en-US', limit: 10_000 })).length,
      tags: (await listTags(ctx, scope)).length,
      releases: (await listReleases(ctx, scope)).length,
      runs: (await listAgentRuns(ctx, scope, {})).length,
    };
    await seedDev(ctx, config, { blob });
    const after = {
      entries: (await listPreviewEntries(ctx, scope, { locale: 'en-US', limit: 10_000 })).length,
      tags: (await listTags(ctx, scope)).length,
      releases: (await listReleases(ctx, scope)).length,
      runs: (await listAgentRuns(ctx, scope, {})).length,
    };
    expect(after).toEqual(before);
  });

  it('stores a real file for every seeded image and document, and none for videos', async () => {
    const ctx = makeContext();
    const blob = new FakeBlobStore();
    await seedDev(ctx, config, { blob });
    const keys = blob.keys();
    const png = keys.filter((k) => k.endsWith('.png'));
    const pdf = keys.filter((k) => k.endsWith('.pdf'));
    expect(png.length).toBeGreaterThan(0);
    expect(pdf.length).toBeGreaterThan(0);
    expect(keys.some((k) => k.endsWith('.mp4'))).toBe(false);
    // PNG signature and PDF header: the bytes are the files their names say.
    expect([...(blob.bytes(png[0] as string) ?? []).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(await blob.get(pdf[0] as string)).toMatch(/^%PDF-1\.4/);
  });

  it('restores the files of a space seeded before the seed stored any, and nothing else', async () => {
    const ctx = makeContext();
    const blob = new FakeBlobStore();
    await seedDev(ctx, config, { blob });
    const assets = (await listAssets(ctx, scope, { limit: 100 })).items;
    const image = assets.find((a) => a.file.contentType === 'image/png');
    const pdf = assets.find((a) => a.file.contentType === 'application/pdf');
    if (!image || !pdf) throw new Error('seeded an image and a document');
    const imageKey = assetObjectKey(scope, image.id, image.file.fileName);
    const pdfKey = assetObjectKey(scope, pdf.id, pdf.file.fileName);
    // An upload of the person's own whose bytes never landed: not the seed's to fill in.
    const { asset: own } = await createAsset(ctx, blob, scope, {
      fileName: 'my-photo.png',
      contentType: 'image/png',
      title: { 'en-US': 'Mine' },
    });
    const ownKey = assetObjectKey(scope, own.id, own.file.fileName);
    // The space as an older seed left it: asset rows, an empty bucket, no files marker.
    await blob.delete(imageKey);
    await blob.delete(pdfKey);
    await blob.delete(ownKey);
    const marker = (await listTags(ctx, scope)).find((t) => t.name === 'demo-asset-files-v1');
    if (!marker) throw new Error('the files marker is set on a fresh seed');
    await deleteTag(ctx, scope, marker.id);

    await seedDev(ctx, config, { blob });
    expect([...(blob.bytes(imageKey) ?? []).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(await blob.get(pdfKey)).toMatch(/^%PDF-1\.4/);
    expect(await blob.head(ownKey)).toBeNull();

    // Marked done: a file removed afterwards is not written again on the next boot.
    await blob.delete(imageKey);
    await seedDev(ctx, config, { blob });
    expect(await blob.head(imageKey)).toBeNull();
  });

  it('scales the generated corpus linearly', async () => {
    const ctx = makeContext();
    await seedDev(ctx, { ...config, scale: 2 }, { blob: new FakeBlobStore() });
    const articles = await listPreviewEntries(ctx, scope, {
      contentTypeApiId: 'article',
      locale: 'en-US',
      limit: 10_000,
    });
    expect(articles.length).toBe(volumes(2).articles);
  });
});
