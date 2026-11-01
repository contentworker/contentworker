import type { ContentType, UniqueClaim } from '@contentworker/domain';
import {
  applyDefaults,
  archive,
  assertEntryFieldsValid,
  assignBlockKeys,
  ConflictError,
  deriveStatus,
  EMPTY_METADATA,
  type Entry,
  type EntryFields,
  type EntryVersion,
  hasUniqueFields,
  InvalidStateError,
  NotFoundError,
  nextSlugCandidate,
  normalizeSlugFields,
  restore,
  type Scope,
  saveDraft,
  uniqueClaims,
  type ValidationContext,
} from '@contentworker/domain';
import type { BlobStore, ContentStoreTx } from '@contentworker/ports';
import type { AppContext } from './context';
import { runHook } from './hooks';
import { unpublishEntryTx } from './publishing';
import { versionBodyPrefix } from './version-archive';

/** Loads the validation context (locales) for a scope. */
async function loadValidationContext(ctx: AppContext, scope: Scope): Promise<ValidationContext> {
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  return { defaultLocale: config.defaultLocale, locales: config.locales };
}

async function requireContentType(
  ctx: AppContext,
  scope: Scope,
  apiId: string,
): Promise<ContentType> {
  const ct = await ctx.store.contentTypes.get(scope, apiId);
  if (!ct) throw new NotFoundError('ContentType', apiId);
  return ct;
}

export interface CreateEntryInput {
  readonly contentTypeApiId: string;
  readonly fields: EntryFields;
  /**
   * Keep this id instead of minting one: an environment import copies entries with their ids,
   * so every link between them still resolves in the target. Not accepted over the API.
   */
  readonly id?: string;
}

export interface EntryView {
  readonly entry: Entry;
  readonly fields: EntryFields;
}

/** Creates a draft entry after validating its fields against the content type. */
export async function createEntry(
  ctx: AppContext,
  scope: Scope,
  input: CreateEntryInput,
): Promise<EntryView> {
  const contentType = await requireContentType(ctx, scope, input.contentTypeApiId);
  const vctx = await loadValidationContext(ctx, scope);
  // Defaults fill gaps, then slugs are normalized, and only then is the result
  // validated — so an editor is judged on what will actually be stored.
  const withDefaults = applyDefaults(contentType, input.fields, vctx.locales, vctx.defaultLocale);
  // Hook before normalization and validation, so a hook that writes
  // `slug: "Hello World"` still gets normalized, and nothing a hook produces
  // escapes validation.
  const hooked = await runHook(ctx, 'entry:beforeSave', scope, {
    contentTypeApiId: input.contentTypeApiId,
    fields: withDefaults,
  });
  // Blocks get their `_key` last, so a block a hook added is keyed too.
  const fields = assignBlockKeys(contentType, normalizeSlugFields(contentType, hooked.fields), () =>
    ctx.ids.newId(),
  );
  assertEntryFieldsValid(contentType, fields, vctx);

  const id = input.id ?? ctx.ids.newId();
  const entry: Entry = {
    id,
    contentTypeApiId: input.contentTypeApiId,
    status: 'draft',
    currentVersion: 1,
    publishedVersion: null,
  };
  const version: EntryVersion = {
    entryId: id,
    version: 1,
    fields,
    createdAt: ctx.clock.now().toISOString(),
  };

  const claims = uniqueClaims(contentType, fields);
  if (claims.length === 0) {
    await ctx.store.entries.create(scope, entry, version);
    return { entry, fields };
  }
  // Claim and write together: the claim is the constraint, so a crash between
  // the two must not leave a value reserved by an entry that does not exist.
  await ctx.store.withTransaction(async (tx) => {
    await assertClaimsFree(tx, scope, claims);
    await tx.entries.create(scope, entry, version);
    await tx.entries.replaceUniqueClaims(scope, id, claims);
  });
  return { entry, fields };
}

/**
 * Fails with a message naming the field and the entry holding the value.
 *
 * The database constraint is what actually guarantees uniqueness; this exists
 * so the common case produces "slug 'about' is already used by entry X" rather
 * than a bare constraint violation.
 */
