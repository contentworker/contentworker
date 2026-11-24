import {
  assertQueryRespectsFieldRules,
  assertWritableFields,
  authorize,
  authorizeContent,
  blockVariants,
  ConflictError,
  type ContentType,
  DomainError,
  type EntryFields,
  type FieldDefinition,
  type ImportScriptOutput,
  InvalidStateError,
  importScriptAssetUrls,
  importScriptOutputIssues,
  importScriptValueIssues,
  isRedirectPattern,
  isRichTextDocument,
  MAX_REDIRECT_IMPORT,
  MIGRATION_SOURCE_URL_FIELD,
  type MigrationPage,
  type MigrationPageStage,
  type MigrationRun,
  type MigrationTemplate,
  NotFoundError,
  normalizePageUrl,
  normalizeRedirectDestination,
  normalizeRedirectSource,
  type Principal,
  parseHttpUrl,
  type RedirectChain,
  type RedirectInput,
  type Release,
  type RichTextNode,
  resolveImportScriptOutput,
  SCOPES,
  type Scope,
  unwritableFields,
  urlPath,
  ValidationError,
} from '@contentworker/domain';
import {
  type AssetIngestQueue,
  type BlobStore,
  type EntryWithFields,
  type MigrationPageMove,
  type RemoteFetcher,
  type SourceRecord,
  TransactionConflictError,
} from '@contentworker/ports';
import { createAssetFromUrl } from './asset-from-url';
import { auditActor } from './audit';
import { BULK_LIMIT, bulkEntryAction } from './bulk';
import type { AppContext } from './context';
import { updateEntry } from './entries';
import { executeImport, recordsImportSource } from './import';
import { importRedirects } from './redirects';
import { sha256Hex } from './token-crypto';

/**
 * Site migration, the last steps: load a template's scored pages as entries, point the links
 * between them at each other, redirect the old URLs to the new ones, and publish.
 *
 * Every write goes through the path a person's would. A load is an import: the pages' outputs
 * become records for the import planner (`executeImport`), matched on the content type's
 * `sourceUrl` field ({@link MIGRATION_SOURCE_URL_FIELD}) with `conflicts: 'update'`, so loading a
 * page again updates the entry it became rather than adding a second; the field must be `unique`,
 * so two loads racing on one page can't both create. Assets come through `createAssetFromUrl`,
 * redirects through `importRedirects` and publishing through `bulkEntryAction` or a release.
 *
 * Each step is safe to run again (a redelivered Workflow step). Pages move at a compare-and-set
 * on their `updatedAt` (`movePages`): a step that finds a page written since it read it (another
 * step moved or rescored it) runs its batch again from a fresh read, which the identity match and
 * the steps' own checks make a no-op for what already happened.
 *
 * Each use-case acts as `principal` and authorizes it here. Callers pass a context acting as that
 * same principal (`actingAs(ctx, principal)`), so the entries, versions and assets written are
 * stamped with who asked.
 */

/** Pages one load reads at most: one Workflow step's worth. */
export const MIGRATION_LOAD_BATCH_MAX = 50;
const MIGRATION_LOAD_BATCH_DEFAULT = 25;
/** Pages one relink reads at most. */
export const MIGRATION_RELINK_BATCH_MAX = 100;
const MIGRATION_RELINK_BATCH_DEFAULT = 50;
const MIGRATION_PUBLISH_BATCH_DEFAULT = 200;
/** A batch that loses its pages' compare-and-set is run again this many times in all. */
const MOVE_ATTEMPTS = 3;
/** Pages read per store call by the steps that walk a whole run (redirects, a release). */
const PAGE_READ_BATCH = 500;
/** Entries read per store call. */
const ENTRY_READ_BATCH = 100;
const MAX_ERROR_LENGTH = 500;

export interface MigrationLoadDeps {
  readonly blob: BlobStore;
  readonly fetcher: RemoteFetcher;
  readonly ingest?: AssetIngestQueue;
}

/** A page a step couldn't take through, and why: the page keeps the reason as its `error`. */
export interface MigrationPageFailure {
  readonly pageId: string;
  readonly url: string;
  readonly error: string;
}

/** An asset a page names that couldn't be brought in; the page loads without it. */
export interface MigrationAssetFailure {
  readonly pageId: string;
  readonly url: string;
  readonly error: string;
}

export interface LoadTemplatePagesInput {
  readonly runId: string;
  readonly templateId: string;
  /** Pages this call loads, at most {@link MIGRATION_LOAD_BATCH_MAX}. */
  readonly batchSize?: number;
  /** Load `needs-fix` pages too (scored below the threshold), after the `validated` ones. */
  readonly includeNeedsFix?: boolean;
}

export interface LoadTemplatePagesResult {
  readonly loaded: number;
  /** Pages refused (an unreadable output, a value the content type refuses): now `needs-fix`. */
  readonly failed: readonly MigrationPageFailure[];
  readonly assetFailures: readonly MigrationAssetFailure[];
  /** Links in this batch's entries to pages with no entry yet: the relink pass's work. */
  readonly unresolvedLinks: number;
  /**
   * Pages that lost a race on every attempt (another load created their entry as this one
   * planned it, a unit of work that lost its compare-and-set): left as they were for the next call.
   */
  readonly deferred: readonly MigrationPageFailure[];
  /** Whether pages are still waiting to be loaded: a Workflow loops while it is true. */
  readonly more: boolean;
}

