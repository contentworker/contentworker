import {
  editorialReviewWorkflow,
  legacyStepsToGraph,
  NotFoundError,
  SCOPES,
  ValidationError,
} from '@contentworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  cloneEnvironment,
  createContentType,
  createEntry,
  createEnvironment,
  createSpace,
  createTag,
  createWorkflowDraft,
  defineWorkflow,
  exportSnapshot,
  getPublishedEntry,
  importSnapshot,
  listPreviewEntries,
  listWorkflows,
  listWorkflowVersions,
  publishContentType,
  publishEntry,
  publishWorkflowVersion,
  SNAPSHOT_VERSION,
  type SnapshotWorkflowV2,
  saveWorkflowDraft,
  setEntryMetadata,
} from '../src/index.js';

const source = { spaceId: 's1', environmentId: 'main' };
const target = { spaceId: 's1', environmentId: 'copy' };

let ctx: AppContext;
let store: InMemoryContentStore;

async function seedModel(scope = source) {
  await createContentType(ctx, scope, {
    apiId: 'article',
    name: 'Article',
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
      { apiId: 'body', name: 'Body', type: 'Text', localized: false, required: false, position: 1 },
    ],
  } as Parameters<typeof createContentType>[2]);
  await publishContentType(ctx, scope, 'article');
}

const article = (title: string) => ({
  contentTypeApiId: 'article',
  fields: { title: { 'en-US': title } },
});

beforeEach(async () => {
  store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 's1', defaultLocale: 'en-US', locales: ['en-US'] });
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  await createEnvironment(ctx, 's1', { environmentId: 'copy' });
  await seedModel();
});

