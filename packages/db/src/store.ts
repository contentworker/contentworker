import {
  type AgentReview,
  type AgentSchedule,
  type ApiKey,
  type Asset,
  type Comment,
  type Concept,
  ConflictError,
  type ContentType,
  type DomainEvent,
  type Entry,
  type EntryFields,
  type EntryMetadata,
  type EntryVersion,
  type InstalledPlugin,
  matchesTopic,
  type OAuthClient,
  projectFields,
  QueryTooBroadError,
  type ReferenceEdge,
  type Release,
  type Role,
  runEntryQuery,
  type ScheduledAction,
  type Scope,
  type SpaceMember,
  type Task,
  type UniqueClaim,
  type Webhook,
  type WorkflowDefinition,
  type WorkflowGraphDefinition,
  type WorkflowNodeRunRecord,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowStep,
  type WorkflowTask,
  type WorkflowTaskStatus,
  type WorkflowTimelineRecord,
  type WorkflowVersion,
} from '@contentworker/domain';
import type {
  AgentReviewRepo,
  AgentRunRecord,
  AgentRunRepo,
  AgentScheduleRepo,
  AIActionDefinition,
  AIActionRepo,
  AppExtension,
  AppExtensionRepo,
  AssetRepo,
  AuditRepo,
  AuthRepo,
  BulkJob,
  BulkJobChunk,
  BulkJobRepo,
  CommentRepo,
  ContentStore,
  ContentStoreTx,
  ContentTypeRepo,
  DeploymentSettingsRepo,
  EntryQuery,
  EntryRepo,
  EntryWithFields,
  FunctionDefinition,
  FunctionRepo,
  MemberRepo,
  OAuthClientRepo,
  OAuthGrantRecord,
  OAuthGrantRepo,
  OutboxRepo,
  PluginRepo,
  PreviewTokenRepo,
  PublishedAsset,
  PublishedEntry,
  ReferenceRepo,
  ReleaseRepo,
  RoleRepo,
  ScheduledActionRepo,
  ScopedAgentSchedule,
  ScopedScheduledAction,
  SpaceConfig,
  SpaceRepo,
  StoredSecretRepo,
  TaskRepo,
  TaxonomyRepo,
  WebhookRepo,
  WorkflowGraphRecord,
  WorkflowGraphRepo,
  WorkflowRepo,
  WorkflowRunRepo,
  WorkflowTaskRepo,
} from '@contentworker/ports';
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  type SQL,
  sql,
  sum,
} from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { alias, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import {
  chunked,
  createDb,
  type D1Like,
  type Db,
  directExec,
  type Exec,
  isUniqueViolation,
  mapD1Error,
  selectChunked,
  UnitOfWork,
} from './exec';
import { buildFilterPrefilter, buildSearchPrefilter } from './query-pushdown';
import * as schema from './schema';

type Query = BatchItem<'sqlite'>;

/** The row's environment is registered (not deleted, nor being purged). */
const registered = (t: { spaceId: unknown; environmentId: unknown }) =>
  sql`EXISTS (SELECT 1 FROM ${schema.environments} WHERE ${schema.environments.spaceId} = ${t.spaceId} AND ${schema.environments.id} = ${t.environmentId})`;

const scopeFilter = (t: { spaceId: unknown; environmentId: unknown }, scope: Scope) =>
  and(eq(t.spaceId as never, scope.spaceId), eq(t.environmentId as never, scope.environmentId));

/**
 * Runs several write statements as one atomic step: inside a unit of work they join its batch;
 * outside one they go out as a single `db.batch()` (one round trip, all-or-nothing), never
 * separate auto-committed statements.
 */
async function writeAll(x: Exec, queries: readonly Query[]): Promise<void> {
  if (queries.length === 0) return;
  if (x.inUnit || queries.length === 1) {
    for (const q of queries) await x.write(q);
    return;
  }
  try {
    await x.db.batch(queries as unknown as [Query, ...Query[]]);
  } catch (err) {
    throw mapD1Error(err);
  }
}

/**
 * A write whose result drives control flow (a `.returning()` compare-and-set) has no answer
 * until a unit of work commits. The methods the application calls inside `withTransaction`
 * have an in-unit branch; every other one refuses loudly instead of misreporting.
 */
function directOnly(x: Exec, method: string): void {
  if (x.inUnit) {
    throw new Error(
      `${method} reads its own write's result, so it cannot run inside withTransaction on D1; ` +
        'call it on the store directly',
    );
  }
}

/**
 * Multi-row INSERT split so no statement binds more than D1's 100 parameters. Drizzle emits
 * every column for every row, so the table's column count is the per-row cost.
 */
function insertChunks<T>(
  table: SQLiteTable,
  rows: readonly T[],
  build: (chunk: T[]) => Query,
): Query[] {
  const perRow = Object.keys(getTableColumns(table)).length;
  return chunked(rows, perRow, 0)
    .filter((c) => c.length > 0)
    .map(build);
}

/** Params a statement keeps for its own conditions on top of a chunked id list. */
const RESERVED = 6;

// Field-level filtering/ordering/search/projection runs in JS over the loaded
// rows (shared with the in-memory store for identical semantics), so `limit`/
// `offset` cannot be pushed into SQL for those queries. They are not unbounded
// though: superset prefilters (query-pushdown.ts) narrow the candidate rows in
// SQL and the scan is capped, so only plausible matches are materialized. The
// common `contentType + since + limit/skip` path is answered entirely in SQL.
/** Default ceiling on candidate rows loaded for exact query evaluation. */
export const DEFAULT_QUERY_SCAN_LIMIT = 5000;

const isAdvancedQuery = (q: EntryQuery) =>
  Boolean(q.filters?.length || q.order?.length || q.search || q.select);

function makeContentTypeRepo(x: Exec): ContentTypeRepo {
  const db = x.db;
  return {
    async get(scope, apiId) {
      const [row] = await db
        .select()
        .from(schema.contentTypes)
        .where(and(scopeFilter(schema.contentTypes, scope), eq(schema.contentTypes.apiId, apiId)));
      return row ? toContentType(row) : null;
    },
    async list(scope) {
      const rows = await db
        .select()
        .from(schema.contentTypes)
        .where(scopeFilter(schema.contentTypes, scope));
      return rows.map(toContentType);
    },
    async save(scope, ct) {
      const values = {
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        apiId: ct.apiId,
        name: ct.name,
        displayField: ct.displayField,
        fields: [...ct.fields],
        version: ct.version,
        status: ct.status,
        updatedAt: new Date(),
      };
      await x.write(
        db
          .insert(schema.contentTypes)
          .values(values)
          .onConflictDoUpdate({
            target: [
              schema.contentTypes.spaceId,
              schema.contentTypes.environmentId,
              schema.contentTypes.apiId,
            ],
            set: {
              name: values.name,
              displayField: values.displayField,
              fields: values.fields,
              version: values.version,
              status: values.status,
              updatedAt: values.updatedAt,
            },
          }),
      );
    },
  };
}

function makeEntryRepo(x: Exec, scanLimit = DEFAULT_QUERY_SCAN_LIMIT): EntryRepo {
  const db = x.db;
  // The row's CURRENT version, joined in the same query (one join is cheaper on D1 than a
  // second, pair-chunked query and has no parameter-cap concern).
  const cv = alias(schema.entryVersions, 'cv');
  const currentVersionJoin = and(
    eq(cv.spaceId, schema.entries.spaceId),
    eq(cv.environmentId, schema.entries.environmentId),
    eq(cv.entryId, schema.entries.id),
    eq(cv.version, schema.entries.currentVersion),
  );
  const withFields = () =>
    db
      .select({ entry: schema.entries, fields: cv.fields })
      .from(schema.entries)
      .leftJoin(cv, currentVersionJoin);
  const toEntryWithFields = (r: {
    entry: EntryRow;
    fields: EntryFields | null;
  }): EntryWithFields => ({
    entry: toEntry(r.entry),
    fields: r.fields ?? {},
  });

  const putPublishedMany = async (
    scope: Scope,
    snapshots: readonly PublishedEntry[],
  ): Promise<void> => {
    if (snapshots.length === 0) return;
    await writeAll(
      x,
      insertChunks(schema.entryPublished, snapshots, (chunk) =>
        db
          .insert(schema.entryPublished)
          .values(chunk.map((s) => publishedRow(scope, s)))
          .onConflictDoUpdate({
            target: [
              schema.entryPublished.spaceId,
              schema.entryPublished.environmentId,
              schema.entryPublished.entryId,
            ],
            set: {
              contentTypeApiId: sql`excluded.content_type_api_id`,
              version: sql`excluded.version`,
              fields: sql`excluded.fields`,
              metadata: sql`excluded.metadata`,
              publishedAt: sql`excluded.published_at`,
            },
          }),
      ),
    );
  };
  const removePublishedMany = async (scope: Scope, entryIds: readonly string[]): Promise<void> => {
    if (entryIds.length === 0) return;
    await writeAll(
      x,
      chunked(entryIds, 1, RESERVED).map((chunk) =>
        db
          .delete(schema.entryPublished)
          .where(
            and(
              scopeFilter(schema.entryPublished, scope),
              inArray(schema.entryPublished.entryId, chunk),
            ),
          ),
      ),
    );
  };
  const uniqueRows = (scope: Scope, entryId: string, claims: readonly UniqueClaim[]) =>
    claims.map((c) => ({
      spaceId: scope.spaceId,
      environmentId: scope.environmentId,
      contentTypeApiId: c.contentTypeApiId,
      fieldApiId: c.fieldApiId,
      locale: c.locale,
      value: c.value,
      entryId,
    }));
  const deleteClaims = (scope: Scope, entryId: string) =>
    db
      .delete(schema.entryUniqueValues)
      .where(
        and(
          scopeFilter(schema.entryUniqueValues, scope),
          eq(schema.entryUniqueValues.entryId, entryId),
        ),
      );
  return {
    async get(scope, id) {
      const [row] = await withFields().where(
        and(scopeFilter(schema.entries, scope), eq(schema.entries.id, id)),
      );
      return row ? toEntryWithFields(row) : null;
    },
    async getMany(scope, ids) {
      const rows = await selectChunked(
        ids,
        (chunk) =>
          withFields().where(
            and(scopeFilter(schema.entries, scope), inArray(schema.entries.id, chunk)),
          ),
        1,
        RESERVED,
      );
      return rows.map(toEntryWithFields);
    },
    async list(scope, query: EntryQuery) {
      const advanced = isAdvancedQuery(query);
      const conditions = [scopeFilter(schema.entries, scope)];
      if (query.contentTypeApiId) {
        conditions.push(eq(schema.entries.contentTypeApiId, query.contentTypeApiId));
      }
      // Trash is hidden unless asked for. Pushed down rather than filtered in
      // JS so a space with a large trash cannot crowd out the scan window.
      conditions.push(
        query.archived
          ? eq(schema.entries.status, 'archived')
          : ne(schema.entries.status, 'archived'),
      );
      if (advanced) {
        // Draft field values live in entry_versions, so the superset prefilter
        // runs against the joined CURRENT version. Same contract as the
        // published path: narrows candidates, never changes the answer.
        const vFields = sql`${cv.fields}`;
        if (query.filters?.length) {
          const p = buildFilterPrefilter(query.filters, vFields, {
            entryId: sql`${schema.entries.id}`,
            contentTypeApiId: sql`${schema.entries.contentTypeApiId}`,
          });
          if (p) conditions.push(p);
        }
        if (query.search) {
          const p = buildSearchPrefilter(query.search, vFields);
          if (p) conditions.push(p);
        }
      }
      let select = withFields()
        .where(and(...conditions))
        .orderBy(asc(schema.entries.updatedAt))
        .$dynamic();
      // SQL pagination is only valid when there are no JS-side field predicates;
      // otherwise bound the candidate scan (+1 to detect overflow).
      select = advanced
        ? select.limit(scanLimit + 1)
        : select.limit(query.limit ?? 100).offset(query.skip ?? 0);
      const rows = await select;
      if (advanced && rows.length > scanLimit) throw new QueryTooBroadError(scanLimit);
      const results = rows.map(toEntryWithFields);
      if (!advanced) return results;
      const filtered = runEntryQuery(
        results,
        query,
        (r) => r.fields,
        (r) => ({ id: r.entry.id, contentType: r.entry.contentTypeApiId, status: r.entry.status }),
      );
      if (!query.select) return filtered;
      return filtered.map((r) => ({
        ...r,
        fields: projectFields(r.fields, query.select as string[]),
      }));
    },
    async countByStatus(scope) {
      const rows = await db
        .select({
          contentType: schema.entries.contentTypeApiId,
          status: schema.entries.status,
          n: count(),
        })
        .from(schema.entries)
        .where(scopeFilter(schema.entries, scope))
        .groupBy(schema.entries.contentTypeApiId, schema.entries.status);
      return rows.map((r) => ({
        contentType: r.contentType,
        status: r.status,
        count: Number(r.n),
      }));
    },
    async create(scope, entry, version) {
      await writeAll(x, [
        db.insert(schema.entries).values(entryRow(scope, entry)),
        db.insert(schema.entryVersions).values(versionRow(scope, version)),
      ]);
    },
    async saveVersion(scope, entry, version) {
      await writeAll(x, [
        db.insert(schema.entryVersions).values(versionRow(scope, version)),
        saveEntryAggregate(db, scope, entry),
      ]);
    },
    async saveAggregate(scope, entry) {
      await x.write(saveEntryAggregate(db, scope, entry));
    },
    async replaceUniqueClaims(scope, entryId, claims) {
      // The entry's own claims go first, so re-saving an entry that keeps a
      // value does not collide with itself.
      const statements: Query[] = [
        deleteClaims(scope, entryId),
        ...insertChunks(schema.entryUniqueValues, uniqueRows(scope, entryId, claims), (chunk) =>
          db.insert(schema.entryUniqueValues).values(chunk),
        ),
      ];
      try {
        await writeAll(x, statements);
      } catch (err) {
        // The race this constraint exists for: the pre-check passed and another
        // writer committed first. (Inside a unit of work the violation surfaces
        // at commit instead, as a generic ConflictError from the unit.)
        if (isUniqueViolation(err) || err instanceof ConflictError) {
          throw new ConflictError('Another entry already uses one of these values', {
            claims: claims.map((c) => ({ field: c.fieldApiId, locale: c.locale })),
          });
        }
        throw err;
      }
    },
    async findUniqueConflicts(scope, claims, excludeEntryId) {
      if (claims.length === 0) return [];
      const rows = await selectChunked(
        claims,
        (chunk) =>
          db
            .select()
            .from(schema.entryUniqueValues)
            .where(
              and(
                scopeFilter(schema.entryUniqueValues, scope),
                or(
                  ...chunk.map(
                    (c) =>
                      sql`(${schema.entryUniqueValues.contentTypeApiId} = ${c.contentTypeApiId} AND ${schema.entryUniqueValues.fieldApiId} = ${c.fieldApiId} AND ${schema.entryUniqueValues.locale} = ${c.locale} AND ${schema.entryUniqueValues.value} = ${c.value})`,
                  ),
                ) as SQL,
                ...(excludeEntryId ? [ne(schema.entryUniqueValues.entryId, excludeEntryId)] : []),
              ),
            ),
        4,
        RESERVED,
      );
      return rows.map((r) => ({
        fieldApiId: r.fieldApiId,
        locale: r.locale,
        value: r.value,
        entryId: r.entryId,
      }));
    },
    async releaseUniqueClaims(scope, entryId) {
      await x.write(deleteClaims(scope, entryId));
    },
    async delete(scope, id) {
      // One atomic step (versions, claims, then the entry row).
      await writeAll(x, [
        db
          .delete(schema.entryVersions)
          .where(
            and(scopeFilter(schema.entryVersions, scope), eq(schema.entryVersions.entryId, id)),
          ),
        deleteClaims(scope, id),
        db
          .delete(schema.entries)
          .where(and(scopeFilter(schema.entries, scope), eq(schema.entries.id, id))),
      ]);
    },
    async saveAggregateMany(scope, entries) {
      if (entries.length === 0) return;
      // One UPDATE per row (SQLite has no UPDATE ... FROM (VALUES ...) with typed
      // casts), sent as one batch. Deliberately an UPDATE, not an upsert: like the
      // single-item saveEntryAggregate, a row deleted by a concurrent writer must
      // silently no-op, never be re-created as a versionless zombie.
      const at = new Date();
      await writeAll(
        x,
        entries.map((e) =>
          db
            .update(schema.entries)
            .set({
              status: e.status,
              currentVersion: e.currentVersion,
              publishedVersion: e.publishedVersion ?? null,
              updatedAt: at,
            })
            .where(and(scopeFilter(schema.entries, scope), eq(schema.entries.id, e.id))),
        ),
      );
    },
    async listVersions(scope, entryId) {
      const rows = await db
        .select()
        .from(schema.entryVersions)
        .where(
          and(scopeFilter(schema.entryVersions, scope), eq(schema.entryVersions.entryId, entryId)),
        )
        .orderBy(desc(schema.entryVersions.version));
      return rows.map(toVersion);
    },
    async getVersion(scope, entryId, version) {
      const [row] = await db
        .select()
        .from(schema.entryVersions)
        .where(
          and(
            scopeFilter(schema.entryVersions, scope),
            eq(schema.entryVersions.entryId, entryId),
            eq(schema.entryVersions.version, version),
          ),
        );
      return row ? toVersion(row) : null;
    },
    async putPublished(scope, snapshot) {
      await putPublishedMany(scope, [snapshot]);
    },
    putPublishedMany,
    async removePublished(scope, entryId) {
      await removePublishedMany(scope, [entryId]);
    },
    removePublishedMany,
    async getPublished(scope, id) {
      const [row] = await db
        .select()
        .from(schema.entryPublished)
        .where(
          and(scopeFilter(schema.entryPublished, scope), eq(schema.entryPublished.entryId, id)),
        );
      return row ? toPublished(row) : null;
    },
    async getPublishedMany(scope, ids) {
      const rows = await selectChunked(
        ids,
        (chunk) =>
          db
            .select()
            .from(schema.entryPublished)
            .where(
              and(
                scopeFilter(schema.entryPublished, scope),
                inArray(schema.entryPublished.entryId, chunk),
              ),
            ),
        1,
        RESERVED,
      );
      return rows.map(toPublished);
    },
    async listPublished(scope, query: EntryQuery) {
      const advanced = isAdvancedQuery(query);
      const conditions = [scopeFilter(schema.entryPublished, scope)];
      if (query.contentTypeApiId) {
        conditions.push(eq(schema.entryPublished.contentTypeApiId, query.contentTypeApiId));
      }
      if (query.since)
        conditions.push(gt(schema.entryPublished.publishedAt, new Date(query.since)));
      if (query.afterEntryId !== undefined && query.afterEntryId !== '')
        conditions.push(gt(schema.entryPublished.entryId, query.afterEntryId));
      if (query.after) {
        // Strictly after (publishedAt, entryId) in the default publish order —
        // exact across same-transaction publishes sharing a publish instant.
        const boundary = new Date(query.after.publishedAt);
        const cond = or(
          gt(schema.entryPublished.publishedAt, boundary),
          and(
            eq(schema.entryPublished.publishedAt, boundary),
            gt(schema.entryPublished.entryId, query.after.entryId),
          ),
        );
        if (cond) conditions.push(cond);
      }
      // Superset prefilters for the field-level predicates: they only narrow
      // the candidate set, never change the answer (the domain engine below
      // still decides). This is what keeps a filtered/searched query from
      // materializing the entire scoped published set.
      const fieldsCol = sql`${schema.entryPublished.fields}`;
      const sysCols = {
        entryId: sql`${schema.entryPublished.entryId}`,
        contentTypeApiId: sql`${schema.entryPublished.contentTypeApiId}`,
        publishedAt: sql`${schema.entryPublished.publishedAt}`,
      };
      if (advanced) {
        if (query.filters?.length) {
          const pre = buildFilterPrefilter(query.filters, fieldsCol, sysCols);
          if (pre) conditions.push(pre);
        }
        if (query.search) {
          const pre = buildSearchPrefilter(query.search, fieldsCol);
          if (pre) conditions.push(pre);
        }
      }
      let select = db
        .select()
        .from(schema.entryPublished)
        .where(and(...conditions))
        // Keyset paging (afterEntryId) orders by entryId so the cursor stays
        // stable under concurrent publishes/unpublishes; otherwise publishedAt
        // with an entryId tie-break (same-transaction publishes share
        // publishedAt), which keeps offset paging reliable.
        .orderBy(
          ...(query.afterEntryId !== undefined
            ? [asc(schema.entryPublished.entryId)]
            : [asc(schema.entryPublished.publishedAt), asc(schema.entryPublished.entryId)]),
        )
        .$dynamic();
      if (!advanced) {
        select = select.limit(query.limit ?? 100).offset(query.skip ?? 0);
      } else {
        // Bound the candidate scan. Ordering/pagination still happen in JS
        // (the engine's comparison semantics are type-dependent), so this cap
        // is the ceiling on rows pulled into memory — +1 to detect overflow
        // and report it instead of silently truncating the result.
        select = select.limit(scanLimit + 1);
      }
      const published = (await select).map(toPublished);
      if (!advanced) return published;
      if (published.length > scanLimit) {
        throw new QueryTooBroadError(scanLimit);
      }
      const filtered = runEntryQuery(
        published,
        query,
        (r) => r.fields,
        (r) => ({
          id: r.entryId,
          contentType: r.contentTypeApiId,
          publishedAt: r.publishedAt,
          'metadata.tags': r.metadata?.tags ?? [],
          'metadata.concepts': r.metadata?.concepts ?? [],
        }),
      );
      if (!query.select) return filtered;
      return filtered.map((r) => ({
        ...r,
        fields: projectFields(r.fields, query.select as string[]),
      }));
    },
    async countPublished(scope, query) {
      const conditions = [scopeFilter(schema.entryPublished, scope)];
      if (query?.contentType) {
        conditions.push(eq(schema.entryPublished.contentTypeApiId, query.contentType));
      }
      const [row] = await db
        .select({ n: count() })
        .from(schema.entryPublished)
        .where(and(...conditions));
      return Number(row?.n ?? 0);
    },
    /**
     * D1 has no full-text index here, so this is the same "superset prefilter in SQL, exact
     * answer in JS" model as `listPublished`: every term must appear (case-insensitive LIKE
     * over the decoded string values), then each candidate is scored by total term frequency
     * across its string values in all locales (the in-memory store's ranking). The candidate
     * scan is capped like field-level queries ({@link QueryTooBroadError} past it).
     *
     * Production lexical search comes from the separate SearchShard index (the
     * `SearchIndex` port); this is its built-in fallback.
     */
    async searchPublished(scope, query, opts) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      if (terms.length === 0) return [];
      const fieldsCol = sql`${schema.entryPublished.fields}`;
      const rows = await db
        .select({ entryId: schema.entryPublished.entryId, fields: schema.entryPublished.fields })
        .from(schema.entryPublished)
        .where(
          and(
            scopeFilter(schema.entryPublished, scope),
            ...terms.map((t) => buildSearchPrefilter(t, fieldsCol) as SQL),
          ),
        )
        .limit(scanLimit + 1);
      if (rows.length > scanLimit) throw new QueryTooBroadError(scanLimit);
      const hits: { entryId: string; score: number }[] = [];
      for (const row of rows) {
        const texts: string[] = [];
        for (const localized of Object.values(row.fields)) {
          if (!localized || typeof localized !== 'object') continue;
          for (const value of Object.values(localized)) {
            if (typeof value === 'string') texts.push(value.toLowerCase());
          }
        }
        const haystack = texts.join(' ');
        let score = 0;
        let matchedAll = true;
        for (const term of terms) {
          let n = 0;
          for (
            let at = haystack.indexOf(term);
            at !== -1;
            at = haystack.indexOf(term, at + term.length)
          ) {
            n += 1;
          }
          if (n === 0) {
            matchedAll = false;
            break;
          }
          score += n;
        }
        if (matchedAll) hits.push({ entryId: row.entryId, score });
      }
      return hits
        .sort((a, b) => b.score - a.score || a.entryId.localeCompare(b.entryId))
        .slice(0, opts.topK);
    },
  };
}