/**
 * Loads the next batch of an approved template's pages: `validated` ones (and `needs-fix` ones
 * when asked) whose last step didn't fail. For each page it reads the output artifact, brings in
 * the assets the output names (relative URLs against the page's, each file once per run), resolves
 * the output's `$html` and `$asset` values against them and against the entries the run's pages
 * already are, and hands the records to the import planner as `principal`, with its authority.
 * A loaded page holds its entry and the count of links left as hyperlinks for the relink pass.
 *
 * A page the planner or the output refuses moves to `needs-fix` with the reason, so the batch
 * goes on and the next call doesn't take it again; fixing its script and transforming it again
 * clears that. An asset that can't be downloaded fails only itself: the page loads without it
 * (its images stay links to where they were), and the result names it. A page whose write lost a
 * race (its `sourceUrl` claimed by a load running at once, a unit that lost its compare-and-set)
 * is not moved: it is loaded again from a fresh read, which finds the other load's entry and
 * updates it.
 *
 * Refused before any file is downloaded unless `principal` may write the type, its `sourceUrl`
 * field, assets, and query by `sourceUrl`. Pass `actingAs(ctx, principal)` as `ctx`.
 */
export async function loadTemplatePages(
  ctx: AppContext,
  deps: MigrationLoadDeps,
  principal: Principal,
  scope: Scope,
  input: LoadTemplatePagesInput,
): Promise<LoadTemplatePagesResult> {
  const run = await requireRun(ctx, scope, input.runId);
  const template = await requireTemplate(ctx, scope, run.id, input.templateId);
  if (template.status !== 'approved') {
    throw new InvalidStateError(
      `A template's pages are loaded once it is approved; this one is ${template.status}`,
    );
  }
  const contentType = await templateContentType(ctx, scope, template);
  // As the planner will, and before any file is downloaded on the caller's behalf: the assets
  // are theirs to create too.
  authorize(principal, SCOPES.contentWrite, scope.spaceId);
  authorize(principal, SCOPES.assetsWrite, scope.spaceId);
  authorizeContent(principal, ['read', 'write'], contentType.apiId);
  // The planner matches on `sourceUrl` and writes it on every record: refused now, not per page.
  assertQueryRespectsFieldRules(principal, {
    contentTypeApiId: contentType.apiId,
    filters: [{ field: MIGRATION_SOURCE_URL_FIELD }],
  });
  assertWritableFields(principal, contentType.apiId, { [MIGRATION_SOURCE_URL_FIELD]: {} });
  const limit = clamp(input.batchSize, MIGRATION_LOAD_BATCH_DEFAULT, MIGRATION_LOAD_BATCH_MAX);
  const stages: readonly MigrationPageStage[] = input.includeNeedsFix
    ? ['validated', 'needs-fix']
    : ['validated'];
  const waiting = async (n: number) => {
    const found: MigrationPage[] = [];
    for (const stage of stages) {
      if (found.length >= n) break;
      found.push(
        ...(await ctx.store.migrations.listPages(scope, run.id, {
          stage,
          templateId: template.id,
          failed: false,
          limit: n - found.length,
        })),
      );
    }
    return found;
  };

  let loaded = 0;
  let unresolvedLinks = 0;
  const failed: MigrationPageFailure[] = [];
  const assetFailures: MigrationAssetFailure[] = [];
  let deferred: MigrationPageFailure[] = [];
  let pages = await waiting(limit);
  for (let attempt = 1; pages.length > 0; attempt++) {
    const batch = await loadBatch(ctx, deps, principal, scope, run, contentType, pages);
    try {
      await ctx.store.withTransaction(async (tx) => {
        await tx.migrations.movePages(scope, run.id, batch.moves);
      });
    } catch (err) {
      // A page was written since it was read. The entries are matched by their source URL, so
      // loading the batch again from a fresh read updates them rather than adding to them.
      if (err instanceof TransactionConflictError && attempt < MOVE_ATTEMPTS) {
        pages = await waiting(limit);
        continue;
      }
      throw err;
    }
    loaded += batch.loaded;
    unresolvedLinks += batch.unresolvedLinks;
    failed.push(...batch.failed);
    assetFailures.push(...batch.assetFailures);
    if (batch.raced.length === 0) break;
    if (attempt >= MOVE_ATTEMPTS) {
      deferred = batch.raced.map((r) => ({ pageId: r.page.id, url: r.page.url, error: r.error }));
      break;
    }
    // Only the pages that lost: again from a fresh read, if nothing else has taken them since.
    pages = (
      await Promise.all(
        batch.raced.map((r) => ctx.store.migrations.getPage(scope, run.id, r.page.id)),
      )
    ).filter(
      (p): p is MigrationPage =>
        p !== null && p.templateId === template.id && p.error === null && stages.includes(p.stage),
    );
  }
  return {
    loaded,
    failed,
    assetFailures,
    unresolvedLinks,
    deferred,
    more: (await waiting(1)).length > 0,
  };
}

/**
 * Whether a record's write lost a race rather than being refused: its unit lost a compare-and-set,
 * or a unique claim was taken under it. A claim on another field than `sourceUrl` that the write's
 * own check named is a refusal (another entry holds that slug); the constraint failing at commit
 * names no field, and a fresh read tells the two apart.
 */
function lostRace(err: unknown): boolean {
  if (err instanceof TransactionConflictError) return true;
  if (!(err instanceof ConflictError)) return false;
  const conflicts = (err.details as { conflicts?: readonly { fieldApiId: string }[] } | undefined)
    ?.conflicts;
  return !conflicts || conflicts.some((c) => c.fieldApiId === MIGRATION_SOURCE_URL_FIELD);
}

interface LoadedBatch {
  readonly moves: MigrationPageMove[];
  /** Pages whose write lost a race, not moved. */
  readonly raced: { readonly page: MigrationPage; readonly error: string }[];
  readonly loaded: number;
  readonly failed: MigrationPageFailure[];
  readonly assetFailures: MigrationAssetFailure[];
  readonly unresolvedLinks: number;
}

/** One page's way into the planner: its record, or why it has none. */
type Prepared =
  | { readonly page: MigrationPage; readonly record: SourceRecord; readonly unresolved: number }
  | { readonly page: MigrationPage; readonly error: string };

