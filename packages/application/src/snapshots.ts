import {
  type Asset,
  type Concept,
  type ConceptScheme,
  type ContentType,
  type EntryFields,
  type EntryMetadata,
  NotFoundError,
  type Scope,
  type Tag,
  ValidationError,
  type WorkflowDefinition,
  type WorkflowGraph,
  type WorkflowVersion,
} from '@contentworker/domain';
import { createContentType, publishContentType } from './content-types.js';
import type { AppContext } from './context.js';
import { createEntry } from './entries.js';
import { publishEntry } from './publishing.js';
import { createConcept, createScheme, createTag, setEntryMetadata } from './taxonomy.js';
import {
  createWorkflowDraft,
  defineWorkflow,
  listWorkflows,
  publishWorkflowVersion,
  saveWorkflowDraft,
} from './workflows.js';

/**
 * Environment snapshots: export an environment to portable JSON, and replay it
 * into another one.
 *
 * Scoped to an environment rather than a whole space because that is the unit
 * every other operation takes — a space export is "export each environment" —
 * and because the useful destinations (a new space for a customer, a staging
 * branch, a restore) are all environment-shaped.
 *
 * Import **replays domain operations** rather than injecting rows: entries are
 * created through `createEntry` and published through `publishEntry`. That is
 * slower than a bulk insert and deliberately so — it means validation, the
 * reference graph, the published read model, the outbox and the search index
 * all end up in the state they would have reached organically, instead of a
 * snapshot format silently becoming a second, half-correct way to write data.
 */

/** Bumped when the shape changes incompatibly; import refuses what it can't read. */
export const SNAPSHOT_VERSION = 1;

export interface SnapshotEntry {
  readonly id: string;
  readonly contentTypeApiId: string;
  /** `published` entries are republished on import; everything else lands as a draft. */
  readonly status: string;
  readonly fields: EntryFields;
  readonly metadata?: EntryMetadata;
}

export interface EnvironmentSnapshot {
  readonly snapshotVersion: number;
  readonly exportedAt: string;
  readonly source: { readonly spaceId: string; readonly environmentId: string };
  readonly contentTypes: readonly ContentType[];
  readonly entries: readonly SnapshotEntry[];
  /** Metadata only — binaries stay in the blob store and are never copied. */
  readonly assets: readonly Asset[];
  readonly taxonomy: {
    readonly schemes: readonly ConceptScheme[];
    readonly concepts: readonly Concept[];
    readonly tags: readonly Tag[];
  };
  readonly workflows: readonly SnapshotWorkflow[];
}

/**
 * A workflow in a snapshot. Format 2 (written since versioned graphs) carries the draft graph and
 * the published versions; `steps` is the derived legacy view, kept so older importers still read
 * it. Format 1 (no `format` field) is the legacy `{id, name, steps}` shape, still accepted.
 */
export type SnapshotWorkflow = SnapshotWorkflowV2 | WorkflowDefinition;

export interface SnapshotWorkflowV2 extends WorkflowDefinition {
  readonly format: 2;
  readonly description: string;
  readonly contentTypes: readonly string[];
  readonly graph: WorkflowGraph;
  readonly gatesPublish: boolean;
  /** Published versions, oldest first. Replayed in order on import (renumbered from 1). */
  readonly versions?: readonly WorkflowVersion[];
}

const isV2 = (w: SnapshotWorkflow): w is SnapshotWorkflowV2 =>
  (w as { format?: unknown }).format === 2;

export interface ExportOptions {
  /** Cap on entries per content type. Omit for everything. */
  readonly limit?: number;
}

/**
 * Reads an environment into a snapshot.
 *
 * Deliberately excluded, and not by oversight: API keys, OAuth clients and
 * grants, preview tokens and webhook signing secrets are credentials, and a
 * snapshot is a file people email themselves. The audit log and the outbox are
 * history rather than state. Asset *binaries* stay in the blob store — the
 * snapshot carries their metadata, so a restore into a space pointing at the
 * same bucket works and one pointing elsewhere has dangling files, which is
 * visible rather than silent.
 */