function makeAssetRepo(x: Exec): AssetRepo {
  const db = x.db;
  const upsertDraft = async (scope: Scope, asset: Asset) => {
    const values = {
      spaceId: scope.spaceId,
      environmentId: scope.environmentId,
      id: asset.id,
      status: asset.status,
      file: asset.file,
      title: asset.title,
      description: asset.description,
      metadata: asset.metadata,
      updatedAt: new Date(),
    };
    await x.write(
      db
        .insert(schema.assets)
        .values(values)
        .onConflictDoUpdate({
          target: [schema.assets.spaceId, schema.assets.environmentId, schema.assets.id],
          set: {
            status: values.status,
            file: values.file,
            title: values.title,
            description: values.description,
            metadata: values.metadata,
            updatedAt: values.updatedAt,
          },
        }),
    );
  };
  return {
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.assets)
        .where(and(scopeFilter(schema.assets, scope), eq(schema.assets.id, id)));
      return row
        ? {
            id: row.id,
            status: row.status,
            file: row.file,
            title: row.title,
            description: row.description,
            metadata: row.metadata,
          }
        : null;
    },
    async getMany(scope, ids) {
      const rows = await selectChunked(
        ids,
        (chunk) =>
          db
            .select()
            .from(schema.assets)
            .where(and(scopeFilter(schema.assets, scope), inArray(schema.assets.id, chunk))),
        1,
        RESERVED,
      );
      return rows.map((r) => ({
        id: r.id,
        status: r.status,
        file: r.file,
        title: r.title,
        description: r.description,
        metadata: r.metadata,
      }));
    },
    async list(scope, query) {
      const rows = await db
        .select()
        .from(schema.assets)
        .where(scopeFilter(schema.assets, scope))
        .orderBy(desc(schema.assets.updatedAt))
        .limit(query.limit ?? 100)
        .offset(query.skip ?? 0);
      return rows.map((r) => ({
        id: r.id,
        status: r.status,
        file: r.file,
        title: r.title,
        description: r.description,
        metadata: r.metadata,
      }));
    },
    create: upsertDraft,
    save: upsertDraft,
    async putPublished(scope, s) {
      const values = {
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        assetId: s.assetId,
        file: s.file,
        title: s.title,
        description: s.description,
        metadata: s.metadata,
        publishedAt: new Date(s.publishedAt),
      };
      await x.write(
        db
          .insert(schema.assetPublished)
          .values(values)
          .onConflictDoUpdate({
            target: [
              schema.assetPublished.spaceId,
              schema.assetPublished.environmentId,
              schema.assetPublished.assetId,
            ],
            set: {
              file: values.file,
              title: values.title,
              description: values.description,
              metadata: values.metadata,
              publishedAt: values.publishedAt,
            },
          }),
      );
    },
    async removePublished(scope, id) {
      await x.write(
        db
          .delete(schema.assetPublished)
          .where(
            and(scopeFilter(schema.assetPublished, scope), eq(schema.assetPublished.assetId, id)),
          ),
      );
    },
    async getPublished(scope, id) {
      const [row] = await db
        .select()
        .from(schema.assetPublished)
        .where(
          and(scopeFilter(schema.assetPublished, scope), eq(schema.assetPublished.assetId, id)),
        );
      return row ? toPublishedAsset(row) : null;
    },
    async getPublishedMany(scope, ids) {
      const rows = await selectChunked(
        ids,
        (chunk) =>
          db
            .select()
            .from(schema.assetPublished)
            .where(
              and(
                scopeFilter(schema.assetPublished, scope),
                inArray(schema.assetPublished.assetId, chunk),
              ),
            ),
        1,
        RESERVED,
      );
      return rows.map(toPublishedAsset);
    },
    async listPublished(scope, query) {
      const rows = await db
        .select()
        .from(schema.assetPublished)
        .where(scopeFilter(schema.assetPublished, scope))
        .orderBy(asc(schema.assetPublished.publishedAt))
        .limit(query.limit ?? 100)
        .offset(query.skip ?? 0);
      return rows.map(toPublishedAsset);
    },
  };
}

function makeReferenceRepo(x: Exec): ReferenceRepo {
  const db = x.db;
  const insertEdges = (scope: Scope, edges: readonly ReferenceEdge[]) =>
    insertChunks(schema.references, edges, (chunk) =>
      db.insert(schema.references).values(
        chunk.map((e) => ({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          fromEntryId: e.fromEntryId,
          fromField: e.fromField,
          toId: e.toId,
          toType: e.toType,
        })),
      ),
    );
  const deleteFrom = (scope: Scope, fromEntryIds: readonly string[]) =>
    chunked(fromEntryIds, 1, RESERVED).map((chunk) =>
      db
        .delete(schema.references)
        .where(
          and(scopeFilter(schema.references, scope), inArray(schema.references.fromEntryId, chunk)),
        ),
    );
  return {
    async replaceForEntry(scope, fromEntryId, edges) {
      await writeAll(x, [...deleteFrom(scope, [fromEntryId]), ...insertEdges(scope, edges)]);
    },
    async replaceForEntries(scope, replacements) {
      if (replacements.length === 0) return;
      await writeAll(x, [
        ...deleteFrom(
          scope,
          replacements.map((r) => r.fromEntryId),
        ),
        ...insertEdges(
          scope,
          replacements.flatMap((r) => r.edges),
        ),
      ]);
    },
    async removeForEntry(scope, fromEntryId) {
      await writeAll(x, deleteFrom(scope, [fromEntryId]));
    },
    async findForward(scope, fromEntryId) {
      const rows = await db
        .select()
        .from(schema.references)
        .where(
          and(
            scopeFilter(schema.references, scope),
            eq(schema.references.fromEntryId, fromEntryId),
          ),
        );
      return rows.map(toEdge);
    },
    async findReverse(scope, toId) {
      const rows = await db
        .select()
        .from(schema.references)
        .where(and(scopeFilter(schema.references, scope), eq(schema.references.toId, toId)));
      return rows.map(toEdge);
    },
    async findReverseClosure(scope, toIds, opts) {
      if (toIds.length === 0) return [];
      // One recursive CTE over the (space, env, to_id) index replaces a
      // breadth-first walk of per-node round-trips. Working rows are
      // (entry_id, depth) tuples, so a cycle produces rows at increasing
      // depths — the `depth < maxDepth` bound is what terminates it (UNION
      // dedupe only collapses same-depth revisits); the outer LIMIT caps the
      // result set. Seeds are excluded from the output. The seed list is ONE
      // JSON-array parameter (`json_each`), so its size never meets D1's
      // 100-parameter cap.
      const seeds = JSON.stringify([...new Set(toIds)]);
      const rows = await db.all<{ entry_id: string }>(sql`
        WITH RECURSIVE closure(entry_id, depth) AS (
          SELECT r.from_entry_id, 1
          FROM ${schema.references} r
          WHERE r.space_id = ${scope.spaceId} AND r.environment_id = ${scope.environmentId}
            AND r.to_id IN (SELECT value FROM json_each(${seeds}))
          UNION
          SELECT r.from_entry_id, c.depth + 1
          FROM ${schema.references} r
          JOIN closure c ON r.to_id = c.entry_id
          WHERE r.space_id = ${scope.spaceId} AND r.environment_id = ${scope.environmentId}
            AND c.depth < ${opts.maxDepth}
        )
        SELECT DISTINCT entry_id FROM closure
        WHERE entry_id NOT IN (SELECT value FROM json_each(${seeds}))
        LIMIT ${opts.maxEntries}
      `);
      return rows.map((r) => r.entry_id);
    },
  };
}