async function loadBatch(
  ctx: AppContext,
  deps: MigrationLoadDeps,
  principal: Principal,
  scope: Scope,
  run: MigrationRun,
  contentType: ContentType,
  pages: readonly MigrationPage[],
): Promise<LoadedBatch> {
  // Reads first: every page's output, then what the run already holds for their assets and links.
  const outputs = await Promise.all(pages.map((p) => readOutput(deps.blob, p)));
  // Each file once for the batch, with the first alt text a page gives it.
  const assetUrls = new Map<string, { alt: string | undefined; pageIds: string[] }>();
  const linkUrls = new Set<string>();
  outputs.forEach((read, i) => {
    const page = pages[i] as MigrationPage;
    if (!('output' in read)) return;
    for (const raw of importScriptAssetUrls(read.output)) {
      const url = absolute(raw, page.url);
      if (!url) continue;
      const alt = read.output.assets.find((a) => a.url === raw)?.alt;
      const held = assetUrls.get(url);
      if (!held) assetUrls.set(url, { alt, pageIds: [page.id] });
      else {
        held.pageIds.push(page.id);
        held.alt ??= alt;
      }
    }
    // The rich text is read once without resolvers to learn which pages it links to.
    resolveImportScriptOutput(read.output, {
      resolveLink: (href) => {
        const url = internalUrl(href, page.url, run);
        if (url) linkUrls.add(url);
        return undefined;
      },
    });
  });
  const assetIds = new Map(
    (await ctx.store.migrations.assetsByUrl(scope, run.id, [...assetUrls.keys()])).map((a) => [
      a.url,
      a.assetId,
    ]),
  );
  const entryIds = new Map(
    (await ctx.store.migrations.entriesByUrl(scope, run.id, [...linkUrls])).map((e) => [
      e.url,
      e.entryId,
    ]),
  );
  const runPages = new Set(await ctx.store.migrations.knownUrls(scope, run.id, [...linkUrls]));

  // Each file the run hasn't brought in yet, once, recorded as it lands: a batch run again (or a
  // second load) finds it rather than downloading it again.
  const assetFailures: MigrationAssetFailure[] = [];
  for (const [url, { alt, pageIds }] of assetUrls) {
    if (assetIds.has(url)) continue;
    let assetId: string;
    try {
      ({
        asset: { id: assetId },
      } = await createAssetFromUrl(
        ctx,
        deps,
        scope,
        { url, ...(alt ? { alt } : {}) },
        { createdBy: auditActor(principal) },
      ));
    } catch (err) {
      // The file's fault (unreachable, refused, too large): this page goes on without it. A fault
      // of ours (storage, the database) stops the step, to be run again.
      if (!(err instanceof DomainError)) throw err;
      const error = clip(messageOf(err));
      for (const pageId of pageIds) assetFailures.push({ pageId, url, error });
      continue;
    }
    assetIds.set(url, assetId);
    // Recorded as it lands, so a step stopped by a later file finds this one when it runs again.
    await ctx.store.migrations.addAssets(
      scope,
      run.id,
      [{ url, assetId }],
      ctx.clock.now().toISOString(),
    );
  }

  const blocksField = topLevelBlocksFields(contentType);
  const prepared: Prepared[] = pages.map((page, i) => {
    const read = outputs[i] as Awaited<ReturnType<typeof readOutput>>;
    if (!('output' in read)) return { page, error: read.error };
    let unresolved = 0;
    const asset = (src: string) => {
      const url = absolute(src, page.url);
      const id = url ? assetIds.get(url) : undefined;
      return id ? { id } : undefined;
    };
    const resolved = resolveImportScriptOutput(read.output, {
      resolveAsset: asset,
      resolveAssetRef: asset,
      resolveLink: (href) => {
        const url = internalUrl(href, page.url, run);
        if (!url) return undefined;
        const id = entryIds.get(url);
        if (id) return { linkType: 'Entry', id };
        // A page of the run not loaded yet: a hyperlink for now, which the relink pass points at
        // its entry. A link to a page the run doesn't hold stays a hyperlink for good.
        if (runPages.has(url)) unresolved += 1;
        return undefined;
      },
    });
    const values = recordValues(contentType, blocksField, read.output, resolved, page.url);
    return 'error' in values
      ? { page, error: values.error }
      : { page, record: { externalId: page.url, values: values.values }, unresolved };
  });

  const ready = prepared.filter(
    (p): p is Extract<Prepared, { record: SourceRecord }> => 'record' in p,
  );
  const written = new Map<string, string>();
  const refused = new Map<string, string>();
  const racing = new Set<string>();
  if (ready.length > 0) {
    const result = await executeImport(
      ctx,
      principal,
      scope,
      recordsImportSource(ready.map((p) => p.record)),
      {
        payload: '',
        mapping: {
          contentTypeApiId: contentType.apiId,
          // Every field, so a field no page sets is a per-page refusal (a required one) rather
          // than a mapping that stops the whole batch.
          fields: Object.fromEntries(contentType.fields.map((f) => [f.apiId, f.apiId])),
          identityField: MIGRATION_SOURCE_URL_FIELD,
        },
      },
      {
        conflicts: 'update',
        onWritten: (w) => written.set(w.externalId, w.entryId),
        onFailed: (externalId, err) => {
          if (lostRace(err)) racing.add(externalId);
        },
      },
    );
    for (const issue of result.analysis.issues) {
      refused.set(issue.externalId, issue.messages.join('; '));
    }
    for (const f of result.failed) refused.set(f.externalId, f.message);
  }

  const at = ctx.clock.now().toISOString();
  const moves: MigrationPageMove[] = [];
  const raced: LoadedBatch['raced'] = [];
  const failed: MigrationPageFailure[] = [];
  let loaded = 0;
  let unresolvedLinks = 0;
  for (const p of prepared) {
    if (racing.has(p.page.url)) {
      raced.push({ page: p.page, error: clip(refused.get(p.page.url) ?? 'Lost a race') });
      continue;
    }
    const entryId = 'record' in p ? written.get(p.page.url) : undefined;
    if ('record' in p && entryId) {
      loaded += 1;
      unresolvedLinks += p.unresolved;
      moves.push({
        page: {
          ...p.page,
          stage: 'loaded',
          entryId,
          unresolvedLinks: p.unresolved,
          error: null,
          updatedAt: at,
        },
        expected: p.page.updatedAt,
      });
      continue;
    }
    const error = clip(
      'error' in p ? p.error : (refused.get(p.page.url) ?? 'The import did not write this page'),
    );
    failed.push({ pageId: p.page.id, url: p.page.url, error });
    moves.push({
      page: { ...p.page, stage: 'needs-fix', error, updatedAt: at },
      expected: p.page.updatedAt,
    });
  }
  return { moves, raced, loaded, failed, assetFailures, unresolvedLinks };
}

