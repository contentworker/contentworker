import {
  InvalidStateError,
  NotFoundError,
  publishRelease as publishReleaseState,
  type Release,
  type ReleaseItem,
  type ReleaseWithItems,
  type Scope,
} from '@contentworker/domain';
import type { AppContext } from './context';
import { assertReleaseUngated, loadPublishGuard, type PublishGrant } from './publish-gate';
import { publishEntryTx, unpublishEntryTx } from './publishing';

export interface CreateReleaseInput {
  readonly title: string;
  readonly description?: string;
}

/** Creates an open (empty) release. */
export async function createRelease(
  ctx: AppContext,
  scope: Scope,
  input: CreateReleaseInput,
): Promise<Release> {
  const release: Release = {
    id: ctx.ids.newId(),
    title: input.title,
    description: input.description,
    status: 'open',
    createdAt: ctx.clock.now().toISOString(),
  };
  await ctx.store.releases.create(scope, release);
  return release;
}

/** A release in the list, with how many members it holds (so a list never reads each one). */
export interface ReleaseSummary extends Release {
  readonly itemCount: number;
}

/** Every release, newest first, each with its member count from one grouped query. */
export async function listReleases(ctx: AppContext, scope: Scope): Promise<ReleaseSummary[]> {
  const releases = await ctx.store.releases.list(scope);
  const counts = await ctx.store.releases.countItems(
    scope,
    releases.map((r) => r.id),
  );
  return releases.map((r) => ({ ...r, itemCount: counts.get(r.id) ?? 0 }));
}

/** Returns a release with its members. */
export async function getRelease(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<ReleaseWithItems> {
  const release = await ctx.store.releases.get(scope, id);
  if (!release) throw new NotFoundError('Release', id);
  const items = await ctx.store.releases.listItems(scope, id);
  return { release, items };
}

export interface AddReleaseItemInput {
  readonly entityId: string;
  readonly action?: ReleaseItem['action'];
}

/** Adds (or replaces) an entry in an open release. */
export async function addEntryToRelease(
  ctx: AppContext,
  scope: Scope,
  releaseId: string,
  input: AddReleaseItemInput,
): Promise<ReleaseWithItems> {
  const release = await ctx.store.releases.get(scope, releaseId);
  if (!release) throw new NotFoundError('Release', releaseId);
  if (release.status !== 'open') {
    throw new InvalidStateError(`Cannot modify a ${release.status} release`);
  }
  if (!(await ctx.store.entries.get(scope, input.entityId))) {
    throw new NotFoundError('Entry', input.entityId);
  }
  await ctx.store.releases.addItem(scope, releaseId, {
    entityType: 'Entry',
    entityId: input.entityId,
    action: input.action ?? 'publish',
  });
  return getRelease(ctx, scope, releaseId);
}

export async function removeEntryFromRelease(
  ctx: AppContext,
  scope: Scope,
  releaseId: string,
  entityId: string,
): Promise<ReleaseWithItems> {
  const release = await ctx.store.releases.get(scope, releaseId);
  if (!release) throw new NotFoundError('Release', releaseId);
  if (release.status !== 'open') {
    throw new InvalidStateError(`Cannot modify a ${release.status} release`);
  }
  await ctx.store.releases.removeItem(scope, releaseId, entityId);
  return getRelease(ctx, scope, releaseId);
}

export async function deleteRelease(ctx: AppContext, scope: Scope, id: string): Promise<void> {
  const release = await ctx.store.releases.get(scope, id);
  if (!release) throw new NotFoundError('Release', id);
  if (release.status === 'published') {
    throw new InvalidStateError('Cannot delete a published release');
  }
  await ctx.store.releases.delete(scope, id);
}

/**
 * Ships a release: every member is published/unpublished inside ONE transaction,
 * so the bundle is all-or-nothing. Each member emits its usual `entry.published`
 * event (reusing the full publish fan-out), plus a summary `release.published`
 * event. If any member fails, the whole transaction rolls back and nothing ships.
 *
 * A release holding an entry a gated workflow covers is refused whole, naming every such entry
 * (adding one is allowed: gating can change before the release ships, so it is checked here, at
 * publish time). Only a run of the covering workflow (`content.publish_release`, which passes its
 * `grant`) may ship it.
 */
export async function publishRelease(
  ctx: AppContext,
  scope: Scope,
  id: string,
  opts: { readonly grant?: PublishGrant } = {},
): Promise<ReleaseWithItems> {
  return ctx.store.withTransaction(async (tx) => {
    const release = await tx.releases.get(scope, id);
    if (!release) throw new NotFoundError('Release', id);
    const items = await tx.releases.listItems(scope, id);
    if (items.length === 0) throw new InvalidStateError('Cannot publish an empty release');

    const guard = await loadPublishGuard(tx.workflowGraphs, scope, opts.grant);
    await assertReleaseUngated(tx, scope, id, items, guard);

    const shipped = publishReleaseState(release, ctx.clock.now().toISOString());

    const entryIds: string[] = [];
    for (const item of items) {
      if (item.action === 'publish') {
        await publishEntryTx(ctx, tx, scope, item.entityId, {}, guard);
      } else {
        await unpublishEntryTx(ctx, tx, scope, item.entityId);
      }
      entryIds.push(item.entityId);
    }

    await tx.releases.save(scope, shipped);
    await tx.outbox.append({
      id: ctx.ids.newId(),
      type: 'release.published',
      scope,
      occurredAt: ctx.clock.now().toISOString(),
      releaseId: shipped.id,
      entryIds,
    });

    return { release: shipped, items };
  });
}