function makeBulkJobRepo(x: Exec): BulkJobRepo {
  const db = x.db;
  const toJob = (row: typeof schema.bulkJobs.$inferSelect): BulkJob => ({
    id: row.id,
    action: row.action,
    status: row.status,
    totalItems: row.totalItems,
    totalChunks: row.totalChunks,
    completedChunks: row.completedChunks,
    succeeded: row.succeeded,
    failed: row.failed,
    createdAt: row.createdAt.toISOString(),
    ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {}),
    ...(row.config ? { config: row.config } : {}),
  });
  const toChunk = (row: typeof schema.bulkJobChunks.$inferSelect): BulkJobChunk => ({
    jobId: row.jobId,
    chunkId: row.chunkId,
    entryIds: row.entryIds,
    status: row.status,
    attempts: row.attempts,
    failures: row.failures,
    ...(row.payloadKey ? { payloadKey: row.payloadKey } : {}),
  });
  const jobWhere = (scope: Scope, id: string) =>
    and(scopeFilter(schema.bulkJobs, scope), eq(schema.bulkJobs.id, id));

  return {
    async createJob(scope, job) {
      await x.write(
        db.insert(schema.bulkJobs).values({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          id: job.id,
          action: job.action,
          status: job.status,
          totalItems: job.totalItems,
          totalChunks: job.totalChunks,
          completedChunks: job.completedChunks,
          succeeded: job.succeeded,
          failed: job.failed,
          createdAt: new Date(job.createdAt),
          config: job.config ?? null,
        }),
      );
    },
    async getJob(scope, id) {
      const [row] = await db.select().from(schema.bulkJobs).where(jobWhere(scope, id));
      return row ? toJob(row) : null;
    },
    async listJobs(scope, opts) {
      const rows = await db
        .select()
        .from(schema.bulkJobs)
        .where(scopeFilter(schema.bulkJobs, scope))
        .orderBy(desc(schema.bulkJobs.createdAt), desc(schema.bulkJobs.id))
        .limit(opts?.limit ?? 50);
      return rows.map(toJob);
    },
    async createChunks(scope, chunks) {
      if (chunks.length === 0) return;
      // Multi-row inserts sliced under D1's parameter cap (each row carries a
      // JSON id list as one bound parameter).
      await writeAll(
        x,
        insertChunks(schema.bulkJobChunks, chunks, (slice) =>
          db.insert(schema.bulkJobChunks).values(
            slice.map((c) => ({
              spaceId: scope.spaceId,
              environmentId: scope.environmentId,
              jobId: c.jobId,
              chunkId: c.chunkId,
              entryIds: [...c.entryIds],
              status: c.status,
              attempts: c.attempts,
              failures: [...c.failures],
              payloadKey: c.payloadKey ?? null,
            })),
          ),
        ),
      );
    },
    async listChunks(scope, jobId) {
      const rows = await db
        .select()
        .from(schema.bulkJobChunks)
        .where(and(scopeFilter(schema.bulkJobChunks, scope), eq(schema.bulkJobChunks.jobId, jobId)))
        .orderBy(asc(schema.bulkJobChunks.chunkId));
      return rows.map(toChunk);
    },
    async claimChunk(scope, jobId, chunkId, opts) {
      directOnly(x, 'bulkJobs.claimChunk');
      // Single-statement CAS: only a pending chunk or a stale running claim
      // transitions; a concurrent claimer's UPDATE matches zero rows.
      const claimed = await db
        .update(schema.bulkJobChunks)
        .set({ status: 'running', claimedAt: opts.now, attempts: sql`attempts + 1` })
        .where(
          and(
            scopeFilter(schema.bulkJobChunks, scope),
            eq(schema.bulkJobChunks.jobId, jobId),
            eq(schema.bulkJobChunks.chunkId, chunkId),
            or(
              eq(schema.bulkJobChunks.status, 'pending'),
              and(
                eq(schema.bulkJobChunks.status, 'running'),
                lt(schema.bulkJobChunks.claimedAt, opts.staleBefore),
              ),
            ),
          ),
        )
        .returning();
      return claimed[0] ? toChunk(claimed[0]) : null;
    },
    async completeChunk(scope, jobId, chunkId, outcome) {
      directOnly(x, 'bulkJobs.completeChunk');
      // One atomic batch: the chunk CAS, then
      // the counter fold guarded on `changes() = 1` (it applies only if the
      // chunk UPDATE just matched — a duplicate completion from a redelivered
      // event must not double-count), then the job as it now stands.
      const [chunkRows, , jobRows] = await db
        .batch([
          db
            .update(schema.bulkJobChunks)
            .set({
              status: outcome.status,
              failures: [...outcome.failures],
              completedAt: new Date(),
            })
            .where(
              and(
                scopeFilter(schema.bulkJobChunks, scope),
                eq(schema.bulkJobChunks.jobId, jobId),
                eq(schema.bulkJobChunks.chunkId, chunkId),
                eq(schema.bulkJobChunks.status, 'running'),
              ),
            )
            .returning({ chunkId: schema.bulkJobChunks.chunkId }),
          db
            .update(schema.bulkJobs)
            .set({
              completedChunks: sql`completed_chunks + 1`,
              succeeded: sql`succeeded + ${outcome.succeeded}`,
              failed: sql`failed + ${outcome.failed}`,
            })
            .where(and(jobWhere(scope, jobId), sql`changes() = 1`)),
          db.select().from(schema.bulkJobs).where(jobWhere(scope, jobId)),
        ])
        .catch((err: unknown) => {
          throw mapD1Error(err);
        });
      const [job] = jobRows;
      if (!job) {
        throw new Error(
          chunkRows.length > 0
            ? `Bulk job ${jobId} not found for completed chunk`
            : `Bulk job ${jobId} not found`,
        );
      }
      return toJob(job);
    },
    async finalizeJob(scope, id, status, at) {
      const running = and(jobWhere(scope, id), eq(schema.bulkJobs.status, 'running'));
      if (x.inUnit) {
        // Unit of work: decide from committed state, buffer the CAS, and let the
        // guard abort the unit (TransactionConflictError) if another finalizer
        // commits first. The returned job is the row as this write leaves it.
        const [row] = await db.select().from(schema.bulkJobs).where(jobWhere(scope, id));
        if (row?.status !== 'running') return null;
        await x.write(db.update(schema.bulkJobs).set({ status, completedAt: at }).where(running));
        x.expectChanged(1);
        return toJob({ ...row, status, completedAt: at });
      }
      const [row] = await db
        .update(schema.bulkJobs)
        .set({ status, completedAt: at })
        .where(running)
        .returning();
      return row ? toJob(row) : null;
    },
    async releaseChunk(scope, jobId, chunkId) {
      await x.write(
        db
          .update(schema.bulkJobChunks)
          .set({ status: 'pending', claimedAt: null })
          .where(
            and(
              scopeFilter(schema.bulkJobChunks, scope),
              eq(schema.bulkJobChunks.jobId, jobId),
              eq(schema.bulkJobChunks.chunkId, chunkId),
              eq(schema.bulkJobChunks.status, 'running'),
            ),
          ),
      );
    },
    async findStalledChunks(staleBefore, limit) {
      // Open chunks past the threshold, joined to their (running) jobs so a
      // cancelled job's leftovers are never re-nudged.
      const rows = await db
        .select({
          spaceId: schema.bulkJobChunks.spaceId,
          environmentId: schema.bulkJobChunks.environmentId,
          jobId: schema.bulkJobChunks.jobId,
          chunkId: schema.bulkJobChunks.chunkId,
        })
        .from(schema.bulkJobChunks)
        .innerJoin(
          schema.bulkJobs,
          and(
            eq(schema.bulkJobChunks.spaceId, schema.bulkJobs.spaceId),
            eq(schema.bulkJobChunks.environmentId, schema.bulkJobs.environmentId),
            eq(schema.bulkJobChunks.jobId, schema.bulkJobs.id),
          ),
        )
        .where(
          and(
            eq(schema.bulkJobs.status, 'running'),
            or(
              and(
                eq(schema.bulkJobChunks.status, 'pending'),
                lt(schema.bulkJobChunks.createdAt, staleBefore),
              ),
              and(
                eq(schema.bulkJobChunks.status, 'running'),
                lt(schema.bulkJobChunks.claimedAt, staleBefore),
              ),
            ),
          ),
        )
        .limit(limit);
      return rows.map((r) => ({
        scope: { spaceId: r.spaceId, environmentId: r.environmentId },
        jobId: r.jobId,
        chunkId: r.chunkId,
      }));
    },
    async findUnfinalizedJobs(limit) {
      const rows = await db
        .select({
          spaceId: schema.bulkJobs.spaceId,
          environmentId: schema.bulkJobs.environmentId,
          id: schema.bulkJobs.id,
        })
        .from(schema.bulkJobs)
        .where(
          and(
            eq(schema.bulkJobs.status, 'running'),
            gte(schema.bulkJobs.completedChunks, schema.bulkJobs.totalChunks),
          ),
        )
        .limit(limit);
      return rows.map((r) => ({
        scope: { spaceId: r.spaceId, environmentId: r.environmentId },
        jobId: r.id,
      }));
    },
  };
}

/** How long a `readPending` claim keeps other relayers off its rows. */
export const OUTBOX_LEASE_MS = 60_000;

function makeOutboxRepo(x: Exec): OutboxRepo {
  const db = x.db;
  const appendMany = async (events: readonly DomainEvent[]): Promise<void> => {
    if (events.length === 0) return;
    await writeAll(
      x,
      insertChunks(schema.outbox, events, (chunk) =>
        db.insert(schema.outbox).values(
          chunk.map((event) => ({
            id: event.id,
            type: event.type,
            payload: event,
            occurredAt: new Date(event.occurredAt),
          })),
        ),
      ),
    );
  };
  return {
    async append(event) {
      await appendMany([event]);
    },
    appendMany,
    /**
     * A lease claim, executed immediately even inside a unit of work (D1 has no
     * `FOR UPDATE SKIP LOCKED`): one UPDATE stamps the oldest unclaimed (or
     * lease-expired) pending rows with a fresh claimer id and a 60s lease and
     * returns them. D1 serializes writes, so concurrent relayers claim disjoint
     * rows. If the relayer dies before `markRelayed` commits, the lease lapses
     * and the rows are re-claimed (at-least-once).
     */
    async readPending(limit) {
      const now = new Date();
      const claimable = db
        .select({ id: schema.outbox.id })
        .from(schema.outbox)
        .where(
          and(
            isNull(schema.outbox.relayedAt),
            or(isNull(schema.outbox.claimedUntil), lt(schema.outbox.claimedUntil, now)),
          ),
        )
        .orderBy(asc(schema.outbox.occurredAt))
        .limit(limit);
      const rows = await db
        .update(schema.outbox)
        .set({
          claimedBy: crypto.randomUUID(),
          claimedUntil: new Date(now.getTime() + OUTBOX_LEASE_MS),
        })
        .where(inArray(schema.outbox.id, claimable))
        .returning();
      return rows
        .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
        .map((r) => r.payload as DomainEvent);
    },
    async markRelayed(eventIds) {
      if (eventIds.length === 0) return;
      const at = new Date();
      await writeAll(
        x,
        chunked(eventIds, 1, RESERVED).map((chunk) =>
          db.update(schema.outbox).set({ relayedAt: at }).where(inArray(schema.outbox.id, chunk)),
        ),
      );
    },
    async deleteRelayedBefore(before, limit) {
      directOnly(x, 'outbox.deleteRelayedBefore');
      // Bound the sweep via an id subquery so a huge backlog is trimmed in
      // controlled slices.
      const victims = db
        .select({ id: schema.outbox.id })
        .from(schema.outbox)
        .where(and(isNotNull(schema.outbox.relayedAt), lt(schema.outbox.relayedAt, before)))
        .limit(limit);
      const deleted = await db
        .delete(schema.outbox)
        .where(inArray(schema.outbox.id, victims))
        .returning({ id: schema.outbox.id });
      return deleted.length;
    },
  };
}

/**
 * Raw access to sealed secret columns for the reseal sweep. Ordering and the
 * cursor use SQLite's default BINARY collation (byte order), so the page boundary is total and matches the in-memory
 * adapter; the prefix test uses `substr`, avoiding LIKE wildcard escaping
 * (`_` is a base64url character).
 */
function makeStoredSecretRepo(x: Exec): StoredSecretRepo {
  const db = x.db;
  const w = schema.webhooks;
  return {
    async scan(column, { excludePrefix, after, limit }) {
      if (column === 'webhooks.secret') {
        const rows = await db.all<{ id: string; value: string }>(sql`
          SELECT w.id AS id, w.secret AS value
          FROM ${w} w
          WHERE substr(w.secret, 1, length(${excludePrefix})) <> ${excludePrefix}
            ${after ? sql`AND w.id > ${after.id}` : sql``}
          ORDER BY w.id
          LIMIT ${limit}
        `);
        return rows.map((r) => ({ column, id: r.id, value: r.value }));
      }
      const rows = await db.all<{ id: string; key: string; value: string }>(sql`
        SELECT w.id AS id, h.key AS key, h.value AS value
        FROM ${w} w, json_each(w.headers) h
        WHERE w.headers IS NOT NULL AND json_type(w.headers) = 'object'
          AND h.type = 'text'
          AND substr(h.value, 1, length(${excludePrefix})) <> ${excludePrefix}
          ${
            after
              ? sql`AND (w.id > ${after.id} OR (w.id = ${after.id} AND h.key > ${after.key ?? ''}))`
              : sql``
          }
        ORDER BY w.id, h.key
        LIMIT ${limit}
      `);
      return rows.map((r) => ({ column, id: r.id, key: r.key, value: r.value }));
    },
    async replace(ref, was, next) {
      directOnly(x, 'storedSecrets.replace');
      if (ref.column === 'webhooks.secret') {
        const rows = await db
          .update(w)
          .set({ secret: next })
          .where(and(eq(w.id, ref.id), eq(w.secret, was)))
          .returning({ id: w.id });
        return rows.length > 0;
      }
      const key = ref.key ?? '';
      if (!key.includes('"')) {
        // `$."key"` addresses the header without splicing it into SQL text; the
        // CAS compares only that header, so other headers may change concurrently.
        const path = `$."${key}"`;
        const rows = await db
          .update(w)
          .set({ headers: sql`json_set(${w.headers}, ${path}, ${next})` })
          .where(and(eq(w.id, ref.id), sql`json_extract(${w.headers}, ${path}) = ${was}`))
          .returning({ id: w.id });
        return rows.length > 0;
      }
      // A key SQLite's path syntax can't quote: edit in JS and compare-and-set the
      // whole column against the exact text read.
      const [row] = await db
        .select({ raw: sql<string | null>`${w.headers}` })
        .from(w)
        .where(eq(w.id, ref.id));
      if (!row?.raw) return false;
      const headers = JSON.parse(row.raw) as Record<string, string>;
      if (headers[key] !== was) return false;
      const rows = await db
        .update(w)
        .set({ headers: { ...headers, [key]: next } })
        .where(and(eq(w.id, ref.id), sql`${w.headers} = ${row.raw}`))
        .returning({ id: w.id });
      return rows.length > 0;
    },
  };
}

function makeWebhookRepo(x: Exec): WebhookRepo {
  const db = x.db;
  return {
    async create(scope, webhook) {
      await x.write(
        db.insert(schema.webhooks).values({
          id: webhook.id,
          spaceId: scope.spaceId,
          url: webhook.url,
          topics: [...webhook.topics],
          secret: webhook.secret,
          active: webhook.active,
          headers: webhook.headers ?? null,
        }),
      );
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.webhooks)
        .where(and(eq(schema.webhooks.spaceId, scope.spaceId), eq(schema.webhooks.id, id)));
      return row ? toWebhook(row) : null;
    },
    async list(scope) {
      const rows = await db
        .select()
        .from(schema.webhooks)
        .where(eq(schema.webhooks.spaceId, scope.spaceId));
      return rows.map(toWebhook);
    },
    async listByTopic(scope, type) {
      const rows = await db
        .select()
        .from(schema.webhooks)
        .where(eq(schema.webhooks.spaceId, scope.spaceId));
      return rows.map(toWebhook).filter((w) => matchesTopic(w, type));
    },
    async update(scope, webhook) {
      await x.write(
        db
          .update(schema.webhooks)
          .set({
            url: webhook.url,
            topics: [...webhook.topics],
            secret: webhook.secret,
            active: webhook.active,
            headers: webhook.headers ?? null,
          })
          .where(
            and(eq(schema.webhooks.spaceId, scope.spaceId), eq(schema.webhooks.id, webhook.id)),
          ),
      );
    },
    async delete(scope, id) {
      await x.write(
        db
          .delete(schema.webhooks)
          .where(and(eq(schema.webhooks.spaceId, scope.spaceId), eq(schema.webhooks.id, id))),
      );
    },
    async recordDelivery(scope, delivery) {
      await x.write(
        db.insert(schema.webhookDeliveries).values({
          spaceId: scope.spaceId,
          webhookId: delivery.webhookId,
          eventId: delivery.eventId,
          status: delivery.status,
          statusCode: delivery.statusCode ?? null,
          attempts: delivery.attempts,
          error: delivery.error ?? null,
        }),
      );
    },
    async listDeliveries(scope, webhookId, opts) {
      const rows = await db
        .select()
        .from(schema.webhookDeliveries)
        .where(
          and(
            eq(schema.webhookDeliveries.spaceId, scope.spaceId),
            eq(schema.webhookDeliveries.webhookId, webhookId),
          ),
        )
        .orderBy(desc(schema.webhookDeliveries.createdAt))
        .limit(opts?.limit ?? 50);
      return rows.map((r) => ({
        id: r.id,
        webhookId: r.webhookId,
        eventId: r.eventId,
        status: r.status,
        statusCode: r.statusCode ?? undefined,
        attempts: r.attempts,
        error: r.error ?? undefined,
        createdAt: r.createdAt.toISOString(),
      }));
    },
    async deleteDeliveriesBefore(before, limit) {
      directOnly(x, 'webhooks.deleteDeliveriesBefore');
      const victims = db
        .select({ id: schema.webhookDeliveries.id })
        .from(schema.webhookDeliveries)
        .where(lt(schema.webhookDeliveries.createdAt, before))
        .limit(limit);
      const deleted = await db
        .delete(schema.webhookDeliveries)
        .where(inArray(schema.webhookDeliveries.id, victims))
        .returning({ id: schema.webhookDeliveries.id });
      return deleted.length;
    },
  };
}