/** A page's output, read and checked against the hash its record holds. */
async function readOutput(
  blob: BlobStore,
  page: MigrationPage,
): Promise<{ output: ImportScriptOutput } | { error: string }> {
  if (!page.output) return { error: 'The page has no import script output' };
  const raw = await blob.get(page.output.key);
  if (raw === null) return { error: 'The page’s output is missing from storage' };
  // The record names the bytes it was scored on; other bytes under the key aren't those.
  if (sha256Hex(raw) !== page.output.sha256) {
    return { error: 'The page’s output in storage is not the one it was scored on' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'The page’s output is not JSON' };
  }
  const issues = importScriptOutputIssues(parsed);
  if (issues.length > 0) return { error: issues.join('; ') };
  return { output: parsed as ImportScriptOutput };
}

/**
 * The record values a resolved output becomes: its fields, its blocks in the type's blocks field
 * (each `{ _type: variant, …fields }`), and the page's URL in `sourceUrl`. Refused when it names
 * a field the type doesn't have (which would otherwise stop the whole batch's mapping) or has
 * blocks the type has no one place for.
 */
function recordValues(
  contentType: ContentType,
  blocksFields: readonly FieldDefinition[],
  raw: ImportScriptOutput,
  output: ImportScriptOutput,
  url: string,
): { values: Record<string, unknown> } | { error: string } {
  // On what the script returned: once resolved, a misplaced marker is a document like any other.
  const misplaced = importScriptValueIssues(raw, contentType);
  if (misplaced.length > 0) return { error: misplaced.join('; ') };
  const defined = new Set(contentType.fields.map((f) => f.apiId));
  const unknown = Object.keys(output.fields).filter((k) => !defined.has(k));
  if (unknown.length > 0) {
    return { error: `Fields not on "${contentType.apiId}": ${unknown.join(', ')}` };
  }
  const values: Record<string, unknown> = { ...output.fields, [MIGRATION_SOURCE_URL_FIELD]: url };
  if (output.blocks.length === 0) return { values };
  const [target, ...others] = blocksFields;
  if (!target || others.length > 0) {
    return {
      error: target
        ? `"${contentType.apiId}" has more than one blocks field, so its blocks have no one place`
        : `"${contentType.apiId}" has no blocks field for the page's blocks`,
    };
  }
  if (Object.hasOwn(output.fields, target.apiId)) {
    return { error: `The output sets "${target.apiId}" in its fields and as blocks` };
  }
  values[target.apiId] = output.blocks.map((b) => ({ _type: b.variant, ...b.fields }));
  return { values };
}

const topLevelBlocksFields = (contentType: ContentType): FieldDefinition[] =>
  contentType.fields.filter((f) => blockVariants(f) !== undefined);

/**
 * The template's content type, refused unless a load can match its entries: it exists, and it has
 * a `sourceUrl` field that is a `Symbol` or `Text`, `unique` (two loads racing on one page then
 * can't both create) and not localized (one source URL per entry).
 */
async function templateContentType(
  ctx: AppContext,
  scope: Scope,
  template: MigrationTemplate,
): Promise<ContentType> {
  if (!template.contentTypeId) {
    throw new InvalidStateError('The template has no content type to load its pages as');
  }
  const contentType = await ctx.store.contentTypes.get(scope, template.contentTypeId);
  if (!contentType) {
    throw new InvalidStateError(
      `The template's content type "${template.contentTypeId}" doesn't exist in this environment`,
    );
  }
  const field = contentType.fields.find((f) => f.apiId === MIGRATION_SOURCE_URL_FIELD);
  if (
    !field ||
    (field.type !== 'Symbol' && field.type !== 'Text') ||
    field.unique !== true ||
    field.localized
  ) {
    throw new InvalidStateError(
      `"${contentType.apiId}" needs a "${MIGRATION_SOURCE_URL_FIELD}" field (Symbol or Text, unique, not localized) to load pages into: it is how a page that is loaded again finds its entry`,
    );
  }
  return contentType;
}

// --- relink -----------------------------------------------------------------

export interface RelinkMigratedPagesInput {
  readonly runId: string;
  /** Pages this call reads, at most {@link MIGRATION_RELINK_BATCH_MAX}. */
  readonly batchSize?: number;
  /** The `next` of the call before: where this one goes on from. */
  readonly after?: string;
}

export interface RelinkMigratedPagesResult {
  readonly checked: number;
  /** Entries whose links changed, each saved once. */
  readonly relinked: number;
  /** Links still waiting for their page's entry (a page not loaded yet). */
  readonly unresolvedLinks: number;
  /** Pages whose entry was edited since it was read: left as they were, for a later pass. */
  readonly skipped: readonly MigrationPageFailure[];
  /** Where the next call goes on from; absent when this one reached the end. */
  readonly next?: string;
}