async function assertClaimsFree(
  tx: ContentStoreTx,
  scope: Scope,
  claims: readonly UniqueClaim[],
  excludeEntryId?: string,
): Promise<void> {
  const conflicts = await tx.entries.findUniqueConflicts(scope, claims, excludeEntryId);
  if (conflicts.length === 0) return;
  throw new ConflictError(
    conflicts
      .map((c) => `${c.fieldApiId} "${c.value}" is already used by entry ${c.entryId}`)
      .join('; '),
    { conflicts },
  );
}

export async function getEntry(ctx: AppContext, scope: Scope, id: string): Promise<EntryView> {
  const found = await ctx.store.entries.get(scope, id);
  if (!found) throw new NotFoundError('Entry', id);
  return { entry: found.entry, fields: found.fields };
}

/** Saves an edited set of field values as a new draft version. */
export async function updateEntry(
  ctx: AppContext,
  scope: Scope,
  id: string,
  fields: EntryFields,
): Promise<EntryView> {
  const found = await ctx.store.entries.get(scope, id);
  if (!found) throw new NotFoundError('Entry', id);
  const contentType = await requireContentType(ctx, scope, found.entry.contentTypeApiId);
  const vctx = await loadValidationContext(ctx, scope);
  // No defaults on update. The fields passed become the whole new version: an
  // omitted field is absent from it (nothing is merged from the previous
  // version), and a cleared one is empty. Re-applying a default would override both.
  const hooked = await runHook(ctx, 'entry:beforeSave', scope, {
    contentTypeApiId: found.entry.contentTypeApiId,
    entryId: id,
    fields,
  });
  const normalized = assignBlockKeys(
    contentType,
    normalizeSlugFields(contentType, hooked.fields),
    () => ctx.ids.newId(),
  );
  assertEntryFieldsValid(contentType, normalized, vctx);

  const { entry, version } = saveDraft(found.entry, normalized);
  // Keep status consistent with the published pointer.
  const synced: Entry = {
    ...entry,
    status: deriveStatus(entry.currentVersion, entry.publishedVersion, false),
  };
  const stamped: EntryVersion = { ...version, createdAt: ctx.clock.now().toISOString() };

  const claims = uniqueClaims(contentType, normalized);
  if (claims.length === 0 && !hasUniqueFields(contentType)) {
    await ctx.store.entries.saveVersion(scope, synced, stamped);
    return { entry: synced, fields: normalized };
  }
  await ctx.store.withTransaction(async (tx) => {
    await assertClaimsFree(tx, scope, claims, id);
    await tx.entries.saveVersion(scope, synced, stamped);
    // Replace rather than add: clearing a unique field has to free its value.
    await tx.entries.replaceUniqueClaims(scope, id, claims);
  });
  return { entry: synced, fields: normalized };
}

// ---------------------------------------------------------------------------
// Trash lifecycle: trash → restore, or trash → purge
// ---------------------------------------------------------------------------

/**
 * Moves an entry to the trash, unpublishing it first when it is live.
 *
 * The domain refuses to archive a published entry, which is the right
 * invariant but the wrong seam for a person clicking "delete": trashing
 * something live is one intention. Doing both in one transaction keeps the
 * invariant and still emits `entry.unpublished`, so the worker clears the
 * delivery cache and the entry's embeddings exactly as it would for a manual
 * unpublish. Trashing an already-trashed entry is a no-op, so a retried
 * request cannot fail.
 */
export async function trashEntry(ctx: AppContext, scope: Scope, id: string): Promise<Entry> {
  return ctx.store.withTransaction(async (tx) => {
    const found = await tx.entries.get(scope, id);
    if (!found) throw new NotFoundError('Entry', id);
    if (found.entry.status === 'archived') return found.entry;
    await runHook(ctx, 'entry:beforeTrash', scope, {
      entryId: id,
      contentTypeApiId: found.entry.contentTypeApiId,
    });

    const base =
      found.entry.publishedVersion !== null
        ? await unpublishEntryTx(ctx, tx, scope, id)
        : found.entry;
    const archived = archive(base);
    await tx.entries.saveAggregate(scope, archived);
    // A trashed entry gives its slug back: an editor who deleted "about"
    // expects to be able to create a new "about", not to be blocked by
    // something they can no longer see.
    await tx.entries.releaseUniqueClaims(scope, id);
    return archived;
  });
}