function makeAgentRunRepo(x: Exec): AgentRunRepo {
  const db = x.db;
  return {
    async record(scope, run) {
      await x.write(
        db.insert(schema.agentRuns).values({
          id: run.id,
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          workflow: run.workflow,
          entryId: run.entryId,
          status: run.status,
          decisions: [...run.decisions],
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          createdAt: new Date(run.createdAt),
        }),
      );
    },
    async list(scope, query) {
      const conds = [eq(schema.agentRuns.spaceId, scope.spaceId)];
      if (query.workflow) conds.push(eq(schema.agentRuns.workflow, query.workflow));
      const rows = await db
        .select()
        .from(schema.agentRuns)
        .where(and(...conds))
        .orderBy(desc(schema.agentRuns.createdAt))
        .limit(query.limit ?? 100);
      return rows.map(toAgentRun);
    },
    async usage(scope, query) {
      const conds = [eq(schema.agentRuns.spaceId, scope.spaceId)];
      if (query.workflow) conds.push(eq(schema.agentRuns.workflow, query.workflow));
      if (query.since) conds.push(gte(schema.agentRuns.createdAt, new Date(query.since)));
      const [row] = await db
        .select({
          runs: count(),
          inputTokens: sum(schema.agentRuns.inputTokens),
          outputTokens: sum(schema.agentRuns.outputTokens),
        })
        .from(schema.agentRuns)
        .where(and(...conds));
      return {
        runs: Number(row?.runs ?? 0),
        inputTokens: Number(row?.inputTokens ?? 0),
        outputTokens: Number(row?.outputTokens ?? 0),
      };
    },
  };
}

function makeAuditRepo(x: Exec): AuditRepo {
  const db = x.db;
  return {
    async append(entry) {
      await x.write(
        db.insert(schema.auditLog).values({
          id: entry.id,
          spaceId: entry.spaceId,
          environmentId: entry.environmentId ?? null,
          actor: entry.actor,
          action: entry.action,
          targetType: entry.targetType ?? null,
          targetId: entry.targetId ?? null,
          status: entry.status,
          at: new Date(entry.at),
        }),
      );
    },
    async list(spaceId, query) {
      const conds = [eq(schema.auditLog.spaceId, spaceId)];
      if (query.environmentId) conds.push(eq(schema.auditLog.environmentId, query.environmentId));
      const rows = await db
        .select()
        .from(schema.auditLog)
        .where(and(...conds))
        .orderBy(desc(schema.auditLog.at))
        .limit(query.limit ?? 100);
      return rows.map((r) => ({
        id: r.id,
        spaceId: r.spaceId,
        environmentId: r.environmentId ?? undefined,
        actor: r.actor,
        action: r.action,
        targetType: r.targetType ?? undefined,
        targetId: r.targetId ?? undefined,
        status: r.status,
        at: r.at.toISOString(),
      }));
    },
  };
}

function makeAiActionRepo(x: Exec): AIActionRepo {
  const db = x.db;
  const toAction = (r: typeof schema.aiActions.$inferSelect): AIActionDefinition => ({
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    promptTemplate: r.promptTemplate,
    variables: r.variables,
    targetField: r.targetField ?? undefined,
    tier: r.tier,
    createdAt: r.createdAt.toISOString(),
  });
  return {
    async create(scope, action) {
      await x.write(
        db.insert(schema.aiActions).values({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          id: action.id,
          name: action.name,
          description: action.description ?? null,
          promptTemplate: action.promptTemplate,
          variables: [...action.variables],
          targetField: action.targetField ?? null,
          tier: action.tier,
          createdAt: new Date(action.createdAt),
        }),
      );
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.aiActions)
        .where(and(scopeFilter(schema.aiActions, scope), eq(schema.aiActions.id, id)));
      return row ? toAction(row) : null;
    },
    async list(scope) {
      const rows = await db
        .select()
        .from(schema.aiActions)
        .where(scopeFilter(schema.aiActions, scope))
        .orderBy(desc(schema.aiActions.createdAt));
      return rows.map(toAction);
    },
    async delete(scope, id) {
      await x.write(
        db
          .delete(schema.aiActions)
          .where(and(scopeFilter(schema.aiActions, scope), eq(schema.aiActions.id, id))),
      );
    },
  };
}

function makeFunctionRepo(x: Exec): FunctionRepo {
  const db = x.db;
  const toFn = (r: typeof schema.functions.$inferSelect): FunctionDefinition => ({
    id: r.id,
    name: r.name,
    eventPattern: r.eventPattern,
    url: r.url,
    active: r.active,
    createdAt: r.createdAt.toISOString(),
  });
  return {
    async create(scope, fn) {
      await x.write(
        db.insert(schema.functions).values({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          id: fn.id,
          name: fn.name,
          eventPattern: fn.eventPattern,
          url: fn.url,
          active: fn.active,
          createdAt: new Date(fn.createdAt),
        }),
      );
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.functions)
        .where(and(scopeFilter(schema.functions, scope), eq(schema.functions.id, id)));
      return row ? toFn(row) : null;
    },
    async list(scope) {
      const rows = await db
        .select()
        .from(schema.functions)
        .where(scopeFilter(schema.functions, scope))
        .orderBy(desc(schema.functions.createdAt));
      return rows.map(toFn);
    },
    async delete(scope, id) {
      await x.write(
        db
          .delete(schema.functions)
          .where(and(scopeFilter(schema.functions, scope), eq(schema.functions.id, id))),
      );
    },
  };
}

function makeAppExtensionRepo(x: Exec): AppExtensionRepo {
  const db = x.db;
  const toApp = (r: typeof schema.appExtensions.$inferSelect): AppExtension => ({
    id: r.id,
    name: r.name,
    target: r.target as AppExtension['target'],
    entryUrl: r.entryUrl,
    fieldTypes: r.fieldTypes ?? undefined,
    active: r.active,
    createdAt: r.createdAt.toISOString(),
  });
  return {
    async create(scope, app) {
      await x.write(
        db.insert(schema.appExtensions).values({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          id: app.id,
          name: app.name,
          target: app.target,
          entryUrl: app.entryUrl,
          fieldTypes: app.fieldTypes ? [...app.fieldTypes] : null,
          active: app.active,
          createdAt: new Date(app.createdAt),
        }),
      );
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.appExtensions)
        .where(and(scopeFilter(schema.appExtensions, scope), eq(schema.appExtensions.id, id)));
      return row ? toApp(row) : null;
    },
    async list(scope) {
      const rows = await db
        .select()
        .from(schema.appExtensions)
        .where(scopeFilter(schema.appExtensions, scope))
        .orderBy(desc(schema.appExtensions.createdAt));
      return rows.map(toApp);
    },
    async delete(scope, id) {
      await x.write(
        db
          .delete(schema.appExtensions)
          .where(and(scopeFilter(schema.appExtensions, scope), eq(schema.appExtensions.id, id))),
      );
    },
  };
}

function makeRoleRepo(x: Exec): RoleRepo {
  const db = x.db;
  return {
    async save(role) {
      const values = {
        spaceId: role.spaceId,
        id: role.id,
        name: role.name,
        description: role.description,
        scopes: [...role.scopes],
        contentGrants: [...role.contentGrants],
        preset: role.preset ?? null,
        updatedAt: new Date(),
      };
      await x.write(
        db
          .insert(schema.roles)
          .values(values)
          .onConflictDoUpdate({
            target: [schema.roles.spaceId, schema.roles.id],
            set: {
              name: values.name,
              description: values.description,
              scopes: values.scopes,
              contentGrants: values.contentGrants,
              preset: values.preset,
              updatedAt: values.updatedAt,
            },
          }),
      );
    },
    async get(spaceId, id) {
      const [row] = await db
        .select()
        .from(schema.roles)
        .where(and(eq(schema.roles.spaceId, spaceId), eq(schema.roles.id, id)));
      return row ? toRole(row) : null;
    },
    async list(spaceId) {
      const rows = await db.select().from(schema.roles).where(eq(schema.roles.spaceId, spaceId));
      return rows.map(toRole);
    },
    async delete(spaceId, id) {
      await x.write(
        db
          .delete(schema.roles)
          .where(and(eq(schema.roles.spaceId, spaceId), eq(schema.roles.id, id))),
      );
    },
  };
}

function makeAuthRepo(x: Exec): AuthRepo {
  const db = x.db;
  return {
    async createApiKey(key) {
      await x.write(
        db.insert(schema.apiKeys).values({
          id: key.id,
          spaceId: key.spaceId,
          kind: key.kind,
          name: key.name,
          hashedToken: key.hashedToken,
          scopes: [...key.scopes],
          revoked: key.revoked,
          roleId: key.roleId,
          expiresAt: key.expiresAt ? new Date(key.expiresAt) : null,
          issuance: key.issuance,
          subject: key.subject,
          clientId: key.clientId,
        }),
      );
    },
    async findByHash(hashedToken) {
      const [row] = await db
        .select()
        .from(schema.apiKeys)
        .where(and(eq(schema.apiKeys.hashedToken, hashedToken), eq(schema.apiKeys.revoked, false)));
      return row ? toApiKey(row) : null;
    },
    async list(spaceId) {
      const rows = await db
        .select()
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.spaceId, spaceId));
      return rows.map(toApiKey);
    },
    async revoke(id) {
      await x.write(
        db.update(schema.apiKeys).set({ revoked: true }).where(eq(schema.apiKeys.id, id)),
      );
    },
    async touchLastUsed(id, at) {
      await x.write(
        db.update(schema.apiKeys).set({ lastUsedAt: at }).where(eq(schema.apiKeys.id, id)),
      );
    },
    async setRole(id, roleId, scopes) {
      await x.write(
        db
          .update(schema.apiKeys)
          .set({ roleId: roleId ?? null, scopes: [...scopes] })
          .where(eq(schema.apiKeys.id, id)),
      );
    },
  };
}

function makeMemberRepo(x: Exec): MemberRepo {
  const db = x.db;
  const m = schema.spaceMembers;
  return {
    async save(member) {
      const values = {
        spaceId: member.spaceId,
        id: member.id,
        email: member.email,
        name: member.name ?? null,
        subject: member.subject ?? null,
        roleId: member.roleId,
        disabled: member.disabled,
        createdAt: new Date(member.createdAt),
        updatedAt: new Date(member.updatedAt),
      };
      await x.write(
        db
          .insert(m)
          .values(values)
          .onConflictDoUpdate({
            target: [m.spaceId, m.id],
            set: {
              email: values.email,
              name: values.name,
              subject: values.subject,
              roleId: values.roleId,
              disabled: values.disabled,
              updatedAt: values.updatedAt,
            },
          }),
      );
    },
    async get(spaceId, id) {
      const [row] = await db
        .select()
        .from(m)
        .where(and(eq(m.spaceId, spaceId), eq(m.id, id)));
      return row ? toMember(row) : null;
    },
    async getByEmail(spaceId, email) {
      const [row] = await db
        .select()
        .from(m)
        .where(and(eq(m.spaceId, spaceId), eq(m.email, email)));
      return row ? toMember(row) : null;
    },
    async list(spaceId) {
      const rows = await db
        .select()
        .from(m)
        .where(eq(m.spaceId, spaceId))
        .orderBy(asc(m.createdAt));
      return rows.map(toMember);
    },
    async delete(spaceId, id) {
      await x.write(db.delete(m).where(and(eq(m.spaceId, spaceId), eq(m.id, id))));
    },
  };
}

function makeDeploymentSettingsRepo(x: Exec): DeploymentSettingsRepo {
  const db = x.db;
  const t = schema.deploymentSettings;
  return {
    async get(key) {
      const [row] = await db.select().from(t).where(eq(t.key, key));
      return row ? { value: row.value, version: row.version } : null;
    },
    async put(key, value, expectedVersion) {
      directOnly(x, 'settings.put');
      if (expectedVersion === null) {
        const rows = await db
          .insert(t)
          .values({ key, value, version: 1, updatedAt: new Date() })
          .onConflictDoNothing()
          .returning({ key: t.key });
        return rows.length > 0;
      }
      const rows = await db
        .update(t)
        .set({ value, version: expectedVersion + 1, updatedAt: new Date() })
        .where(and(eq(t.key, key), eq(t.version, expectedVersion)))
        .returning({ key: t.key });
      return rows.length > 0;
    },
  };
}

function makePreviewTokenRepo(x: Exec): PreviewTokenRepo {
  const db = x.db;
  return {
    async create(record) {
      await x.write(
        db.insert(schema.previewTokens).values({
          id: record.id,
          spaceId: record.spaceId,
          environmentId: record.environmentId,
          entryId: record.entryId,
          hashedToken: record.hashedToken,
          expiresAt: record.expiresAt,
          revoked: record.revoked,
        }),
      );
    },
    async findByHash(hashedToken) {
      const [row] = await db
        .select()
        .from(schema.previewTokens)
        .where(
          and(
            eq(schema.previewTokens.hashedToken, hashedToken),
            eq(schema.previewTokens.revoked, false),
          ),
        );
      return row
        ? {
            id: row.id,
            spaceId: row.spaceId,
            environmentId: row.environmentId,
            entryId: row.entryId,
            hashedToken: row.hashedToken,
            expiresAt: row.expiresAt,
            revoked: row.revoked,
          }
        : null;
    },
    async revoke(id) {
      await x.write(
        db
          .update(schema.previewTokens)
          .set({ revoked: true })
          .where(eq(schema.previewTokens.id, id)),
      );
    },
  };
}

function makePluginRepo(x: Exec): PluginRepo {
  const db = x.db;
  const toPlugin = (r: typeof schema.plugins.$inferSelect): InstalledPlugin => ({
    id: r.id,
    spaceId: r.spaceId,
    manifest: r.manifest,
    checksum: r.checksum,
    bundleKey: r.bundleKey,
    approvedCapabilities: r.approvedCapabilities as InstalledPlugin['approvedCapabilities'],
    enabled: r.enabled,
    installedAt: r.installedAt.toISOString(),
    installedBy: r.installedBy ?? undefined,
  });
  const values = (p: InstalledPlugin) => ({
    spaceId: p.spaceId,
    id: p.id,
    manifest: p.manifest,
    checksum: p.checksum,
    bundleKey: p.bundleKey,
    approvedCapabilities: [...p.approvedCapabilities],
    enabled: p.enabled,
    installedBy: p.installedBy,
    installedAt: new Date(p.installedAt),
  });
  return {
    async create(plugin) {
      await x.write(db.insert(schema.plugins).values(values(plugin)));
    },
    async get(spaceId, id) {
      const [row] = await db
        .select()
        .from(schema.plugins)
        .where(and(eq(schema.plugins.spaceId, spaceId), eq(schema.plugins.id, id)));
      return row ? toPlugin(row) : null;
    },
    async list(spaceId) {
      const rows = await db
        .select()
        .from(schema.plugins)
        .where(eq(schema.plugins.spaceId, spaceId));
      return rows.map(toPlugin);
    },
    async save(plugin) {
      await x.write(
        db
          .insert(schema.plugins)
          .values(values(plugin))
          .onConflictDoUpdate({
            target: [schema.plugins.spaceId, schema.plugins.id],
            set: {
              manifest: plugin.manifest,
              checksum: plugin.checksum,
              bundleKey: plugin.bundleKey,
              approvedCapabilities: [...plugin.approvedCapabilities],
              enabled: plugin.enabled,
            },
          }),
      );
    },
    async delete(spaceId, id) {
      await x.write(
        db
          .delete(schema.plugins)
          .where(and(eq(schema.plugins.spaceId, spaceId), eq(schema.plugins.id, id))),
      );
    },
  };
}