/**
 * The second pass over a run's links: for each loaded page whose entry still holds hyperlinks to
 * pages of the run, it points those that now have an entry at it (`entry-hyperlink`), and saves
 * the entry only when one changed, at the version it read (an edit made since wins; that page is
 * skipped and keeps its count). A page's count goes down to the links still waiting. A cursor
 * walks the run once (`after` / `next`), so a link to a page that never loads is read once per
 * pass, not forever. Pass `actingAs(ctx, principal)` as `ctx`.
 */
export async function relinkMigratedPages(
  ctx: AppContext,
  principal: Principal,
  scope: Scope,
  input: RelinkMigratedPagesInput,
): Promise<RelinkMigratedPagesResult> {
  authorize(principal, SCOPES.contentWrite, scope.spaceId);
  const run = await requireRun(ctx, scope, input.runId);
  const limit = clamp(input.batchSize, MIGRATION_RELINK_BATCH_DEFAULT, MIGRATION_RELINK_BATCH_MAX);
  for (let attempt = 1; ; attempt++) {
    const pages = await ctx.store.migrations.listPages(scope, run.id, {
      stage: 'loaded',
      unresolvedLinks: true,
      limit,
      ...(input.after ? { after: input.after } : {}),
    });
    const next = pages.length === limit ? pages.at(-1)?.id : undefined;
    const done = (r: Omit<RelinkMigratedPagesResult, 'next'>): RelinkMigratedPagesResult =>
      next ? { ...r, next } : r;
    if (pages.length === 0)
      return done({ checked: 0, relinked: 0, unresolvedLinks: 0, skipped: [] });

    const entries = await getEntries(
      ctx,
      scope,
      pages.flatMap((p) => (p.entryId ? [p.entryId] : [])),
    );
    const types = new Map<string, ContentType>();
    for (const { entry } of entries.values()) {
      if (types.has(entry.contentTypeApiId)) continue;
      authorizeContent(principal, ['read', 'write'], entry.contentTypeApiId);
      const type = await ctx.store.contentTypes.get(scope, entry.contentTypeApiId);
      if (type) types.set(type.apiId, type);
    }
    const linked = new Set<string>();
    for (const page of pages) {
      const found = page.entryId ? entries.get(page.entryId) : undefined;
      if (!found) continue;
      mapHyperlinks(found.fields, (uri) => {
        const url = internalUrl(uri, page.url, run);
        if (url) linked.add(url);
        return undefined;
      });
    }
    const entryIds = new Map(
      (await ctx.store.migrations.entriesByUrl(scope, run.id, [...linked])).map((e) => [
        e.url,
        e.entryId,
      ]),
    );
    const runPages = new Set(await ctx.store.migrations.knownUrls(scope, run.id, [...linked]));

    let relinked = 0;
    let unresolvedLinks = 0;
    const skipped: MigrationPageFailure[] = [];
    const moves: MigrationPageMove[] = [];
    const at = ctx.clock.now().toISOString();
    for (const page of pages) {
      const found = page.entryId ? entries.get(page.entryId) : undefined;
      const type = found ? types.get(found.entry.contentTypeApiId) : undefined;
      if (!found || !type) {
        // The entry is gone (trashed and purged): nothing is left to link.
        moves.push({
          page: { ...page, unresolvedLinks: 0, updatedAt: at },
          expected: page.updatedAt,
        });
        continue;
      }
      let remaining = 0;
      const { fields, changed } = mapHyperlinks(found.fields, (uri) => {
        const url = internalUrl(uri, page.url, run);
        if (!url) return undefined;
        const id = entryIds.get(url);
        if (!id && runPages.has(url)) remaining += 1;
        return id;
      });
      if (changed) {
        try {
          await updateEntry(ctx, scope, found.entry.id, fields, {
            copy: true,
            imported: true,
            expectedVersion: found.entry.currentVersion,
            unwritable: unwritableFields(
              principal,
              type.apiId,
              Object.fromEntries(type.fields.map((f) => [f.apiId, f])),
            ),
          });
          relinked += 1;
        } catch (err) {
          // Edited since it was read, or refused as it now stands: the page keeps its count, and
          // the next pass reads the entry again.
          skipped.push({ pageId: page.id, url: page.url, error: clip(messageOf(err)) });
          unresolvedLinks += page.unresolvedLinks;
          continue;
        }
      }
      unresolvedLinks += remaining;
      if (remaining !== page.unresolvedLinks) {
        moves.push({
          page: { ...page, unresolvedLinks: remaining, updatedAt: at },
          expected: page.updatedAt,
        });
      }
    }
    try {
      await ctx.store.withTransaction(async (tx) => {
        await tx.migrations.movePages(scope, run.id, moves);
      });
    } catch (err) {
      // A page moved meanwhile: read the batch again. Links already pointed at their entries
      // aren't hyperlinks any more, so a second pass saves nothing twice.
      if (err instanceof TransactionConflictError && attempt < MOVE_ATTEMPTS) continue;
      throw err;
    }
    return done({ checked: pages.length, relinked, unresolvedLinks, skipped });
  }
}

/**
 * The entry's fields with the hyperlinks in their rich text (however deep: a block's, a
 * component's, every locale's) passed to `resolve`: an entry id it returns turns the link into an
 * `entry-hyperlink` around the same content. `changed` says whether any did.
 */
function mapHyperlinks(
  fields: EntryFields,
  resolve: (uri: string) => string | undefined,
): { fields: EntryFields; changed: boolean } {
  let changed = false;
  const node = (n: RichTextNode): RichTextNode => {
    const uri = n.nodeType === 'hyperlink' ? n.data?.uri : undefined;
    const id = typeof uri === 'string' ? resolve(uri) : undefined;
    const content = n.content?.map(node);
    if (id) {
      changed = true;
      return {
        nodeType: 'entry-hyperlink',
        data: { target: { id, linkType: 'Entry' } },
        content: content ?? [],
      };
    }
    return content ? { ...n, content } : n;
  };
  const value = (v: unknown): unknown => {
    if (isRichTextDocument(v)) return { ...v, content: v.content.map(node) };
    if (Array.isArray(v)) return v.map(value);
    if (typeof v === 'object' && v !== null) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, value(x)]));
    }
    return v;
  };
  const out: EntryFields = {};
  for (const [apiId, locales] of Object.entries(fields)) {
    out[apiId] = value(locales) as EntryFields[string];
  }
  return { fields: out, changed };
}