/** Brings a trashed entry back as a draft. Publishing it again is a separate act. */
export async function restoreEntry(ctx: AppContext, scope: Scope, id: string): Promise<Entry> {
  const found = await ctx.store.entries.get(scope, id);
  if (!found) throw new NotFoundError('Entry', id);
  const restored = restore(found.entry);
  const contentType = await ctx.store.contentTypes.get(scope, found.entry.contentTypeApiId);
  const claims = contentType ? uniqueClaims(contentType, found.fields) : [];

  if (claims.length === 0) {
    await ctx.store.entries.saveAggregate(scope, restored);
    return restored;
  }
  // Trashing released this entry's values, so someone may have taken one since.
  // Refusing with a message naming the holder is the honest outcome — silently
  // restoring a duplicate slug would break routing on the front end.
  await ctx.store.withTransaction(async (tx) => {
    await assertClaimsFree(tx, scope, claims, id);
    await tx.entries.saveAggregate(scope, restored);
    await tx.entries.replaceUniqueClaims(scope, id, claims);
  });
  return restored;
}

export interface PurgeEntryOptions {
  /**
   * Delete even though other entries still link to this one, leaving those
   * links dangling. Off by default: the caller has to say they mean it.
   */
  readonly force?: boolean;
  /** Where its archived version bodies live (version-archive.ts), removed with it. */
  readonly blob?: BlobStore;
}

/**
 * Permanently deletes a trashed entry, its versions, its reference edges and
 * its taxonomy metadata. Irreversible.
 *
 * Only reachable from the trash, so "delete" is always two deliberate steps.
 * The entry is unpublished by definition at this point, so delivery and the
 * embeddings index were already cleaned when it was trashed — there is nothing
 * further to invalidate.
 */
export async function purgeEntry(
  ctx: AppContext,
  scope: Scope,
  id: string,
  options: PurgeEntryOptions = {},
): Promise<void> {
  await ctx.store.withTransaction(async (tx) => {
    const found = await tx.entries.get(scope, id);
    if (!found) throw new NotFoundError('Entry', id);
    if (found.entry.status !== 'archived') {
      throw new InvalidStateError('Move the entry to the trash before deleting it permanently');
    }
    await runHook(ctx, 'entry:beforePurge', scope, {
      entryId: id,
      contentTypeApiId: found.entry.contentTypeApiId,
    });

    // Reference edges are recorded at publish time, so this sees links from
    // PUBLISHED entries only — which is the set that matters: those are the
    // links delivery resolves per request, and purging under them turns into
    // broken references on live pages. A draft that links here is not serving
    // anything to anyone yet.
    if (!options.force) {
      const inbound = await tx.references.findReverse(scope, id);
      if (inbound.length > 0) {
        throw new ConflictError(
          `${inbound.length} published ${inbound.length === 1 ? 'entry links' : 'entries link'} to this one`,
          { referencedBy: inbound.map((e) => e.fromEntryId) },
        );
      }
    }

    await tx.references.removeForEntry(scope, id);
    await tx.taxonomy.setEntryMetadata(scope, id, EMPTY_METADATA);
    await tx.entries.releaseUniqueClaims(scope, id);
    await tx.entries.delete(scope, id);
  });

  // Comments and tasks live outside the transactional repo set, so they are
  // cleaned best-effort afterwards: an orphaned note is untidy, but failing the
  // delete after the entry is already gone would be worse.
  await Promise.all([
    ...(await ctx.store.comments.listForEntry(scope, id)).map((c) =>
      ctx.store.comments.delete(scope, c.id).catch(() => {}),
    ),
    ...(await ctx.store.tasks.listForEntry(scope, id)).map((t) =>
      ctx.store.tasks.delete(scope, t.id).catch(() => {}),
    ),
  ]);
  // Its archived version bodies, likewise best-effort: their rows are gone, so nothing reads them.
  await options.blob?.deletePrefix?.(versionBodyPrefix(scope, id), () => false).catch(() => {});
}