function makeOAuthClientRepo(x: Exec): OAuthClientRepo {
  const db = x.db;
  return {
    async create(client) {
      await x.write(
        db.insert(schema.oauthClients).values({
          id: client.id,
          clientName: client.clientName,
          redirectUris: [...client.redirectUris],
          grantTypes: [...client.grantTypes],
          scopes: [...client.scopes],
          tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
          hashedClientSecret: client.hashedClientSecret,
          clientUri: client.clientUri,
          logoUri: client.logoUri,
          softwareId: client.softwareId,
          createdAt: new Date(client.createdAt),
        }),
      );
    },
    async get(clientId) {
      const [row] = await db
        .select()
        .from(schema.oauthClients)
        .where(eq(schema.oauthClients.id, clientId));
      return row ? toOAuthClient(row) : null;
    },
    async list() {
      const rows = await db.select().from(schema.oauthClients);
      return rows.map(toOAuthClient);
    },
    async delete(clientId) {
      await x.write(db.delete(schema.oauthClients).where(eq(schema.oauthClients.id, clientId)));
    },
  };
}

function makeOAuthGrantRepo(x: Exec): OAuthGrantRepo {
  const db = x.db;
  const values = (record: OAuthGrantRecord) => ({
    id: record.id,
    kind: record.kind,
    clientId: record.clientId,
    hashedCode: record.hashedCode,
    hashedUserCode: record.hashedUserCode,
    status: record.status,
    scopes: [...record.scopes],
    spaceId: record.spaceId,
    subject: record.subject,
    roleId: record.roleId,
    redirectUri: record.redirectUri,
    codeChallenge: record.codeChallenge,
    codeChallengeMethod: record.codeChallengeMethod,
    resource: record.resource,
    parentId: record.parentId,
    issuedKeyIds: record.issuedKeyIds ? [...record.issuedKeyIds] : undefined,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
  });

  return {
    async create(record) {
      await x.write(db.insert(schema.oauthGrants).values(values(record)));
    },
    async findByHash(kind, hashedCode) {
      const [row] = await db
        .select()
        .from(schema.oauthGrants)
        .where(
          and(eq(schema.oauthGrants.kind, kind), eq(schema.oauthGrants.hashedCode, hashedCode)),
        );
      return row ? toOAuthGrant(row) : null;
    },
    async findByUserCodeHash(hashedUserCode) {
      const [row] = await db
        .select()
        .from(schema.oauthGrants)
        .where(eq(schema.oauthGrants.hashedUserCode, hashedUserCode));
      return row ? toOAuthGrant(row) : null;
    },
    async save(record) {
      // Status transitions are the hot path; upsert keeps this one round-trip.
      await x.write(
        db
          .insert(schema.oauthGrants)
          .values(values(record))
          .onConflictDoUpdate({
            target: schema.oauthGrants.id,
            set: {
              status: record.status,
              scopes: [...record.scopes],
              spaceId: record.spaceId,
              subject: record.subject,
              roleId: record.roleId,
            },
          }),
      );
    },
    async listByParent(parentId) {
      const rows = await db
        .select()
        .from(schema.oauthGrants)
        .where(or(eq(schema.oauthGrants.parentId, parentId), eq(schema.oauthGrants.id, parentId)));
      return rows.map(toOAuthGrant);
    },
    async listByClientAndSubject(clientId, subject) {
      const rows = await db
        .select()
        .from(schema.oauthGrants)
        .where(
          and(eq(schema.oauthGrants.clientId, clientId), eq(schema.oauthGrants.subject, subject)),
        );
      return rows.map(toOAuthGrant);
    },
    async deleteExpiredBefore(before) {
      directOnly(x, 'oauthGrants.deleteExpiredBefore');
      const rows = await db
        .delete(schema.oauthGrants)
        .where(lt(schema.oauthGrants.expiresAt, before))
        .returning({ id: schema.oauthGrants.id });
      return rows.length;
    },
  };
}

type SpaceRow = typeof schema.spaces.$inferSelect;

/** One mapping, so `getConfig` and `list` cannot drift apart. */
function toSpaceConfig(row: SpaceRow): SpaceConfig {
  return {
    spaceId: row.id,
    name: row.name,
    defaultLocale: row.defaultLocale,
    locales: row.locales,
    ...(row.fallbacks ? { fallbacks: row.fallbacks } : {}),
    ...(row.workflowSeparateDuties ? { workflowSeparateDuties: true } : {}),
  };
}

function makeSpaceRepo(x: Exec): SpaceRepo {
  const db = x.db;
  return {
    async getConfig(scope) {
      const [row] = await db
        .select()
        .from(schema.spaces)
        .where(eq(schema.spaces.id, scope.spaceId));
      if (!row) return null;
      return toSpaceConfig(row);
    },
    async list() {
      const rows = await db.select().from(schema.spaces).orderBy(asc(schema.spaces.createdAt));
      return rows.map(toSpaceConfig);
    },
    async create(config) {
      await x.write(
        db
          .insert(schema.spaces)
          .values({
            id: config.spaceId,
            name: config.name,
            defaultLocale: config.defaultLocale,
            locales: [...config.locales],
            fallbacks: config.fallbacks ?? null,
            workflowSeparateDuties: config.workflowSeparateDuties ?? false,
          })
          .onConflictDoUpdate({
            target: schema.spaces.id,
            set: {
              name: config.name,
              defaultLocale: config.defaultLocale,
              locales: [...config.locales],
              fallbacks: config.fallbacks ?? null,
            },
          }),
      );
    },
    async setWorkflowSeparateDuties(spaceId, value) {
      await x.write(
        db
          .update(schema.spaces)
          .set({ workflowSeparateDuties: value })
          .where(eq(schema.spaces.id, spaceId)),
      );
    },
    async createEnvironment(spaceId, environmentId, name) {
      const p = schema.environmentPurges;
      await writeAll(x, [
        // Not while a deleted environment of this id is still being purged: it would inherit
        // whatever rows are left (TransactionConflictError).
        db
          .insert(schema.guard)
          .select(
            sql`SELECT NOT EXISTS (SELECT 1 FROM ${p} WHERE ${p.spaceId} = ${spaceId} AND ${p.environmentId} = ${environmentId}) AS ok`,
          ),
        db
          .insert(schema.environments)
          .values({ id: environmentId, spaceId, name })
          .onConflictDoNothing(),
        db.delete(schema.guard),
      ]);
    },
    async listEnvironments(spaceId) {
      const rows = await db
        .select()
        .from(schema.environments)
        .where(eq(schema.environments.spaceId, spaceId))
        .orderBy(asc(schema.environments.createdAt));
      return rows.map((r) => ({ id: r.id, name: r.name }));
    },
    async setAlias(spaceId, alias, targetEnvironmentId, at) {
      const e = schema.environments;
      await writeAll(x, [
        // The target still exists when the alias lands: an environment deleted since the
        // use-case checked aborts the batch (TransactionConflictError) instead of being aliased.
        db
          .insert(schema.guard)
          .select(
            sql`SELECT EXISTS (SELECT 1 FROM ${e} WHERE ${e.spaceId} = ${spaceId} AND ${e.id} = ${targetEnvironmentId}) AS ok`,
          ),
        db
          .insert(schema.environmentAliases)
          .values({ spaceId, alias, targetEnvironmentId, updatedAt: new Date(at) })
          .onConflictDoUpdate({
            target: [schema.environmentAliases.spaceId, schema.environmentAliases.alias],
            set: { targetEnvironmentId, updatedAt: new Date(at) },
          }),
        db.delete(schema.guard),
      ]);
    },
    async resolveName(spaceId, name) {
      const a = schema.environmentAliases;
      const p = schema.environmentPurges;
      // One round trip: this runs on every request that names an environment.
      const [row] = await db.all<{ target: string | null; purging: number }>(sql`
        SELECT
          (SELECT ${a.targetEnvironmentId} FROM ${a} WHERE ${a.spaceId} = ${spaceId} AND ${a.alias} = ${name}) AS target,
          EXISTS (SELECT 1 FROM ${p} WHERE ${p.spaceId} = ${spaceId} AND ${p.environmentId} = ${name}) AS purging
      `);
      return { targetEnvironmentId: row?.target ?? null, purging: row?.purging === 1 };
    },
    async getAlias(spaceId, alias) {
      const [row] = await db
        .select()
        .from(schema.environmentAliases)
        .where(
          and(
            eq(schema.environmentAliases.spaceId, spaceId),
            eq(schema.environmentAliases.alias, alias),
          ),
        );
      return row
        ? {
            alias: row.alias,
            targetEnvironmentId: row.targetEnvironmentId,
            updatedAt: row.updatedAt.toISOString(),
          }
        : null;
    },
    async listAliases(spaceId) {
      const rows = await db
        .select()
        .from(schema.environmentAliases)
        .where(eq(schema.environmentAliases.spaceId, spaceId))
        .orderBy(asc(schema.environmentAliases.alias));
      return rows.map((r) => ({
        alias: r.alias,
        targetEnvironmentId: r.targetEnvironmentId,
        updatedAt: r.updatedAt.toISOString(),
      }));
    },
    async deleteAlias(spaceId, alias) {
      await x.write(
        db
          .delete(schema.environmentAliases)
          .where(
            and(
              eq(schema.environmentAliases.spaceId, spaceId),
              eq(schema.environmentAliases.alias, alias),
            ),
          ),
      );
    },
    async deleteEnvironment(spaceId, environmentId, events, audit) {
      // One atomic batch: the registry row goes (the environment stops resolving), a purge marker
      // takes its place, and the events and audit row ride along. The rows themselves go in
      // bounded steps afterwards (purgeEnvironmentStep): D1 refuses one statement that modifies
      // hundreds of thousands of rows.
      const a = schema.environmentAliases;
      const at = new Date(audit.at);
      await writeAll(x, [
        // No alias points at it when the batch runs: one set since the use-case checked aborts
        // the whole deletion (TransactionConflictError) rather than leaving the alias dangling.
        db
          .insert(schema.guard)
          .select(
            sql`SELECT NOT EXISTS (SELECT 1 FROM ${a} WHERE ${a.spaceId} = ${spaceId} AND ${a.targetEnvironmentId} = ${environmentId}) AS ok`,
          ),
        db.delete(schema.guard),
        db
          .insert(schema.environmentPurges)
          .values({ spaceId, environmentId, requestedAt: at, nudgedAt: at })
          .onConflictDoNothing(),
        db
          .delete(schema.environments)
          .where(
            and(
              eq(schema.environments.spaceId, spaceId),
              eq(schema.environments.id, environmentId),
            ),
          ),
        ...insertChunks(schema.outbox, events, (chunk) =>
          db.insert(schema.outbox).values(
            chunk.map((event) => ({
              id: event.id,
              type: event.type,
              payload: event,
              occurredAt: new Date(event.occurredAt),
            })),
          ),
        ),
        db.insert(schema.auditLog).values({
          id: audit.id,
          spaceId: audit.spaceId,
          environmentId: audit.environmentId ?? null,
          actor: audit.actor,
          action: audit.action,
          targetType: audit.targetType ?? null,
          targetId: audit.targetId ?? null,
          status: audit.status,
          at: new Date(audit.at),
        }),
      ]);
    },
    async purgeEnvironmentStep(spaceId, environmentId, rowsPerTable, at) {
      directOnly(x, 'spaces.purgeEnvironmentStep');
      const scope = { spaceId, environmentId };
      const p = schema.environmentPurges;
      // One bounded DELETE per table (by rowid, so each statement touches at most rowsPerTable
      // rows), plus the progress mark the stall sweep reads. One round trip. Every DELETE needs the
      // purge marker: a late or duplicate step, run after the purge finished and the id was used
      // again, must find nothing to do rather than empty the new environment.
      const marked = sql`EXISTS (SELECT 1 FROM ${p} WHERE ${p.spaceId} = ${spaceId} AND ${p.environmentId} = ${environmentId})`;
      const statements = [
        ...ENVIRONMENT_SCOPED_TABLES.map((table) =>
          db
            .delete(table)
            .where(
              sql`${marked} AND rowid IN (SELECT rowid FROM ${table} WHERE ${scopeFilter(table, scope)} LIMIT ${rowsPerTable})`,
            ),
        ),
        db
          .update(p)
          .set({ nudgedAt: at })
          .where(and(eq(p.spaceId, spaceId), eq(p.environmentId, environmentId))),
      ];
      let results: unknown[];
      try {
        results = await db.batch(statements as unknown as [Query, ...Query[]]);
      } catch (err) {
        throw mapD1Error(err);
      }
      // Every result but the last (the progress mark) is a table's delete.
      return results
        .slice(0, -1)
        .reduce<number>(
          (n, r) => n + ((r as { meta?: { changes?: number } }).meta?.changes ?? 0),
          0,
        );
    },
    async finishEnvironmentPurge(spaceId, environmentId) {
      const p = schema.environmentPurges;
      await x.write(
        db.delete(p).where(and(eq(p.spaceId, spaceId), eq(p.environmentId, environmentId))),
      );
    },
    async claimStalledPurges(staleBefore, at, limit) {
      directOnly(x, 'spaces.claimStalledPurges');
      const p = schema.environmentPurges;
      const rows = await db
        .update(p)
        .set({ nudgedAt: at })
        .where(
          sql`rowid IN (SELECT rowid FROM ${p} WHERE ${p.nudgedAt} < ${staleBefore.getTime()} LIMIT ${limit})`,
        )
        .returning({ spaceId: p.spaceId, environmentId: p.environmentId });
      return rows;
    },
  };
}

/**
 * Every table whose rows belong to one environment, cleared when it is deleted. Not the audit log:
 * it is a hash chain (and a record of what happened in the environment), so it stays.
 */
const ENVIRONMENT_SCOPED_TABLES = [
  schema.contentTypes,
  schema.entries,
  schema.entryUniqueValues,
  schema.entryVersions,
  schema.entryPublished,
  schema.assets,
  schema.assetPublished,
  schema.references,
  schema.agentRuns,
  schema.aiActions,
  schema.functions,
  schema.appExtensions,
  schema.releases,
  schema.releaseItems,
  schema.scheduledActions,
  schema.agentReviews,
  schema.agentSchedules,
  schema.comments,
  schema.tasks,
  schema.workflowDefinitions,
  schema.workflowVersions,
  schema.workflowRuns,
  schema.workflowNodeRuns,
  schema.workflowTimeline,
  schema.workflowTasks,
  schema.entryWorkflowState,
  schema.conceptSchemes,
  schema.concepts,
  schema.tags,
  schema.entryMetadata,
  schema.previewTokens,
  schema.bulkJobs,
  schema.bulkJobChunks,
] as const;

type ReleaseRow = typeof schema.releases.$inferSelect;
const toRelease = (r: ReleaseRow): Release => ({
  id: r.id,
  title: r.title,
  description: r.description ?? undefined,
  status: r.status,
  createdAt: r.createdAt.toISOString(),
  publishedAt: r.publishedAt?.toISOString(),
});

function makeReleaseRepo(x: Exec): ReleaseRepo {
  const db = x.db;
  return {
    async create(scope, release) {
      await x.write(
        db.insert(schema.releases).values({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          id: release.id,
          title: release.title,
          description: release.description ?? null,
          status: release.status,
          createdAt: new Date(release.createdAt),
          publishedAt: release.publishedAt ? new Date(release.publishedAt) : null,
        }),
      );
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.releases)
        .where(and(scopeFilter(schema.releases, scope), eq(schema.releases.id, id)));
      return row ? toRelease(row) : null;
    },
    async list(scope) {
      const rows = await db
        .select()
        .from(schema.releases)
        .where(scopeFilter(schema.releases, scope))
        .orderBy(desc(schema.releases.createdAt));
      return rows.map(toRelease);
    },
    async save(scope, release) {
      await x.write(
        db
          .update(schema.releases)
          .set({
            title: release.title,
            description: release.description ?? null,
            status: release.status,
            publishedAt: release.publishedAt ? new Date(release.publishedAt) : null,
          })
          .where(and(scopeFilter(schema.releases, scope), eq(schema.releases.id, release.id))),
      );
    },
    async delete(scope, id) {
      await writeAll(x, [
        db
          .delete(schema.releaseItems)
          .where(
            and(scopeFilter(schema.releaseItems, scope), eq(schema.releaseItems.releaseId, id)),
          ),
        db
          .delete(schema.releases)
          .where(and(scopeFilter(schema.releases, scope), eq(schema.releases.id, id))),
      ]);
    },
    async addItem(scope, releaseId, item) {
      await x.write(
        db
          .insert(schema.releaseItems)
          .values({
            spaceId: scope.spaceId,
            environmentId: scope.environmentId,
            releaseId,
            entityType: item.entityType,
            entityId: item.entityId,
            action: item.action,
          })
          .onConflictDoUpdate({
            target: [
              schema.releaseItems.spaceId,
              schema.releaseItems.environmentId,
              schema.releaseItems.releaseId,
              schema.releaseItems.entityId,
            ],
            set: { action: item.action, entityType: item.entityType },
          }),
      );
    },
    async removeItem(scope, releaseId, entityId) {
      await x.write(
        db
          .delete(schema.releaseItems)
          .where(
            and(
              scopeFilter(schema.releaseItems, scope),
              eq(schema.releaseItems.releaseId, releaseId),
              eq(schema.releaseItems.entityId, entityId),
            ),
          ),
      );
    },
    async listItems(scope, releaseId) {
      const rows = await db
        .select()
        .from(schema.releaseItems)
        .where(
          and(
            scopeFilter(schema.releaseItems, scope),
            eq(schema.releaseItems.releaseId, releaseId),
          ),
        );
      return rows.map((r) => ({
        entityType: r.entityType,
        entityId: r.entityId,
        action: r.action,
      }));
    },
  };
}