// --- redirects --------------------------------------------------------------

export interface ImportMigrationRedirectsInput {
  readonly runId: string;
  /** Only this template's pages; absent, every loaded or published page of the run. */
  readonly templateId?: string;
}

export interface ImportMigrationRedirectsResult {
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly skipped: {
    /** The page's old path is its entry's new one: nothing to redirect. */
    readonly identity: number;
    /** Its content type has no URL pattern, so the entry has no path to redirect to. */
    readonly noUrlPattern: number;
    /** The pattern names a slug the entry doesn't hold, or a path no redirect can hold. */
    readonly unresolved: number;
  };
  readonly chains: readonly RedirectChain[];
}

/**
 * Redirects each loaded (or published) page's old path to where its entry lives now, by its
 * content type's URL pattern (`urlPath`, in the default locale), through the redirects import:
 * an upsert by source, `origin: 'import'`, checked as a whole set (a loop is refused), in
 * imports of at most {@link MAX_REDIRECT_IMPORT}. Run again, every redirect is `unchanged`. A page
 * whose old path is its new one is skipped. Needs `content:manage`, as the redirects import does.
 * Pass `actingAs(ctx, principal)` as `ctx`.
 */
export async function importMigrationRedirects(
  ctx: AppContext,
  principal: Principal,
  scope: Scope,
  input: ImportMigrationRedirectsInput,
): Promise<ImportMigrationRedirectsResult> {
  authorize(principal, SCOPES.contentManage, scope.spaceId);
  const run = await requireRun(ctx, scope, input.runId);
  if (input.templateId) await requireTemplate(ctx, scope, run.id, input.templateId);
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);

  const pages: MigrationPage[] = [];
  for (const stage of ['loaded', 'published'] as const) {
    pages.push(...(await allPages(ctx, scope, run.id, { stage, templateId: input.templateId })));
  }
  const entries = await getEntries(
    ctx,
    scope,
    pages.flatMap((p) => (p.entryId ? [p.entryId] : [])),
  );
  const types = new Map<string, ContentType | null>();
  const skipped = { identity: 0, noUrlPattern: 0, unresolved: 0 };
  const rows: RedirectInput[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    const found = page.entryId ? entries.get(page.entryId) : undefined;
    if (!found) {
      skipped.unresolved += 1;
      continue;
    }
    const apiId = found.entry.contentTypeApiId;
    if (!types.has(apiId)) types.set(apiId, await ctx.store.contentTypes.get(scope, apiId));
    const pattern = types.get(apiId)?.urlPattern;
    if (!pattern) {
      skipped.noUrlPattern += 1;
      continue;
    }
    const to = urlPath(pattern, { id: found.entry.id, fields: found.fields }, config.defaultLocale);
    const redirect = to === null ? null : migrationRedirect(page.path, to);
    if (!redirect) {
      skipped.unresolved += 1;
      continue;
    }
    const { source, destination } = redirect;
    if (source === destination) {
      skipped.identity += 1;
      continue;
    }
    if (seen.has(source)) continue;
    seen.add(source);
    rows.push({ source, destination, status: 301 });
  }

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let chains: readonly RedirectChain[] = [];
  for (let at = 0; at < rows.length; at += MAX_REDIRECT_IMPORT) {
    const report = await importRedirects(ctx, scope, {
      format: 'json',
      data: rows.slice(at, at + MAX_REDIRECT_IMPORT),
    });
    created += report.created;
    updated += report.updated;
    unchanged += report.unchanged;
    // Each report's chains are the whole set's after its import, and a later import only adds
    // redirects (no source repeats across them), so the last report holds every chain.
    chains = report.chains;
  }
  return { created, updated, unchanged, skipped, chains };
}

/**
 * The redirect from a page's old path to its entry's new one, both in the redirect source's
 * spelling (so the same path spelled twice compares equal), or null when either can't be one. An
 * old path that reads as a pattern (`/[draft]`) is refused rather than redirecting every path
 * that shape matches.
 */
function migrationRedirect(
  oldPath: string,
  newPath: string,
): { source: string; destination: string } | null {
  try {
    const source = normalizeRedirectSource(oldPath);
    if (isRedirectPattern(source)) return null;
    normalizeRedirectDestination(newPath, source);
    return { source, destination: normalizeRedirectSource(newPath, 'destination') };
  } catch (err) {
    if (err instanceof ValidationError) return null;
    throw err;
  }
}

// --- publish ----------------------------------------------------------------

export interface PublishMigrationInput {
  readonly runId: string;
  /** Only this template's pages; absent, every loaded page of the run. */
  readonly templateId?: string;
  /**
   * Add the entries to a release rather than publish them now: the release ships them (or is
   * scheduled to). A batch at a time, as publishing goes.
   */
  readonly viaRelease?: boolean;
  /** The open release to add to; absent, the run's own (created by the first batch). */
  readonly releaseId?: string;
  readonly releaseTitle?: string;
  /** Pages this call publishes or adds, at most `BULK_LIMIT`. */
  readonly batchSize?: number;
  /** The `next` of the call before. */
  readonly after?: string;
}

export interface PublishMigrationResult {
  /** Entries published, or found published already, whose pages moved to `published`. */
  readonly published: number;
  /** Entries added to the release. */
  readonly added: number;
  readonly releaseId?: string;
  /** Pages whose entry couldn't be published: they stay `loaded`, with the reason. */
  readonly failed: readonly MigrationPageFailure[];
  /** Where the next call goes on from; absent when this one reached the end. */
  readonly next?: string;
}