/**
 * Copies an entry into a new draft, including its taxonomy metadata.
 *
 * The display field gets a " (copy)" suffix so the two are tellable apart in a
 * list — truncated when the field declares a max size, since a duplicate that
 * fails validation because of the marker we added would be our bug, not the
 * user's.
 */
export async function duplicateEntry(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<EntryView> {
  const found = await ctx.store.entries.get(scope, id);
  if (!found) throw new NotFoundError('Entry', id);
  const contentType = await requireContentType(ctx, scope, found.entry.contentTypeApiId);

  const marked = markAsCopy(contentType, found.fields);
  // Every unique field would collide with the original, so give the copy free
  // values before trying to write it. Done here rather than by retrying on
  // conflict so the entry is created once, with a predictable slug.
  const fields = await freeUniqueValues(ctx, scope, contentType, marked);
  const created = await createEntry(ctx, scope, {
    contentTypeApiId: found.entry.contentTypeApiId,
    fields,
  });

  const metadata = await ctx.store.taxonomy.getEntryMetadata(scope, id);
  if (metadata && (metadata.tags.length > 0 || metadata.concepts.length > 0)) {
    await ctx.store.taxonomy.setEntryMetadata(scope, created.entry.id, metadata);
  }
  return created;
}

/**
 * Rewrites unique field values until they are free: `about` → `about-2` → …
 *
 * Slug fields get the numeric suffix pattern; other unique scalars get the same
 * treatment on their string form, which is crude but predictable, and far
 * better than refusing to duplicate at all.
 */
async function freeUniqueValues(
  ctx: AppContext,
  scope: Scope,
  contentType: ContentType,
  fields: EntryFields,
): Promise<EntryFields> {
  if (!hasUniqueFields(contentType)) return fields;
  const out: EntryFields = { ...fields };

  for (const field of contentType.fields) {
    if (!field.unique) continue;
    const values = out[field.apiId];
    if (!values) continue;
    const next: Record<string, unknown> = { ...values };

    for (const [locale, value] of Object.entries(values)) {
      if (typeof value !== 'string' || value === '') continue;
      let candidate = value;
      // Bounded: a space with 50 copies of one slug is pathological, and
      // looping forever would be worse than a clear conflict error.
      for (let attempt = 2; attempt < 50; attempt++) {
        const conflicts = await ctx.store.entries.findUniqueConflicts(scope, [
          {
            contentTypeApiId: contentType.apiId,
            fieldApiId: field.apiId,
            locale,
            value: candidate,
          },
        ]);
        if (conflicts.length === 0) break;
        candidate = nextSlugCandidate(value, attempt);
      }
      next[locale] = candidate;
    }
    out[field.apiId] = next;
  }
  return out;
}

const COPY_SUFFIX = ' (copy)';

/** Appends the copy marker to every locale of the content type's display field. */
function markAsCopy(contentType: ContentType, fields: EntryFields): EntryFields {
  const display = contentType.fields.find((f) => f.apiId === contentType.displayField);
  const values = contentType.displayField ? fields[contentType.displayField] : undefined;
  if (!display || !values) return fields;

  const max = display.validations?.size?.max;
  const marked = Object.fromEntries(
    Object.entries(values).map(([locale, value]) => {
      if (typeof value !== 'string') return [locale, value];
      const next = value + COPY_SUFFIX;
      if (max === undefined || next.length <= max) return [locale, next];
      // Keep the marker and trim the title, not the other way round.
      return [locale, value.slice(0, Math.max(0, max - COPY_SUFFIX.length)) + COPY_SUFFIX];
    }),
  );
  return { ...fields, [contentType.displayField]: marked };
}