type ScheduledRow = typeof schema.scheduledActions.$inferSelect;
const toScheduled = (r: ScheduledRow): ScheduledAction => ({
  id: r.id,
  action: r.action,
  entityType: r.entityType,
  entityId: r.entityId,
  scheduledFor: r.scheduledFor.toISOString(),
  status: r.status,
  createdAt: r.createdAt.toISOString(),
  executedAt: r.executedAt?.toISOString(),
  error: r.error ?? undefined,
});

function makeAgentReviewRepo(x: Exec): AgentReviewRepo {
  const db = x.db;
  type Row = typeof schema.agentReviews.$inferSelect;
  const toReview = (r: Row): AgentReview => ({
    id: r.id,
    workflow: r.workflow,
    entryId: r.entryId,
    proposed: r.proposed,
    notes: r.notes,
    status: r.status,
    awaiting: r.awaiting,
    createdAt: r.createdAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString(),
    decidedBy: r.decidedBy ?? undefined,
    appliedAt: r.appliedAt?.toISOString(),
  });
  return {
    async create(scope, review) {
      await x.write(
        db.insert(schema.agentReviews).values({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          id: review.id,
          workflow: review.workflow,
          entryId: review.entryId,
          proposed: review.proposed,
          notes: [...review.notes],
          status: review.status,
          awaiting: review.awaiting,
          createdAt: new Date(review.createdAt),
          decidedAt: review.decidedAt ? new Date(review.decidedAt) : null,
          decidedBy: review.decidedBy ?? null,
          appliedAt: review.appliedAt ? new Date(review.appliedAt) : null,
        }),
      );
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.agentReviews)
        .where(and(scopeFilter(schema.agentReviews, scope), eq(schema.agentReviews.id, id)));
      return row ? toReview(row) : null;
    },
    async list(scope, query) {
      const conditions = [scopeFilter(schema.agentReviews, scope)];
      if (query?.status) conditions.push(eq(schema.agentReviews.status, query.status));
      if (query?.entryId) conditions.push(eq(schema.agentReviews.entryId, query.entryId));
      const rows = await db
        .select()
        .from(schema.agentReviews)
        .where(and(...conditions))
        .orderBy(desc(schema.agentReviews.createdAt), asc(schema.agentReviews.id))
        .limit(Math.min(query?.limit ?? 100, 1000));
      return rows.map(toReview);
    },
    async decide(scope, id, decision) {
      directOnly(x, 'agentReviews.decide');
      const updated = await db
        .update(schema.agentReviews)
        .set({
          status: decision.status,
          decidedAt: new Date(decision.decidedAt),
          decidedBy: decision.decidedBy ?? null,
        })
        .where(
          and(
            scopeFilter(schema.agentReviews, scope),
            eq(schema.agentReviews.id, id),
            eq(schema.agentReviews.status, 'pending'),
          ),
        )
        .returning({ id: schema.agentReviews.id });
      return updated.length > 0;
    },
    async markAwaiting(scope, id) {
      directOnly(x, 'agentReviews.markAwaiting');
      const armed = await db
        .update(schema.agentReviews)
        .set({ awaiting: true })
        .where(
          and(
            scopeFilter(schema.agentReviews, scope),
            eq(schema.agentReviews.id, id),
            eq(schema.agentReviews.status, 'pending'),
            eq(schema.agentReviews.awaiting, false),
          ),
        )
        .returning({ id: schema.agentReviews.id });
      if (armed.length > 0) return 'armed';
      const [row] = await db
        .select({ status: schema.agentReviews.status })
        .from(schema.agentReviews)
        .where(and(scopeFilter(schema.agentReviews, scope), eq(schema.agentReviews.id, id)));
      return row?.status ?? 'pending';
    },
    async clearAwaiting(scope, id) {
      await x.write(
        db
          .update(schema.agentReviews)
          .set({ awaiting: false })
          .where(and(scopeFilter(schema.agentReviews, scope), eq(schema.agentReviews.id, id))),
      );
    },
    async markApplied(scope, id, at) {
      directOnly(x, 'agentReviews.markApplied');
      const won = await db
        .update(schema.agentReviews)
        .set({ appliedAt: new Date(at) })
        .where(
          and(
            scopeFilter(schema.agentReviews, scope),
            eq(schema.agentReviews.id, id),
            isNull(schema.agentReviews.appliedAt),
          ),
        )
        .returning({ id: schema.agentReviews.id });
      return won.length > 0;
    },
    async clearApplied(scope, id) {
      await x.write(
        db
          .update(schema.agentReviews)
          .set({ appliedAt: null })
          .where(and(scopeFilter(schema.agentReviews, scope), eq(schema.agentReviews.id, id))),
      );
    },
  };
}

function makeAgentScheduleRepo(x: Exec): AgentScheduleRepo {
  const db = x.db;
  type Row = typeof schema.agentSchedules.$inferSelect;
  const toSchedule = (r: Row): AgentSchedule => ({
    id: r.id,
    workflow: r.workflow,
    contentTypeApiId: r.contentTypeApiId ?? undefined,
    cron: r.cron,
    enabled: r.enabled,
    autoApply: r.autoApply,
    lastRunAt: r.lastRunAt?.toISOString(),
    cursorEntryId: r.cursorEntryId ?? undefined,
    nextRunAt: r.nextRunAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
  });
  return {
    async create(scope, s) {
      await x.write(
        db.insert(schema.agentSchedules).values({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          id: s.id,
          workflow: s.workflow,
          contentTypeApiId: s.contentTypeApiId ?? null,
          cron: s.cron,
          enabled: s.enabled,
          autoApply: s.autoApply,
          lastRunAt: s.lastRunAt ? new Date(s.lastRunAt) : null,
          cursorEntryId: s.cursorEntryId ?? null,
          nextRunAt: new Date(s.nextRunAt),
          createdAt: new Date(s.createdAt),
        }),
      );
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.agentSchedules)
        .where(and(scopeFilter(schema.agentSchedules, scope), eq(schema.agentSchedules.id, id)));
      return row ? toSchedule(row) : null;
    },
    async list(scope) {
      const rows = await db
        .select()
        .from(schema.agentSchedules)
        .where(scopeFilter(schema.agentSchedules, scope))
        .orderBy(asc(schema.agentSchedules.createdAt), asc(schema.agentSchedules.id));
      return rows.map(toSchedule);
    },
    async save(scope, s) {
      await x.write(
        db
          .update(schema.agentSchedules)
          .set({
            workflow: s.workflow,
            contentTypeApiId: s.contentTypeApiId ?? null,
            cron: s.cron,
            enabled: s.enabled,
            autoApply: s.autoApply,
            lastRunAt: s.lastRunAt ? new Date(s.lastRunAt) : null,
            cursorEntryId: s.cursorEntryId ?? null,
            nextRunAt: new Date(s.nextRunAt),
          })
          .where(
            and(scopeFilter(schema.agentSchedules, scope), eq(schema.agentSchedules.id, s.id)),
          ),
      );
    },
    async delete(scope, id) {
      await x.write(
        db
          .delete(schema.agentSchedules)
          .where(and(scopeFilter(schema.agentSchedules, scope), eq(schema.agentSchedules.id, id))),
      );
    },
    async claimNextRun(scope, id, expectedNextRunAt, nextRunAt) {
      directOnly(x, 'agentSchedules.claimNextRun');
      const claimed = await db
        .update(schema.agentSchedules)
        .set({ nextRunAt: new Date(nextRunAt) })
        .where(
          and(
            scopeFilter(schema.agentSchedules, scope),
            eq(schema.agentSchedules.id, id),
            eq(schema.agentSchedules.nextRunAt, new Date(expectedNextRunAt)),
          ),
        )
        .returning({ id: schema.agentSchedules.id });
      return claimed.length > 0;
    },
    async saveRunState(scope, id, state) {
      await x.write(
        db
          .update(schema.agentSchedules)
          .set({
            lastRunAt: new Date(state.lastRunAt),
            cursorEntryId: state.cursorEntryId ?? null,
          })
          .where(and(scopeFilter(schema.agentSchedules, scope), eq(schema.agentSchedules.id, id))),
      );
    },
    async findDue(now, limit = 100): Promise<ScopedAgentSchedule[]> {
      const rows = await db
        .select()
        .from(schema.agentSchedules)
        .where(
          and(
            eq(schema.agentSchedules.enabled, true),
            lte(schema.agentSchedules.nextRunAt, new Date(now)),
            // Only in an environment that still exists: a deleted one's rows linger until purged.
            registered(schema.agentSchedules),
          ),
        )
        .orderBy(asc(schema.agentSchedules.nextRunAt))
        .limit(limit);
      return rows.map((r) => ({
        scope: { spaceId: r.spaceId, environmentId: r.environmentId },
        schedule: toSchedule(r),
      }));
    },
  };
}

function makeScheduledActionRepo(x: Exec): ScheduledActionRepo {
  const db = x.db;
  const rowValues = (scope: Scope, a: ScheduledAction) => ({
    spaceId: scope.spaceId,
    environmentId: scope.environmentId,
    id: a.id,
    action: a.action,
    entityType: a.entityType,
    entityId: a.entityId,
    scheduledFor: new Date(a.scheduledFor),
    status: a.status,
    createdAt: new Date(a.createdAt),
    executedAt: a.executedAt ? new Date(a.executedAt) : null,
    error: a.error ?? null,
  });
  return {
    async create(scope, action) {
      await x.write(db.insert(schema.scheduledActions).values(rowValues(scope, action)));
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.scheduledActions)
        .where(
          and(scopeFilter(schema.scheduledActions, scope), eq(schema.scheduledActions.id, id)),
        );
      return row ? toScheduled(row) : null;
    },
    async list(scope, query) {
      const conditions = [scopeFilter(schema.scheduledActions, scope)];
      if (query?.status)
        conditions.push(eq(schema.scheduledActions.status, query.status as ScheduledRow['status']));
      const rows = await db
        .select()
        .from(schema.scheduledActions)
        .where(and(...conditions))
        .orderBy(asc(schema.scheduledActions.scheduledFor));
      return rows.map(toScheduled);
    },
    async save(scope, action) {
      await x.write(
        db
          .update(schema.scheduledActions)
          .set({
            status: action.status,
            executedAt: action.executedAt ? new Date(action.executedAt) : null,
            error: action.error ?? null,
          })
          .where(
            and(
              scopeFilter(schema.scheduledActions, scope),
              eq(schema.scheduledActions.id, action.id),
            ),
          ),
      );
    },
    async findDue(now, limit = 100): Promise<ScopedScheduledAction[]> {
      const rows = await db
        .select()
        .from(schema.scheduledActions)
        .where(
          and(
            eq(schema.scheduledActions.status, 'pending'),
            lte(schema.scheduledActions.scheduledFor, new Date(now)),
            // Only in an environment that still exists: a deleted one's rows linger until purged.
            registered(schema.scheduledActions),
          ),
        )
        .orderBy(asc(schema.scheduledActions.scheduledFor))
        .limit(limit);
      return rows.map((r) => ({
        scope: { spaceId: r.spaceId, environmentId: r.environmentId },
        action: toScheduled(r),
      }));
    },
  };
}

function makeCommentRepo(x: Exec): CommentRepo {
  const db = x.db;
  const toComment = (r: typeof schema.comments.$inferSelect): Comment => ({
    id: r.id,
    entryId: r.entryId,
    parentId: r.parentId,
    author: r.author,
    body: r.body,
    createdAt: r.createdAt.toISOString(),
  });
  return {
    async create(scope, comment) {
      await x.write(
        db.insert(schema.comments).values({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          id: comment.id,
          entryId: comment.entryId,
          parentId: comment.parentId,
          author: comment.author,
          body: comment.body,
          createdAt: new Date(comment.createdAt),
        }),
      );
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.comments)
        .where(and(scopeFilter(schema.comments, scope), eq(schema.comments.id, id)));
      return row ? toComment(row) : null;
    },
    async listForEntry(scope, entryId) {
      const rows = await db
        .select()
        .from(schema.comments)
        .where(and(scopeFilter(schema.comments, scope), eq(schema.comments.entryId, entryId)))
        .orderBy(asc(schema.comments.createdAt));
      return rows.map(toComment);
    },
    async delete(scope, id) {
      await x.write(
        db
          .delete(schema.comments)
          .where(and(scopeFilter(schema.comments, scope), eq(schema.comments.id, id))),
      );
    },
  };
}

function makeTaskRepo(x: Exec): TaskRepo {
  const db = x.db;
  const toTask = (r: typeof schema.tasks.$inferSelect): Task => ({
    id: r.id,
    entryId: r.entryId,
    assignee: r.assignee,
    body: r.body,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString(),
  });
  const values = (scope: Scope, t: Task) => ({
    spaceId: scope.spaceId,
    environmentId: scope.environmentId,
    id: t.id,
    entryId: t.entryId,
    assignee: t.assignee,
    body: t.body,
    status: t.status,
    createdAt: new Date(t.createdAt),
    resolvedAt: t.resolvedAt ? new Date(t.resolvedAt) : null,
  });
  return {
    async create(scope, task) {
      await x.write(db.insert(schema.tasks).values(values(scope, task)));
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.tasks)
        .where(and(scopeFilter(schema.tasks, scope), eq(schema.tasks.id, id)));
      return row ? toTask(row) : null;
    },
    async listForEntry(scope, entryId) {
      const rows = await db
        .select()
        .from(schema.tasks)
        .where(and(scopeFilter(schema.tasks, scope), eq(schema.tasks.entryId, entryId)))
        .orderBy(asc(schema.tasks.createdAt));
      return rows.map(toTask);
    },
    async save(scope, task) {
      await x.write(
        db
          .update(schema.tasks)
          .set({
            assignee: task.assignee,
            body: task.body,
            status: task.status,
            resolvedAt: task.resolvedAt ? new Date(task.resolvedAt) : null,
          })
          .where(and(scopeFilter(schema.tasks, scope), eq(schema.tasks.id, task.id))),
      );
    },
    async delete(scope, id) {
      await x.write(
        db
          .delete(schema.tasks)
          .where(and(scopeFilter(schema.tasks, scope), eq(schema.tasks.id, id))),
      );
    },
  };
}

function makeWorkflowRepo(x: Exec): WorkflowRepo {
  const db = x.db;
  const toDef = (r: typeof schema.workflowDefinitions.$inferSelect): WorkflowDefinition => ({
    id: r.id,
    name: r.name,
    steps: r.steps as WorkflowStep[],
  });
  return {
    async saveDefinition(scope, def) {
      const values = {
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        id: def.id,
        name: def.name,
        steps: [...def.steps],
      };
      await x.write(
        db
          .insert(schema.workflowDefinitions)
          .values(values)
          .onConflictDoUpdate({
            target: [
              schema.workflowDefinitions.spaceId,
              schema.workflowDefinitions.environmentId,
              schema.workflowDefinitions.id,
            ],
            set: { name: values.name, steps: values.steps },
          }),
      );
    },
    async getDefinition(scope, id) {
      const [row] = await db
        .select()
        .from(schema.workflowDefinitions)
        .where(
          and(
            scopeFilter(schema.workflowDefinitions, scope),
            eq(schema.workflowDefinitions.id, id),
          ),
        );
      return row ? toDef(row) : null;
    },
    async listDefinitions(scope) {
      const rows = await db
        .select()
        .from(schema.workflowDefinitions)
        .where(scopeFilter(schema.workflowDefinitions, scope));
      return rows.map(toDef);
    },
    async deleteDefinition(scope, id) {
      await x.write(
        db
          .delete(schema.workflowDefinitions)
          .where(
            and(
              scopeFilter(schema.workflowDefinitions, scope),
              eq(schema.workflowDefinitions.id, id),
            ),
          ),
      );
    },
    async getState(scope, entryId) {
      const [row] = await db
        .select()
        .from(schema.entryWorkflowState)
        .where(
          and(
            scopeFilter(schema.entryWorkflowState, scope),
            eq(schema.entryWorkflowState.entryId, entryId),
          ),
        );
      return row
        ? { entryId: row.entryId, workflowId: row.workflowId, currentStepId: row.currentStepId }
        : null;
    },
    async saveState(scope, state) {
      const values = {
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        entryId: state.entryId,
        workflowId: state.workflowId,
        currentStepId: state.currentStepId,
      };
      await x.write(
        db
          .insert(schema.entryWorkflowState)
          .values(values)
          .onConflictDoUpdate({
            target: [
              schema.entryWorkflowState.spaceId,
              schema.entryWorkflowState.environmentId,
              schema.entryWorkflowState.entryId,
            ],
            set: { workflowId: values.workflowId, currentStepId: values.currentStepId },
          }),
      );
    },
  };
}