/**
 * Publishes a run's loaded entries, as `principal`, who needs `content:publish` and `publish` on
 * each entry's type, as a bulk publish does. Publishing goes a batch at a time (`bulkEntryAction`,
 * which keeps one entry's failure from the rest); a page whose entry is published moves to
 * `published`, and one whose entry is already published at its current version (a release that
 * shipped, a step run again) moves without a second publish. A failure stays `loaded` with the
 * reason, and a pass from the start tries it again.
 *
 * With `viaRelease`, the batch's loaded entries are added to one release and nothing is
 * published: the pages stay `loaded` until the release ships and a publish pass finds their
 * entries live. The release is `releaseId`, or the run's own (recorded on the run, and reused by
 * every later batch and an add run again while it is open). That needs `content:write` too, as
 * making a release and adding to it do. Both go on from `after` and report `next`. A release
 * named without `viaRelease` is refused ({@link assertReleaseTarget}). Pass
 * `actingAs(ctx, principal)` as `ctx`.
 */
export async function publishMigration(
  ctx: AppContext,
  principal: Principal,
  scope: Scope,
  input: PublishMigrationInput,
): Promise<PublishMigrationResult> {
  authorize(principal, SCOPES.contentPublish, scope.spaceId);
  assertReleaseTarget(input);
  const run = await requireRun(ctx, scope, input.runId);
  if (input.templateId) await requireTemplate(ctx, scope, run.id, input.templateId);
  return input.viaRelease
    ? publishViaRelease(ctx, principal, scope, run, input)
    : publishBatch(ctx, principal, scope, run, input);
}

async function publishBatch(
  ctx: AppContext,
  principal: Principal,
  scope: Scope,
  run: MigrationRun,
  input: PublishMigrationInput,
): Promise<PublishMigrationResult> {
  const limit = clamp(input.batchSize, MIGRATION_PUBLISH_BATCH_DEFAULT, BULK_LIMIT);
  for (let attempt = 1; ; attempt++) {
    const pages = await ctx.store.migrations.listPages(scope, run.id, {
      stage: 'loaded',
      limit,
      ...(input.templateId ? { templateId: input.templateId } : {}),
      ...(input.after ? { after: input.after } : {}),
    });
    const next = pages.length === limit ? pages.at(-1)?.id : undefined;
    const entries = await getEntries(
      ctx,
      scope,
      pages.flatMap((p) => (p.entryId ? [p.entryId] : [])),
    );
    for (const type of new Set([...entries.values()].map((e) => e.entry.contentTypeApiId))) {
      authorizeContent(principal, 'publish', type);
    }
    const live = (id: string | null) => {
      const e = id ? entries.get(id)?.entry : undefined;
      return e !== undefined && e.publishedVersion === e.currentVersion;
    };
    const toPublish = pages.flatMap((p) => (p.entryId && !live(p.entryId) ? [p.entryId] : []));
    const errors = new Map<string, string>();
    if (toPublish.length > 0) {
      const summary = await bulkEntryAction(ctx, scope, 'publish', toPublish);
      for (const r of summary.results) if (!r.ok) errors.set(r.id, r.error ?? 'Not published');
    }
    const at = ctx.clock.now().toISOString();
    const moves: MigrationPageMove[] = [];
    const failed: MigrationPageFailure[] = [];
    let published = 0;
    for (const page of pages) {
      const error = !page.entryId
        ? 'The page has no entry'
        : !entries.has(page.entryId)
          ? 'The page’s entry no longer exists'
          : errors.get(page.entryId);
      if (error) {
        failed.push({ pageId: page.id, url: page.url, error: clip(error) });
        moves.push({
          page: { ...page, error: clip(error), updatedAt: at },
          expected: page.updatedAt,
        });
        continue;
      }
      published += 1;
      moves.push({
        page: { ...page, stage: 'published', error: null, updatedAt: at },
        expected: page.updatedAt,
      });
    }
    try {
      await ctx.store.withTransaction(async (tx) => {
        await tx.migrations.movePages(scope, run.id, moves);
      });
    } catch (err) {
      // A page moved meanwhile: read the batch again. What was published now is found published,
      // so it moves without a second publish.
      if (err instanceof TransactionConflictError && attempt < MOVE_ATTEMPTS) continue;
      throw err;
    }
    return { published, added: 0, failed, ...(next ? { next } : {}) };
  }
}

async function publishViaRelease(
  ctx: AppContext,
  principal: Principal,
  scope: Scope,
  run: MigrationRun,
  input: PublishMigrationInput,
): Promise<PublishMigrationResult> {
  const limit = clamp(input.batchSize, MIGRATION_PUBLISH_BATCH_DEFAULT, BULK_LIMIT);
  const pages = await ctx.store.migrations.listPages(scope, run.id, {
    stage: 'loaded',
    limit,
    ...(input.templateId ? { templateId: input.templateId } : {}),
    ...(input.after ? { after: input.after } : {}),
  });
  const next = pages.length === limit ? pages.at(-1)?.id : undefined;
  const entries = await getEntries(
    ctx,
    scope,
    pages.flatMap((p) => (p.entryId ? [p.entryId] : [])),
  );
  // Authorized as making a release and adding each to it are (`POST …/releases`, `…/items`,
  // `addEntryToRelease`), before the release exists.
  authorize(principal, SCOPES.contentWrite, scope.spaceId);
  for (const type of new Set([...entries.values()].map((e) => e.entry.contentTypeApiId))) {
    authorizeContent(principal, ['read', 'publish'], type);
  }
  let releaseId = input.releaseId;
  if (releaseId) {
    const release = await ctx.store.releases.get(scope, releaseId);
    if (!release) throw new NotFoundError('Release', releaseId);
    if (release.status !== 'open') {
      throw new InvalidStateError(`Cannot modify a ${release.status} release`);
    }
  } else {
    releaseId = await runRelease(ctx, scope, run, input.releaseTitle);
  }
  const ids = [...entries.keys()];
  for (let at = 0; at < ids.length; at += ENTRY_READ_BATCH) {
    const chunk = ids.slice(at, at + ENTRY_READ_BATCH);
    await ctx.store.withTransaction(async (tx) => {
      for (const entityId of chunk) {
        await tx.releases.addItem(scope, releaseId, {
          entityType: 'Entry',
          entityId,
          action: 'publish',
        });
      }
    });
  }
  const failed = pages.flatMap((p) =>
    p.entryId && entries.has(p.entryId)
      ? []
      : [{ pageId: p.id, url: p.url, error: 'The page’s entry no longer exists' }],
  );
  return { published: 0, added: ids.length, releaseId, failed, ...(next ? { next } : {}) };
}