describe('exporting an environment', () => {
  it('captures the content model, entries and taxonomy', async () => {
    const tag = await createTag(ctx, source, { name: 'news' });
    const { entry } = await createEntry(ctx, source, article('One'));
    await setEntryMetadata(ctx, source, entry.id, { tags: [tag.id], concepts: [] });

    const snapshot = await exportSnapshot(ctx, source);
    expect(snapshot.snapshotVersion).toBe(SNAPSHOT_VERSION);
    expect(snapshot.source).toEqual(source);
    expect(snapshot.contentTypes.map((c) => c.apiId)).toEqual(['article']);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]).toMatchObject({
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'One' } },
      metadata: { tags: [tag.id] },
    });
    expect(snapshot.taxonomy.tags.map((t) => t.name)).toEqual(['news']);
  });

  it('serializes to JSON without loss', async () => {
    await createEntry(ctx, source, article('One'));
    const snapshot = await exportSnapshot(ctx, source);
    // A snapshot is a file people move around; it has to survive the trip.
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('404s on an unknown space', async () => {
    await expect(
      exportSnapshot(ctx, { spaceId: 'nope', environmentId: 'main' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('importing a snapshot', () => {
  it('reports what it would do without writing anything, when asked to dry run', async () => {
    await createEntry(ctx, source, article('One'));
    const snapshot = await exportSnapshot(ctx, source);

    const report = await importSnapshot(ctx, target, snapshot, { dryRun: true });
    expect(report).toMatchObject({ dryRun: true, contentTypes: 1, entries: 1 });
    // Nothing landed.
    expect(await store.contentTypes.list(target)).toHaveLength(0);
    expect(await listPreviewEntries(ctx, target, {})).toHaveLength(0);
  });

  it('replays the model and entries into an empty environment', async () => {
    await createEntry(ctx, source, article('One'));
    await createEntry(ctx, source, article('Two'));
    const snapshot = await exportSnapshot(ctx, source);

    const report = await importSnapshot(ctx, target, snapshot);
    expect(report).toMatchObject({ dryRun: false, contentTypes: 1, entries: 2 });
    expect((await store.contentTypes.list(target)).map((c) => c.apiId)).toEqual(['article']);
    const entries = await listPreviewEntries(ctx, target, {});
    expect(entries.map((e) => e.fields.title)).toEqual(
      expect.arrayContaining([{ 'en-US': 'One' }, { 'en-US': 'Two' }]),
    );
  });

  it('republishes what was published, rebuilding the delivery read model', async () => {
    const { entry } = await createEntry(ctx, source, article('Live'));
    await publishEntry(ctx, source, entry.id);
    await createEntry(ctx, source, article('Draft only'));

    const report = await importSnapshot(ctx, target, await exportSnapshot(ctx, source));
    expect(report.published).toBe(1);

    // Published through the real use-case, so delivery serves it — the point of
    // replaying operations instead of injecting rows.
    const published = await store.entries.listPublished(target, {});
    expect(published).toHaveLength(1);
    expect(published[0]?.fields.title).toEqual({ 'en-US': 'Live' });
    await expect(
      getPublishedEntry(ctx, target, published[0]?.entryId as string),
    ).resolves.toBeTruthy();
  });

  it('emits publish events, so downstream indexes and caches converge', async () => {
    const { entry } = await createEntry(ctx, source, article('Live'));
    await publishEntry(ctx, source, entry.id);
    const before = (await store.outbox.readPending(100)).length;

    await importSnapshot(ctx, target, await exportSnapshot(ctx, source));
    const after = await store.outbox.readPending(100);
    expect(after.slice(before).filter((e) => e.type === 'entry.published')).toHaveLength(1);
  });

  it('leaves everything as drafts when publishing is turned off', async () => {
    const { entry } = await createEntry(ctx, source, article('Live'));
    await publishEntry(ctx, source, entry.id);

    const report = await importSnapshot(ctx, target, await exportSnapshot(ctx, source), {
      publish: false,
    });
    expect(report.published).toBe(0);
    expect(await store.entries.listPublished(target, {})).toHaveLength(0);
  });

  it('remaps taxonomy ids so entry metadata still resolves', async () => {
    const tag = await createTag(ctx, source, { name: 'news' });
    const { entry } = await createEntry(ctx, source, article('Tagged'));
    await setEntryMetadata(ctx, source, entry.id, { tags: [tag.id], concepts: [] });

    await importSnapshot(ctx, target, await exportSnapshot(ctx, source));
    const tags = await store.taxonomy.listTags(target);
    expect(tags).toHaveLength(1);

    // The imported entry points at the TARGET's tag, not the source's id.
    const [imported] = await listPreviewEntries(ctx, target, {});
    const meta = await store.taxonomy.getEntryMetadata(target, imported?.id as string);
    expect(meta?.tags).toEqual([tags[0]?.id]);
  });

  it('names what it deliberately did not carry', async () => {
    const { createAsset } = await import('../src/assets.js');
    const blob = {
      getUploadUrl: async () => 'https://upload',
      getDownloadUrl: async () => 'https://download',
      delete: async () => {},
    };
    await createAsset(ctx, blob as never, source, { fileName: 'a.png', contentType: 'image/png' });

    const report = await importSnapshot(ctx, target, await exportSnapshot(ctx, source));
    // Binaries stay in the source bucket; an operator should be told, not
    // left to discover it.
    expect(report.skipped.join(' ')).toContain('asset');
  });

  it('refuses a target that already has a content model', async () => {
    await seedModel(target);
    // Merging two content models is a different and much harder operation.
    await expect(
      importSnapshot(ctx, target, await exportSnapshot(ctx, source)),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses a snapshot it cannot read', async () => {
    const snapshot = { ...(await exportSnapshot(ctx, source)), snapshotVersion: 99 };
    await expect(importSnapshot(ctx, target, snapshot)).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses an unknown target space', async () => {
    await expect(
      importSnapshot(
        ctx,
        { spaceId: 'nope', environmentId: 'main' },
        await exportSnapshot(ctx, source),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects content the current model would refuse', async () => {
    // A snapshot is not a back door: entries go through createEntry, so one
    // that fails today's validation fails the import loudly.
    const snapshot = await exportSnapshot(ctx, source);
    const broken = {
      ...snapshot,
      entries: [{ id: 'x', contentTypeApiId: 'article', status: 'draft', fields: {} }],
    };
    await expect(importSnapshot(ctx, target, broken)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('workflows in snapshots', () => {
  const STEPS = [
    { id: 'draft', name: 'Draft', requiredScope: SCOPES.contentWrite },
    { id: 'approved', name: 'Approved', requiredScope: SCOPES.contentPublish },
  ];

  it('exports format 2: draft graph, derived steps and versions oldest first', async () => {
    const t = editorialReviewWorkflow();
    const { workflow } = await createWorkflowDraft(ctx, source, {
      name: 'Review',
      contentTypes: ['article'],
      graph: t.graph,
    });
    await publishWorkflowVersion(ctx, source, workflow.id);
    await saveWorkflowDraft(ctx, source, workflow.id, { name: 'Review (edited)' });
    await publishWorkflowVersion(ctx, source, workflow.id);
    await saveWorkflowDraft(ctx, source, workflow.id, { description: 'unpublished edit' });

    const [exported] = (await exportSnapshot(ctx, source)).workflows as SnapshotWorkflowV2[];
    expect(exported).toMatchObject({
      format: 2,
      name: 'Review (edited)',
      description: 'unpublished edit',
      contentTypes: ['article'],
      graph: t.graph,
    });
    expect(exported?.versions?.map((v) => [v.version, v.name])).toEqual([
      [1, 'Review'],
      [2, 'Review (edited)'],
    ]);
  });

  it('round-trips versions and the unpublished draft through import', async () => {
    const { workflow } = await createWorkflowDraft(ctx, source, {
      name: 'Review',
      graph: editorialReviewWorkflow().graph,
    });
    await publishWorkflowVersion(ctx, source, workflow.id);
    await saveWorkflowDraft(ctx, source, workflow.id, { description: 'draft only' });

    const report = await importSnapshot(ctx, target, await exportSnapshot(ctx, source));
    expect(report.workflows).toBe(1);
    const [imported] = await listWorkflows(ctx, target);
    expect(imported).toMatchObject({ name: 'Review', description: 'draft only', latestVersion: 1 });
    const [v1] = await listWorkflowVersions(ctx, target, imported!.id);
    expect(v1?.description).toBe('');
  });

  it('still imports format 1 (legacy steps) by converting and publishing v1', async () => {
    const snapshot = {
      ...(await exportSnapshot(ctx, source)),
      workflows: [{ id: 'old', name: 'Legacy', steps: STEPS }],
    };
    await importSnapshot(ctx, target, snapshot);
    const [imported] = await listWorkflows(ctx, target);
    expect(imported).toMatchObject({ name: 'Legacy', steps: STEPS, latestVersion: 1 });
    expect(imported?.graph).toEqual(legacyStepsToGraph({ steps: STEPS }));
  });

  it('exports legacy-defined workflows as format 2 too', async () => {
    await defineWorkflow(ctx, source, { name: 'Legacy', steps: STEPS });
    const [exported] = (await exportSnapshot(ctx, source)).workflows as SnapshotWorkflowV2[];
    expect(exported).toMatchObject({ format: 2, steps: STEPS });
    expect(exported?.versions).toHaveLength(1);
  });

  it('skips, and names, a version that no longer validates', async () => {
    const snapshot = await exportSnapshot(ctx, source);
    const good = editorialReviewWorkflow().graph;
    const broken: SnapshotWorkflowV2 = {
      format: 2,
      id: 'w',
      name: 'W',
      steps: [],
      description: '',
      contentTypes: [],
      graph: good,
      gatesPublish: false,
      versions: [
        {
          id: 'w',
          name: 'W',
          description: '',
          contentTypes: [],
          graph: { nodes: [], edges: [] },
          version: 1,
          publishedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    const report = await importSnapshot(ctx, target, { ...snapshot, workflows: [broken] });
    expect(report.skipped.join(' ')).toMatch(/workflow "W" version 1/);
    const [imported] = await listWorkflows(ctx, target);
    expect(imported).toMatchObject({ latestVersion: null, graph: good });
  });
});

describe('cloning an environment', () => {
  it('copies one environment onto another with no file in between', async () => {
    const { entry } = await createEntry(ctx, source, article('Live'));
    await publishEntry(ctx, source, entry.id);

    const report = await cloneEnvironment(ctx, source, target);
    expect(report).toMatchObject({ contentTypes: 1, entries: 1, published: 1 });
    expect(await listPreviewEntries(ctx, target, {})).toHaveLength(1);
    expect(await store.entries.listPublished(target, {})).toHaveLength(1);
  });

  it('clones across spaces, which merge cannot do', async () => {
    await createSpace(ctx, { spaceId: 's2', name: 'Two', defaultLocale: 'en-US' });
    await createEntry(ctx, source, article('One'));

    const other = { spaceId: 's2', environmentId: 'main' };
    await expect(cloneEnvironment(ctx, source, other)).resolves.toMatchObject({ entries: 1 });
    expect(await listPreviewEntries(ctx, other, {})).toHaveLength(1);
  });

  it('leaves the source untouched', async () => {
    await createEntry(ctx, source, article('One'));
    await cloneEnvironment(ctx, source, target);
    expect(await listPreviewEntries(ctx, source, {})).toHaveLength(1);
  });
});