/** Attempts at the next-version insert before a concurrent-publish race is surfaced. */
const PUBLISH_VERSION_ATTEMPTS = 5;

function makeWorkflowGraphRepo(x: Exec): WorkflowGraphRepo {
  const db = x.db;
  const d = schema.workflowDefinitions;
  const v = schema.workflowVersions;
  const toRecord = (
    r: typeof d.$inferSelect,
    latestVersion: number | null,
  ): WorkflowGraphRecord => ({
    id: r.id,
    name: r.name,
    description: r.description,
    contentTypes: r.contentTypes,
    graph: r.graph ?? null,
    gatesPublish: r.gatesPublish,
    steps: r.steps as WorkflowStep[],
    updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
    latestVersion,
  });
  const toVersion = (r: typeof v.$inferSelect): WorkflowVersion => ({
    ...r.definition,
    id: r.workflowId,
    version: r.version,
    publishedAt: r.publishedAt.toISOString(),
    ...(r.publishedBy ? { publishedBy: r.publishedBy } : {}),
  });
  const versionFilter = (scope: Scope, workflowId: string) =>
    and(scopeFilter(v, scope), eq(v.workflowId, workflowId));
  // One grouped query for every listed workflow's latest version (no N+1).
  const latestByWorkflow = async (scope: Scope, ids: readonly string[]) => {
    if (ids.length === 0) return new Map<string, number>();
    const rows = await selectChunked(
      ids,
      (chunk) =>
        db
          .select({
            workflowId: v.workflowId,
            latest: sql<number>`max(${v.version})`.mapWith(Number),
          })
          .from(v)
          .where(and(scopeFilter(v, scope), inArray(v.workflowId, chunk)))
          .groupBy(v.workflowId),
      1,
      RESERVED,
    );
    return new Map(rows.map((r) => [r.workflowId, r.latest]));
  };

  return {
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(d)
        .where(and(scopeFilter(d, scope), eq(d.id, id)));
      if (!row) return null;
      const latest = await latestByWorkflow(scope, [id]);
      return toRecord(row, latest.get(id) ?? null);
    },
    async list(scope) {
      const rows = await db.select().from(d).where(scopeFilter(d, scope));
      const latest = await latestByWorkflow(
        scope,
        rows.map((r) => r.id),
      );
      return rows.map((r) => toRecord(r, latest.get(r.id) ?? null));
    },
    async saveDraft(scope, draft) {
      const values = {
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        id: draft.id,
        name: draft.name,
        steps: draft.steps.map((s) => ({ ...s })),
        description: draft.description,
        contentTypes: [...draft.contentTypes],
        graph: draft.graph,
        gatesPublish: draft.gatesPublish ?? false,
        updatedAt: new Date(draft.updatedAt),
      };
      await x.write(
        db
          .insert(d)
          .values(values)
          .onConflictDoUpdate({
            target: [d.spaceId, d.environmentId, d.id],
            set: {
              name: values.name,
              steps: values.steps,
              description: values.description,
              contentTypes: values.contentTypes,
              graph: values.graph,
              gatesPublish: values.gatesPublish,
              updatedAt: values.updatedAt,
            },
          }),
      );
    },
    async publishVersion(scope, definition, meta) {
      directOnly(x, 'workflowGraphs.publishVersion');
      const stored: WorkflowGraphDefinition = {
        id: definition.id,
        name: definition.name,
        description: definition.description,
        contentTypes: [...definition.contentTypes],
        graph: definition.graph,
        ...(definition.gatesPublish !== undefined ? { gatesPublish: definition.gatesPublish } : {}),
      };
      // The atomic next-version insert: the number is
      // computed inside the INSERT, so it never reads a stale max. Two concurrent publishes can
      // still compute the same number (in practice D1 serializes writes); the PK rejects the loser and
      // it retries.
      for (let attempt = 1; ; attempt++) {
        try {
          const [row] = await db
            .insert(v)
            .values({
              spaceId: scope.spaceId,
              environmentId: scope.environmentId,
              workflowId: definition.id,
              version: sql`(select coalesce(max(${v.version}), 0) + 1 from ${v} where ${versionFilter(scope, definition.id)})`,
              definition: stored,
              publishedAt: new Date(meta.publishedAt),
              publishedBy: meta.publishedBy ?? null,
            })
            .returning();
          if (!row) throw new Error('workflow_versions insert returned no row');
          return toVersion(row);
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          if (attempt >= PUBLISH_VERSION_ATTEMPTS) {
            throw new ConflictError('Another publish of this workflow won the race; retry', {
              workflowId: definition.id,
            });
          }
        }
      }
    },
    async listVersions(scope, workflowId) {
      const rows = await db
        .select()
        .from(v)
        .where(versionFilter(scope, workflowId))
        .orderBy(desc(v.version));
      return rows.map(toVersion);
    },
    async getVersion(scope, workflowId, version) {
      const [row] = await db
        .select()
        .from(v)
        .where(and(versionFilter(scope, workflowId), eq(v.version, version)));
      return row ? toVersion(row) : null;
    },
    async getLatestVersion(scope, workflowId) {
      const [row] = await db
        .select()
        .from(v)
        .where(versionFilter(scope, workflowId))
        .orderBy(desc(v.version))
        .limit(1);
      return row ? toVersion(row) : null;
    },
  };
}

const ms = (d: Date) => d.getTime();
const iso = (d: Date | null) => (d ? d.toISOString() : null);

function makeWorkflowRunRepo(x: Exec): WorkflowRunRepo {
  const db = x.db;
  const r = schema.workflowRuns;
  const nr = schema.workflowNodeRuns;
  const tl = schema.workflowTimeline;
  const toRun = (row: typeof r.$inferSelect): WorkflowRun => ({
    id: row.id,
    workflowId: row.workflowId,
    version: row.version,
    generation: row.generation,
    entryId: row.entryId,
    contentTypeApiId: row.contentTypeApiId,
    status: row.status as WorkflowRunStatus,
    reason: row.reason,
    plan: row.plan,
    nodes: row.nodes,
    vars: row.vars,
    input: row.input,
    seq: row.seq,
    waitingOn: row.waitingOn,
    waitingAt: row.waitingAt,
    waitingSince: iso(row.waitingSince),
    waitingDue: iso(row.waitingDue),
    waitingFor: row.waitingFor,
    stoppedAt: row.stoppedAt,
    earlyEvents: row.earlyEvents ?? [],
    startedBy: row.startedBy,
    triggerEventId: row.triggerEventId,
    instanceId: row.instanceId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    logSeq: row.logSeq,
    rev: row.rev,
  });
  const toRow = (scope: Scope, run: WorkflowRun) => ({
    spaceId: scope.spaceId,
    environmentId: scope.environmentId,
    id: run.id,
    workflowId: run.workflowId,
    version: run.version,
    generation: run.generation,
    entryId: run.entryId,
    contentTypeApiId: run.contentTypeApiId,
    status: run.status,
    reason: run.reason,
    plan: run.plan,
    nodes: run.nodes,
    vars: run.vars,
    input: run.input,
    seq: run.seq,
    waitingOn: run.waitingOn,
    waitingAt: run.waitingAt,
    waitingSince: run.waitingSince ? new Date(run.waitingSince) : null,
    waitingDue: run.waitingDue ? new Date(run.waitingDue) : null,
    waitingFor: run.waitingFor,
    stoppedAt: run.stoppedAt,
    earlyEvents: [...run.earlyEvents],
    startedBy: run.startedBy,
    triggerEventId: run.triggerEventId,
    instanceId: run.instanceId,
    logSeq: run.logSeq,
    rev: run.rev,
    createdAt: new Date(run.createdAt),
    updatedAt: new Date(run.updatedAt),
  });
  const toNodeRun = (row: typeof nr.$inferSelect): WorkflowNodeRunRecord => ({
    runId: row.runId,
    generation: row.generation,
    nodeId: row.nodeId,
    run: row.run,
    nodeType: row.nodeType,
    model: row.model,
    ranBy: row.ranBy,
    status: row.status as WorkflowNodeRunRecord['status'],
    summary: row.summary,
    output: row.output ?? null,
    error: row.error,
    startedAt: ms(row.startedAt),
    endedAt: ms(row.endedAt),
    durationMs: row.durationMs,
  });
  return {
    async create(scope, run) {
      try {
        await x.write(db.insert(r).values(toRow(scope, run)));
      } catch (err) {
        if (isUniqueViolation(err) || err instanceof ConflictError) {
          throw new ConflictError(`Workflow run ${run.id} exists`, { runId: run.id });
        }
        throw err;
      }
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(r)
        .where(and(scopeFilter(r, scope), eq(r.id, id)));
      return row ? toRun(row) : null;
    },
    async list(scope, query = {}) {
      const conds: SQL[] = [scopeFilter(r, scope) as SQL];
      if (query.entryId) conds.push(eq(r.entryId, query.entryId));
      if (query.workflowId) conds.push(eq(r.workflowId, query.workflowId));
      if (query.status) conds.push(eq(r.status, query.status));
      const rows = await db
        .select()
        .from(r)
        .where(and(...conds))
        .orderBy(desc(r.createdAt), desc(r.id))
        .limit(Math.min(Math.max(query.limit ?? 50, 1), 200));
      return rows.map(toRun);
    },
    async save(scope, run, expectedRev) {
      const { spaceId: _s, environmentId: _e, id: _i, createdAt: _c, ...set } = toRow(scope, run);
      const cas = and(scopeFilter(r, scope), eq(r.id, run.id), eq(r.rev, expectedRev));
      if (x.inUnit) {
        // Unit of work: the outcome is the precondition; a lost race aborts the
        // whole unit at commit with TransactionConflictError.
        await x.write(db.update(r).set(set).where(cas));
        x.expectChanged(1);
        return true;
      }
      const rows = await db.update(r).set(set).where(cas).returning({ id: r.id });
      return rows.length === 1;
    },
    async recordNodeRun(scope, rec) {
      await x.write(
        db
          .insert(nr)
          .values({
            spaceId: scope.spaceId,
            environmentId: scope.environmentId,
            runId: rec.runId,
            generation: rec.generation,
            nodeId: rec.nodeId,
            run: rec.run,
            nodeType: rec.nodeType,
            model: rec.model,
            ranBy: rec.ranBy,
            status: rec.status,
            summary: rec.summary,
            output: rec.output ?? null,
            error: rec.error,
            startedAt: new Date(rec.startedAt),
            endedAt: new Date(rec.endedAt),
            durationMs: rec.durationMs,
          })
          .onConflictDoNothing(),
      );
    },
    async listNodeRuns(scope, runId) {
      const rows = await db
        .select()
        .from(nr)
        .where(and(scopeFilter(nr, scope), eq(nr.runId, runId)))
        .orderBy(asc(nr.endedAt), asc(nr.generation), asc(nr.run));
      return rows.map(toNodeRun);
    },
    async markNodeRunRolledBack(scope, k) {
      directOnly(x, 'workflowRuns.markNodeRunRolledBack');
      const rows = await db
        .update(nr)
        .set({ status: 'rolled_back' })
        .where(
          and(
            scopeFilter(nr, scope),
            eq(nr.runId, k.runId),
            eq(nr.generation, k.generation),
            eq(nr.nodeId, k.nodeId),
            eq(nr.run, k.run),
            eq(nr.status, 'succeeded'),
          ),
        )
        .returning({ runId: nr.runId });
      return rows.length === 1;
    },
    async putTimeline(scope, runId, e) {
      const values = {
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        runId,
        key: e.key,
        seq: e.seq,
        at: new Date(e.at),
        kind: e.kind,
        nodeId: e.nodeId ?? null,
        message: e.message,
      };
      await x.write(
        db
          .insert(tl)
          .values(values)
          .onConflictDoUpdate({
            target: [tl.spaceId, tl.environmentId, tl.runId, tl.key],
            set: {
              seq: values.seq,
              at: values.at,
              kind: values.kind,
              nodeId: values.nodeId,
              message: values.message,
            },
          }),
      );
    },
    async listTimeline(scope, runId) {
      const rows = await db
        .select()
        .from(tl)
        .where(and(scopeFilter(tl, scope), eq(tl.runId, runId)))
        .orderBy(asc(tl.seq));
      return rows.map((row) => ({
        seq: row.seq,
        key: row.key,
        at: ms(row.at),
        kind: row.kind as WorkflowTimelineRecord['kind'],
        ...(row.nodeId ? { nodeId: row.nodeId } : {}),
        message: row.message,
      }));
    },
    async trimTimeline(scope, runId, upTo) {
      await x.write(
        db.delete(tl).where(and(scopeFilter(tl, scope), eq(tl.runId, runId), lte(tl.seq, upTo))),
      );
    },
  };
}