export async function exportSnapshot(
  ctx: AppContext,
  scope: Scope,
  options: ExportOptions = {},
): Promise<EnvironmentSnapshot> {
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);

  const contentTypes = await ctx.store.contentTypes.list(scope);
  const rows = await ctx.store.entries.list(scope, { limit: options.limit });
  const metadata = await ctx.store.taxonomy.getEntryMetadataMany(
    scope,
    rows.map((r) => r.entry.id),
  );
  const byEntry = new Map(metadata.map((m) => [m.entryId, m]));

  return {
    snapshotVersion: SNAPSHOT_VERSION,
    exportedAt: ctx.clock.now().toISOString(),
    source: { spaceId: scope.spaceId, environmentId: scope.environmentId },
    contentTypes,
    entries: rows.map((r) => ({
      id: r.entry.id,
      contentTypeApiId: r.entry.contentTypeApiId,
      status: r.entry.status,
      fields: r.fields,
      metadata: byEntry.get(r.entry.id)?.metadata,
    })),
    assets: await ctx.store.assets.list(scope, {}),
    taxonomy: {
      schemes: await ctx.store.taxonomy.listSchemes(scope),
      concepts: await ctx.store.taxonomy.listConcepts(scope),
      tags: await ctx.store.taxonomy.listTags(scope),
    },
    workflows: await exportWorkflows(ctx, scope),
  };
}

async function exportWorkflows(ctx: AppContext, scope: Scope): Promise<SnapshotWorkflowV2[]> {
  const out: SnapshotWorkflowV2[] = [];
  for (const w of await listWorkflows(ctx, scope)) {
    const versions = await ctx.store.workflowGraphs.listVersions(scope, w.id);
    out.push({
      format: 2,
      id: w.id,
      name: w.name,
      steps: w.steps,
      description: w.description,
      contentTypes: w.contentTypes,
      graph: w.graph,
      gatesPublish: w.gatesPublish,
      ...(versions.length > 0 ? { versions: [...versions].reverse() } : {}),
    });
  }
  return out;
}

/**
 * Replays one snapshot workflow through the use-cases. Format 1 goes through `defineWorkflow`
 * (convert + publish v1). Format 2 replays each published version (draft save + publish, so each
 * is re-validated) and then restores the draft; a version today's validator refuses is skipped
 * and named rather than aborting the whole import.
 */
async function importWorkflow(
  ctx: AppContext,
  target: Scope,
  workflow: SnapshotWorkflow,
  skipped: string[],
): Promise<void> {
  if (!isV2(workflow)) {
    await defineWorkflow(ctx, target, { name: workflow.name, steps: workflow.steps });
    return;
  }
  const versions = workflow.versions ?? [];
  const first = versions[0];
  const { workflow: created } = await createWorkflowDraft(ctx, target, {
    name: first?.name ?? workflow.name,
    description: first?.description ?? workflow.description,
    contentTypes: first?.contentTypes ?? workflow.contentTypes,
    gatesPublish: first?.gatesPublish ?? workflow.gatesPublish,
    graph: first?.graph ?? workflow.graph,
  });
  for (const version of versions) {
    await saveWorkflowDraft(ctx, target, created.id, {
      name: version.name,
      description: version.description,
      contentTypes: version.contentTypes,
      gatesPublish: version.gatesPublish ?? false,
      graph: version.graph,
    });
    try {
      await publishWorkflowVersion(ctx, target, created.id, {
        ...(version.publishedBy ? { publishedBy: version.publishedBy } : {}),
      });
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      skipped.push(
        `workflow "${workflow.name}" version ${version.version}: no longer passes validation`,
      );
    }
  }
  await saveWorkflowDraft(ctx, target, created.id, {
    name: workflow.name,
    description: workflow.description,
    contentTypes: workflow.contentTypes,
    gatesPublish: workflow.gatesPublish,
    graph: workflow.graph,
  });
}

export interface ImportOptions {
  /** Report what would happen without writing anything. */
  readonly dryRun?: boolean;
  /**
   * Republish entries that were published in the snapshot. On by default:
   * a clone that silently arrives entirely as drafts looks like data loss.
   */
  readonly publish?: boolean;
}

export interface ImportReport {
  readonly dryRun: boolean;
  readonly contentTypes: number;
  readonly entries: number;
  readonly published: number;
  readonly taxonomy: number;
  readonly workflows: number;
  /** Things that were present in the snapshot and deliberately not imported. */
  readonly skipped: readonly string[];
}

/**
 * Replays a snapshot into `target`.
 *
 * Refuses a target that already holds content types, because the alternative —
 * merging two content models — is a different and much harder operation than
 * "make this environment look like that one", and doing it badly silently
 * corrupts both. Use a fresh environment, or `compareEnvironments`/
 * `mergeEnvironments` for the intra-space case.
 */