/**
 * A publish names a release (`releaseId`, `releaseTitle`) only when it goes through one: named
 * without `viaRelease`, the entries would be published now and the release quietly ignored.
 */
export function assertReleaseTarget(input: {
  readonly viaRelease?: boolean | undefined;
  readonly releaseId?: string | undefined;
  readonly releaseTitle?: string | undefined;
}): void {
  if (!input.viaRelease && (input.releaseId || input.releaseTitle)) {
    throw new ValidationError([
      { field: 'viaRelease', message: 'a release is named only when publishing through one' },
    ]);
  }
}

/**
 * The run's release: the one it recorded while that is still open, else a new one, created in the
 * same unit as the run records it (at the run's compare-and-set). Two adds at once can't both
 * open one: the loser's unit writes nothing, and it reads the run again and takes the winner's.
 */
async function runRelease(
  ctx: AppContext,
  scope: Scope,
  first: MigrationRun,
  title: string | undefined,
): Promise<string> {
  let run = first;
  for (let attempt = 1; ; attempt++) {
    if (run.releaseId) {
      const held = await ctx.store.releases.get(scope, run.releaseId);
      if (held?.status === 'open') return held.id;
    }
    const at = ctx.clock.now().toISOString();
    const release: Release = {
      id: ctx.ids.newId(),
      title: title ?? `Migration: ${run.name}`,
      status: 'open',
      createdAt: at,
    };
    try {
      await ctx.store.withTransaction(async (tx) => {
        await tx.releases.create(scope, release);
        await tx.migrations.saveRun(
          scope,
          { ...run, releaseId: release.id, version: run.version + 1, updatedAt: at },
          run.version,
        );
      });
      return release.id;
    } catch (err) {
      if (!(err instanceof TransactionConflictError) || attempt >= MOVE_ATTEMPTS) throw err;
      run = await requireRun(ctx, scope, run.id);
    }
  }
}

// --- shared -----------------------------------------------------------------

async function requireRun(ctx: AppContext, scope: Scope, id: string): Promise<MigrationRun> {
  const run = await ctx.store.migrations.getRun(scope, id);
  if (!run) throw new NotFoundError('Migration run', id);
  return run;
}

async function requireTemplate(
  ctx: AppContext,
  scope: Scope,
  runId: string,
  id: string,
): Promise<MigrationTemplate> {
  const template = await ctx.store.migrations.getTemplate(scope, runId, id);
  if (!template) throw new NotFoundError('Migration template', id);
  return template;
}

/** Every page of the run in a stage (and template), read a page of rows at a time. */
async function allPages(
  ctx: AppContext,
  scope: Scope,
  runId: string,
  query: { readonly stage: MigrationPage['stage']; readonly templateId?: string | undefined },
): Promise<MigrationPage[]> {
  const out: MigrationPage[] = [];
  for (let after: string | undefined; ; ) {
    const batch = await ctx.store.migrations.listPages(scope, runId, {
      stage: query.stage,
      limit: PAGE_READ_BATCH,
      ...(query.templateId ? { templateId: query.templateId } : {}),
      ...(after ? { after } : {}),
    });
    out.push(...batch);
    if (batch.length < PAGE_READ_BATCH) return out;
    after = batch.at(-1)?.id;
  }
}

/** Entries by id, read {@link ENTRY_READ_BATCH} at a time; a missing one is absent. */
async function getEntries(
  ctx: AppContext,
  scope: Scope,
  ids: readonly string[],
): Promise<Map<string, EntryWithFields>> {
  const out = new Map<string, EntryWithFields>();
  const distinct = [...new Set(ids)];
  for (let at = 0; at < distinct.length; at += ENTRY_READ_BATCH) {
    for (const e of await ctx.store.entries.getMany(
      scope,
      distinct.slice(at, at + ENTRY_READ_BATCH),
    )) {
      out.set(e.entry.id, e);
    }
  }
  return out;
}

/** `raw` as an absolute http(s) URL, relative to the page it is on. */
const absolute = (raw: string, base: string): string | undefined =>
  parseHttpUrl(raw.trim(), base)?.href;

/** The run's page URL a link names, when it is on the run's origin; else undefined. */
function internalUrl(href: string, base: string, run: MigrationRun): string | undefined {
  const url = normalizePageUrl(href, base);
  if (!url) return undefined;
  return parseHttpUrl(url)?.origin === parseHttpUrl(run.source.url)?.origin ? url : undefined;
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  return Math.max(1, Math.min(value ?? fallback, max));
}

const messageOf = (err: unknown): string => {
  if (err instanceof ValidationError && err.issues.length > 0) {
    return err.issues.map((i) => `${i.field}: ${i.message}`).join('; ');
  }
  return err instanceof Error ? err.message : String(err);
};

const clip = (text: string): string => text.slice(0, MAX_ERROR_LENGTH);