function makeWorkflowTaskRepo(x: Exec): WorkflowTaskRepo {
  const db = x.db;
  const t = schema.workflowTasks;
  const toTask = (row: typeof t.$inferSelect): WorkflowTask => ({
    id: row.id,
    runId: row.runId,
    workflowId: row.workflowId,
    nodeId: row.nodeId,
    eventType: row.eventType,
    kind: row.kind as WorkflowTask['kind'],
    entryId: row.entryId,
    contentTypeApiId: row.contentTypeApiId,
    title: row.title,
    instructions: row.instructions,
    assignee: row.assignee,
    event: row.event,
    requiredScope: row.requiredScope,
    separateDuties: row.separateDuties,
    reviewId: row.reviewId,
    deadline: row.deadline.toISOString(),
    status: row.status as WorkflowTaskStatus,
    requestedAt: row.requestedAt.toISOString(),
    decidedAt: iso(row.decidedAt),
    decidedBy: row.decidedBy,
    note: row.note,
    startedBy: row.startedBy,
  });
  return {
    async create(scope, task) {
      const insert = db
        .insert(t)
        .values({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          ...task,
          deadline: new Date(task.deadline),
          requestedAt: new Date(task.requestedAt),
          decidedAt: task.decidedAt ? new Date(task.decidedAt) : null,
        })
        .onConflictDoNothing();
      if (x.inUnit) {
        // Unit of work: a task already committed (same id, or same run + event)
        // reports false now, as a direct insert would; a concurrent insert
        // that commits first aborts this unit at commit (TransactionConflictError).
        const [existing] = await db
          .select({ id: t.id })
          .from(t)
          .where(
            and(
              scopeFilter(t, scope),
              or(eq(t.id, task.id), and(eq(t.runId, task.runId), eq(t.eventType, task.eventType))),
            ),
          )
          .limit(1);
        if (existing) return false;
        await x.write(insert);
        x.expectChanged(1);
        return true;
      }
      const rows = await insert.returning({ id: t.id });
      return rows.length === 1;
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(t)
        .where(and(scopeFilter(t, scope), eq(t.id, id)));
      return row ? toTask(row) : null;
    },
    async getByEvent(scope, runId, eventType) {
      const [row] = await db
        .select()
        .from(t)
        .where(and(scopeFilter(t, scope), eq(t.runId, runId), eq(t.eventType, eventType)));
      return row ? toTask(row) : null;
    },
    async list(scope, query = {}) {
      const conds: SQL[] = [scopeFilter(t, scope) as SQL];
      if (query.status) conds.push(eq(t.status, query.status));
      if (query.runId) conds.push(eq(t.runId, query.runId));
      if (query.entryId) conds.push(eq(t.entryId, query.entryId));
      if (query.kind) conds.push(eq(t.kind, query.kind));
      const rows = await db
        .select()
        .from(t)
        .where(and(...conds))
        .orderBy(
          ...(query.status === 'pending'
            ? [asc(t.deadline), asc(t.id)]
            : [desc(t.requestedAt), desc(t.id)]),
        )
        .limit(Math.min(Math.max(query.limit ?? 50, 1), 200));
      return rows.map(toTask);
    },
    async settle(scope, id, outcome) {
      const update = db
        .update(t)
        .set({
          status: outcome.status,
          decidedAt: new Date(outcome.decidedAt),
          decidedBy: outcome.decidedBy,
          note: outcome.note,
        })
        .where(and(scopeFilter(t, scope), eq(t.id, id), eq(t.status, 'pending')));
      if (x.inUnit) {
        // Same pattern as `create`: decide from committed state, guard at commit.
        const [row] = await db
          .select({ status: t.status })
          .from(t)
          .where(and(scopeFilter(t, scope), eq(t.id, id)));
        if (row?.status !== 'pending') return false;
        await x.write(update);
        x.expectChanged(1);
        return true;
      }
      const rows = await update.returning({ id: t.id });
      return rows.length === 1;
    },
  };
}
function makeTaxonomyRepo(x: Exec): TaxonomyRepo {
  const db = x.db;
  const toConcept = (r: typeof schema.concepts.$inferSelect): Concept => ({
    id: r.id,
    schemeId: r.schemeId,
    prefLabel: r.prefLabel,
    broaderId: r.broaderId,
  });
  return {
    async createScheme(scope, scheme) {
      await x.write(
        db
          .insert(schema.conceptSchemes)
          .values({ spaceId: scope.spaceId, environmentId: scope.environmentId, ...scheme })
          .onConflictDoUpdate({
            target: [
              schema.conceptSchemes.spaceId,
              schema.conceptSchemes.environmentId,
              schema.conceptSchemes.id,
            ],
            set: { name: scheme.name },
          }),
      );
    },
    async listSchemes(scope) {
      return db
        .select()
        .from(schema.conceptSchemes)
        .where(scopeFilter(schema.conceptSchemes, scope));
    },
    async getScheme(scope, id) {
      const [row] = await db
        .select()
        .from(schema.conceptSchemes)
        .where(and(scopeFilter(schema.conceptSchemes, scope), eq(schema.conceptSchemes.id, id)));
      return row ?? null;
    },
    async deleteScheme(scope, id) {
      await x.write(
        db
          .delete(schema.conceptSchemes)
          .where(and(scopeFilter(schema.conceptSchemes, scope), eq(schema.conceptSchemes.id, id))),
      );
    },
    async createConcept(scope, concept) {
      await x.write(
        db
          .insert(schema.concepts)
          .values({ spaceId: scope.spaceId, environmentId: scope.environmentId, ...concept })
          .onConflictDoUpdate({
            target: [schema.concepts.spaceId, schema.concepts.environmentId, schema.concepts.id],
            set: {
              schemeId: concept.schemeId,
              prefLabel: concept.prefLabel,
              broaderId: concept.broaderId,
            },
          }),
      );
    },
    async getConcept(scope, id) {
      const [row] = await db
        .select()
        .from(schema.concepts)
        .where(and(scopeFilter(schema.concepts, scope), eq(schema.concepts.id, id)));
      return row ? toConcept(row) : null;
    },
    async listConcepts(scope, schemeId) {
      const conds = [scopeFilter(schema.concepts, scope)];
      if (schemeId) conds.push(eq(schema.concepts.schemeId, schemeId));
      const rows = await db
        .select()
        .from(schema.concepts)
        .where(and(...conds));
      return rows.map(toConcept);
    },
    async deleteConcept(scope, id) {
      await x.write(
        db
          .delete(schema.concepts)
          .where(and(scopeFilter(schema.concepts, scope), eq(schema.concepts.id, id))),
      );
    },
    async createTag(scope, tag) {
      await x.write(
        db
          .insert(schema.tags)
          .values({ spaceId: scope.spaceId, environmentId: scope.environmentId, ...tag })
          .onConflictDoUpdate({
            target: [schema.tags.spaceId, schema.tags.environmentId, schema.tags.id],
            set: { name: tag.name },
          }),
      );
    },
    async getTag(scope, id) {
      const [row] = await db
        .select()
        .from(schema.tags)
        .where(and(scopeFilter(schema.tags, scope), eq(schema.tags.id, id)));
      return row ?? null;
    },
    async listTags(scope) {
      return db.select().from(schema.tags).where(scopeFilter(schema.tags, scope));
    },
    async deleteTag(scope, id) {
      await x.write(
        db.delete(schema.tags).where(and(scopeFilter(schema.tags, scope), eq(schema.tags.id, id))),
      );
    },
    async getEntryMetadata(scope, entryId) {
      const [row] = await db
        .select()
        .from(schema.entryMetadata)
        .where(
          and(scopeFilter(schema.entryMetadata, scope), eq(schema.entryMetadata.entryId, entryId)),
        );
      return row ? { tags: row.tags, concepts: row.concepts } : null;
    },
    async getEntryMetadataMany(scope, entryIds) {
      const rows = await selectChunked(
        entryIds,
        (chunk) =>
          db
            .select()
            .from(schema.entryMetadata)
            .where(
              and(
                scopeFilter(schema.entryMetadata, scope),
                inArray(schema.entryMetadata.entryId, chunk),
              ),
            ),
        1,
        RESERVED,
      );
      return rows.map((row) => ({
        entryId: row.entryId,
        metadata: { tags: row.tags, concepts: row.concepts },
      }));
    },
    async setEntryMetadata(scope, entryId, metadata: EntryMetadata) {
      const values = {
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        entryId,
        tags: [...metadata.tags],
        concepts: [...metadata.concepts],
      };
      await x.write(
        db
          .insert(schema.entryMetadata)
          .values(values)
          .onConflictDoUpdate({
            target: [
              schema.entryMetadata.spaceId,
              schema.entryMetadata.environmentId,
              schema.entryMetadata.entryId,
            ],
            set: { tags: values.tags, concepts: values.concepts },
          }),
      );
    },
  };
}

export interface D1StoreOptions {
  /**
   * Max candidate rows a field-level query (or the built-in text search) may pull into memory
   * for exact evaluation (see query-pushdown.ts). Exceeding it raises
   * {@link QueryTooBroadError} rather than silently truncating. Default 5000.
   */
  readonly queryScanLimit?: number;
}

/** The repos `withTransaction` hands out, built over one unit of work. */
function makeTx(x: Exec, scanLimit: number): ContentStoreTx {
  return {
    contentTypes: makeContentTypeRepo(x),
    entries: makeEntryRepo(x, scanLimit),
    assets: makeAssetRepo(x),
    references: makeReferenceRepo(x),
    releases: makeReleaseRepo(x),
    taxonomy: makeTaxonomyRepo(x),
    bulkJobs: makeBulkJobRepo(x),
    workflowRuns: makeWorkflowRunRepo(x),
    workflowTasks: makeWorkflowTaskRepo(x),
    outbox: makeOutboxRepo(x),
  };
}

/**
 * Creates the D1-backed ContentStore over a database binding or a read-replica session
 * (`env.DB.withSession(bookmark)`). No D1 or Drizzle type crosses the `ContentStore` boundary.
 */
export function createD1Store(d1: D1Like, options: D1StoreOptions = {}): ContentStore {
  const db = createDb(d1);
  const x = directExec(db);
  const scanLimit = options.queryScanLimit ?? DEFAULT_QUERY_SCAN_LIMIT;
  return {
    spaces: makeSpaceRepo(x),
    contentTypes: makeContentTypeRepo(x),
    entries: makeEntryRepo(x, scanLimit),
    assets: makeAssetRepo(x),
    references: makeReferenceRepo(x),
    webhooks: makeWebhookRepo(x),
    auth: makeAuthRepo(x),
    roles: makeRoleRepo(x),
    members: makeMemberRepo(x),
    settings: makeDeploymentSettingsRepo(x),
    agentRuns: makeAgentRunRepo(x),
    audit: makeAuditRepo(x),
    aiActions: makeAiActionRepo(x),
    functions: makeFunctionRepo(x),
    appExtensions: makeAppExtensionRepo(x),
    previewTokens: makePreviewTokenRepo(x),
    plugins: makePluginRepo(x),
    oauthClients: makeOAuthClientRepo(x),
    oauthGrants: makeOAuthGrantRepo(x),
    releases: makeReleaseRepo(x),
    scheduledActions: makeScheduledActionRepo(x),
    agentSchedules: makeAgentScheduleRepo(x),
    agentReviews: makeAgentReviewRepo(x),
    comments: makeCommentRepo(x),
    tasks: makeTaskRepo(x),
    workflows: makeWorkflowRepo(x),
    workflowGraphs: makeWorkflowGraphRepo(x),
    workflowRuns: makeWorkflowRunRepo(x),
    workflowTasks: makeWorkflowTaskRepo(x),
    taxonomy: makeTaxonomyRepo(x),
    bulkJobs: makeBulkJobRepo(x),
    outbox: makeOutboxRepo(x),
    storedSecrets: makeStoredSecretRepo(x),
    /**
     * One unit of work per call: `fn`'s writes are buffered and committed as a single D1 batch
     * once it returns; if it throws, nothing is sent. See `ContentStore.withTransaction`.
     */
    async withTransaction<T>(fn: (tx: ContentStoreTx) => Promise<T>): Promise<T> {
      const uow = new UnitOfWork(db);
      const result = await fn(makeTx(uow, scanLimit));
      await uow.commit();
      return result;
    },
  };
}

// ---- row mappers ----------------------------------------------------------

type CtRow = typeof schema.contentTypes.$inferSelect;
type EntryRow = typeof schema.entries.$inferSelect;
type PubRow = typeof schema.entryPublished.$inferSelect;

const toContentType = (r: CtRow): ContentType => ({
  apiId: r.apiId,
  name: r.name,
  displayField: r.displayField,
  fields: r.fields,
  version: r.version,
  status: r.status,
});

const toEntry = (r: EntryRow): Entry => ({
  id: r.id,
  contentTypeApiId: r.contentTypeApiId,
  status: r.status,
  currentVersion: r.currentVersion,
  publishedVersion: r.publishedVersion,
});

type AgentRunRow = typeof schema.agentRuns.$inferSelect;
const toAgentRun = (r: AgentRunRow): AgentRunRecord => ({
  id: r.id,
  workflow: r.workflow,
  entryId: r.entryId,
  status: r.status,
  decisions: r.decisions,
  inputTokens: r.inputTokens,
  outputTokens: r.outputTokens,
  createdAt: r.createdAt.toISOString(),
});

type ApiKeyRow = typeof schema.apiKeys.$inferSelect;
const toApiKey = (r: ApiKeyRow): ApiKey => ({
  id: r.id,
  spaceId: r.spaceId,
  kind: r.kind,
  name: r.name ?? undefined,
  hashedToken: r.hashedToken,
  scopes: r.scopes,
  revoked: r.revoked,
  roleId: r.roleId ?? undefined,
  lastUsedAt: r.lastUsedAt?.toISOString(),
  expiresAt: r.expiresAt?.toISOString(),
  // Rows written before OAuth existed have no issuance; they are operator keys.
  issuance: r.issuance ?? undefined,
  subject: r.subject ?? undefined,
  clientId: r.clientId ?? undefined,
});

type OAuthClientRow = typeof schema.oauthClients.$inferSelect;
const toOAuthClient = (r: OAuthClientRow): OAuthClient => ({
  id: r.id,
  clientName: r.clientName,
  redirectUris: r.redirectUris,
  grantTypes: r.grantTypes as OAuthClient['grantTypes'],
  scopes: r.scopes,
  tokenEndpointAuthMethod: r.tokenEndpointAuthMethod as OAuthClient['tokenEndpointAuthMethod'],
  hashedClientSecret: r.hashedClientSecret ?? undefined,
  clientUri: r.clientUri ?? undefined,
  logoUri: r.logoUri ?? undefined,
  softwareId: r.softwareId ?? undefined,
  createdAt: r.createdAt.toISOString(),
});

type OAuthGrantRow = typeof schema.oauthGrants.$inferSelect;
const toOAuthGrant = (r: OAuthGrantRow): OAuthGrantRecord => ({
  id: r.id,
  kind: r.kind,
  clientId: r.clientId,
  hashedCode: r.hashedCode,
  hashedUserCode: r.hashedUserCode ?? undefined,
  status: r.status,
  scopes: r.scopes,
  spaceId: r.spaceId ?? undefined,
  subject: r.subject ?? undefined,
  roleId: r.roleId ?? undefined,
  redirectUri: r.redirectUri ?? undefined,
  codeChallenge: r.codeChallenge ?? undefined,
  codeChallengeMethod: r.codeChallengeMethod ?? undefined,
  resource: r.resource ?? undefined,
  parentId: r.parentId ?? undefined,
  issuedKeyIds: r.issuedKeyIds ?? undefined,
  expiresAt: r.expiresAt,
  createdAt: r.createdAt,
});

type RoleRow = typeof schema.roles.$inferSelect;
const toRole = (r: RoleRow): Role => ({
  id: r.id,
  spaceId: r.spaceId,
  name: r.name,
  description: r.description ?? undefined,
  scopes: r.scopes,
  contentGrants: r.contentGrants,
  ...(r.preset ? { preset: r.preset } : {}),
});

type MemberRow = typeof schema.spaceMembers.$inferSelect;
const toMember = (r: MemberRow): SpaceMember => ({
  id: r.id,
  spaceId: r.spaceId,
  email: r.email,
  ...(r.name ? { name: r.name } : {}),
  ...(r.subject ? { subject: r.subject } : {}),
  roleId: r.roleId,
  disabled: r.disabled,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

type WebhookRow = typeof schema.webhooks.$inferSelect;
const toWebhook = (r: WebhookRow): Webhook => ({
  id: r.id,
  url: r.url,
  topics: r.topics as Webhook['topics'],
  secret: r.secret,
  active: r.active,
  headers: r.headers ?? undefined,
});

type PubAssetRow = typeof schema.assetPublished.$inferSelect;
const toPublishedAsset = (r: PubAssetRow): PublishedAsset => ({
  assetId: r.assetId,
  file: r.file,
  title: r.title,
  description: r.description,
  metadata: r.metadata,
  publishedAt: r.publishedAt.toISOString(),
});

type RefRow = typeof schema.references.$inferSelect;
const toEdge = (r: RefRow): ReferenceEdge => ({
  fromEntryId: r.fromEntryId,
  fromField: r.fromField,
  toId: r.toId,
  toType: r.toType,
});

const toPublished = (r: PubRow): PublishedEntry => ({
  entryId: r.entryId,
  contentTypeApiId: r.contentTypeApiId,
  version: r.version,
  fields: r.fields,
  publishedAt: r.publishedAt.toISOString(),
  ...(r.metadata ? { metadata: r.metadata } : {}),
});

const publishedRow = (scope: Scope, snapshot: PublishedEntry) => ({
  spaceId: scope.spaceId,
  environmentId: scope.environmentId,
  entryId: snapshot.entryId,
  contentTypeApiId: snapshot.contentTypeApiId,
  version: snapshot.version,
  fields: snapshot.fields,
  metadata: snapshot.metadata
    ? { tags: [...snapshot.metadata.tags], concepts: [...snapshot.metadata.concepts] }
    : null,
  publishedAt: new Date(snapshot.publishedAt),
});

const entryRow = (scope: Scope, entry: Entry) => ({
  spaceId: scope.spaceId,
  environmentId: scope.environmentId,
  id: entry.id,
  contentTypeApiId: entry.contentTypeApiId,
  status: entry.status,
  currentVersion: entry.currentVersion,
  publishedVersion: entry.publishedVersion,
  updatedAt: new Date(),
});

const versionRow = (scope: Scope, version: EntryVersion) => ({
  spaceId: scope.spaceId,
  environmentId: scope.environmentId,
  entryId: version.entryId,
  version: version.version,
  fields: version.fields,
  // Honor a use-case-supplied timestamp (deterministic via the clock); else the
  // column defaults to the insert instant.
  ...(version.createdAt ? { createdAt: new Date(version.createdAt) } : {}),
});

type EntryVersionRow = typeof schema.entryVersions.$inferSelect;
const toVersion = (r: EntryVersionRow): EntryVersion => ({
  entryId: r.entryId,
  version: r.version,
  fields: r.fields,
  createdAt: r.createdAt.toISOString(),
});

/** The aggregate UPDATE (an UPDATE, so a concurrently deleted row stays deleted). */
function saveEntryAggregate(db: Db, scope: Scope, entry: Entry) {
  return db
    .update(schema.entries)
    .set({
      status: entry.status,
      currentVersion: entry.currentVersion,
      publishedVersion: entry.publishedVersion,
      updatedAt: new Date(),
    })
    .where(and(scopeFilter(schema.entries, scope), eq(schema.entries.id, entry.id)));
}