export async function importSnapshot(
  ctx: AppContext,
  target: Scope,
  snapshot: EnvironmentSnapshot,
  options: ImportOptions = {},
): Promise<ImportReport> {
  if (snapshot.snapshotVersion !== SNAPSHOT_VERSION) {
    throw new ValidationError([
      {
        field: 'snapshotVersion',
        message: `Unsupported snapshot version ${snapshot.snapshotVersion}; this server reads version ${SNAPSHOT_VERSION}`,
      },
    ]);
  }
  const config = await ctx.store.spaces.getConfig(target);
  if (!config) throw new NotFoundError('Space', target.spaceId);

  const existing = await ctx.store.contentTypes.list(target);
  if (existing.length > 0) {
    throw new ValidationError([
      {
        field: 'target',
        message: `Target environment "${target.environmentId}" already defines ${existing.length} content type(s); import expects an empty environment`,
      },
    ]);
  }

  const skipped: string[] = [];
  if (snapshot.assets.length > 0) {
    // Named rather than silently dropped: an operator restoring content should
    // know the binaries did not travel with it.
    skipped.push(
      `${snapshot.assets.length} asset(s): metadata only, binaries stay in the source blob store`,
    );
  }

  const publishable = snapshot.entries.filter((e) => e.status === 'published');
  const report: ImportReport = {
    dryRun: options.dryRun === true,
    contentTypes: snapshot.contentTypes.length,
    entries: snapshot.entries.length,
    published: options.publish === false ? 0 : publishable.length,
    taxonomy:
      snapshot.taxonomy.schemes.length +
      snapshot.taxonomy.concepts.length +
      snapshot.taxonomy.tags.length,
    workflows: snapshot.workflows.length,
    skipped,
  };
  if (options.dryRun) return report;

  // Content model first: entries cannot be validated without it.
  for (const ct of snapshot.contentTypes) {
    await createContentType(ctx, target, {
      apiId: ct.apiId,
      name: ct.name,
      displayField: ct.displayField,
      fields: [...ct.fields],
    });
    if (ct.status === 'published') await publishContentType(ctx, target, ct.apiId);
  }

  // Taxonomy before entries, so entry metadata has something to point at.
  // Ids are preserved so a snapshot's entry→tag links keep resolving.
  const taxonomyIds = new Map<string, string>();
  for (const scheme of snapshot.taxonomy.schemes) {
    const created = await createScheme(ctx, target, { name: scheme.name });
    taxonomyIds.set(scheme.id, created.id);
  }
  for (const concept of snapshot.taxonomy.concepts) {
    const created = await createConcept(ctx, target, {
      schemeId: taxonomyIds.get(concept.schemeId) ?? concept.schemeId,
      prefLabel: concept.prefLabel,
    });
    taxonomyIds.set(concept.id, created.id);
  }
  for (const tag of snapshot.taxonomy.tags) {
    const created = await createTag(ctx, target, { name: tag.name });
    taxonomyIds.set(tag.id, created.id);
  }

  for (const workflow of snapshot.workflows) {
    await importWorkflow(ctx, target, workflow, skipped);
  }

  // Entries are created through the real use-case, so a snapshot cannot
  // introduce content that would fail today's validation.
  const created = new Map<string, string>();
  for (const entry of snapshot.entries) {
    const result = await createEntry(ctx, target, {
      contentTypeApiId: entry.contentTypeApiId,
      fields: entry.fields,
    });
    created.set(entry.id, result.entry.id);

    const tags = entry.metadata?.tags.map((t) => taxonomyIds.get(t) ?? t) ?? [];
    const concepts = entry.metadata?.concepts.map((c) => taxonomyIds.get(c) ?? c) ?? [];
    if (tags.length > 0 || concepts.length > 0) {
      await setEntryMetadata(ctx, target, result.entry.id, { tags, concepts });
    }
  }

  if (options.publish !== false) {
    for (const entry of publishable) {
      const id = created.get(entry.id);
      // Publishing through the use-case rebuilds the read model, the reference
      // edges and the outbox event, so the target reaches the same state it
      // would have by being published normally.
      if (id) await publishEntry(ctx, target, id);
    }
  }
  return report;
}

/**
 * Copies one environment onto another — export plus import, with no file in
 * between. The cross-space case that `mergeEnvironments` does not cover.
 */
export async function cloneEnvironment(
  ctx: AppContext,
  source: Scope,
  target: Scope,
  options: ImportOptions = {},
): Promise<ImportReport> {
  return importSnapshot(ctx, target, await exportSnapshot(ctx, source), options);
}
