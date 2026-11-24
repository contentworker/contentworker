import type { MigrationPage, MigrationRun, MigrationTemplate, Scope } from '@contentworker/domain';
import {
  type MigrationPageCounts,
  type MigrationStore,
  TransactionConflictError,
} from '@contentworker/ports';
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  isNotNull,
  isNull,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { chunked, type Exec, mapD1Error, writeAll } from './exec';
import * as schema from './schema';

type Query = BatchItem<'sqlite'>;

/** Ids one template assignment names, as one JSON parameter (`json_each`). */
const IDS_PER_STATEMENT = 500;

const scopeFilter = (t: { spaceId: unknown; environmentId: unknown }, scope: Scope) =>
  and(eq(t.spaceId as never, scope.spaceId), eq(t.environmentId as never, scope.environmentId));

type RunRow = typeof schema.migrationRuns.$inferSelect;
const toRun = (r: RunRow): MigrationRun => ({
  id: r.id,
  name: r.name,
  source: r.source,
  status: r.status,
  threshold: r.threshold,
  inventory: r.inventory ?? null,
  error: r.error ?? null,
  version: r.version,
  createdAt: r.createdAt.toISOString(),
  createdBy: r.createdBy ?? null,
  updatedAt: r.updatedAt.toISOString(),
});

type TemplateRow = typeof schema.migrationTemplates.$inferSelect;
const toTemplate = (r: TemplateRow): MigrationTemplate => ({
  id: r.id,
  runId: r.runId,
  label: r.label,
  status: r.status,
  pageCount: r.pageCount,
  samplePageIds: r.samplePageIds,
  fingerprint: r.fingerprint,
  contentTypeId: r.contentTypeId ?? null,
  script: r.script ?? null,
  proposal: r.proposal ?? null,
  lastTry: r.lastTry ?? null,
  version: r.version,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

type PageRow = typeof schema.migrationPages.$inferSelect;
const toPage = (r: PageRow): MigrationPage => ({
  id: r.id,
  runId: r.runId,
  url: r.url,
  path: r.path,
  depth: r.depth,
  stage: r.stage,
  templateId: r.templateId ?? null,
  title: r.title ?? null,
  lastModified: r.lastModified ?? null,
  httpStatus: r.httpStatus ?? null,
  html: r.html ?? null,
  fingerprint: r.fingerprint ?? null,
  output: r.output ?? null,
  outputScript: r.outputScript ?? null,
  score: r.score ?? null,
  entryId: r.entryId ?? null,
  error: r.error ?? null,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

/** A page's columns that change after discovery (its run, id and URL never do). */
const pageValues = (p: MigrationPage) => ({
  path: p.path,
  depth: p.depth,
  stage: p.stage,
  templateId: p.templateId,
  title: p.title,
  lastModified: p.lastModified,
  httpStatus: p.httpStatus,
  html: p.html,
  fingerprint: p.fingerprint ? [...p.fingerprint] : null,
  output: p.output,
  outputScript: p.outputScript,
  score: p.score,
  entryId: p.entryId,
  error: p.error,
  updatedAt: new Date(p.updatedAt),
});

/**
 * Site migration records on D1 (0048_site_migrations, 0050_site_migration_authoring). A run is rewritten whole at its version's
 * compare-and-set; pages are added past the 100-parameter cap in chunks that skip a URL the run
 * already has; a clustering replaces a run's templates and its pages' assignments in one batch.
 */
export function makeMigrationStore(x: Exec): MigrationStore {
  const db = x.db;
  const runs = schema.migrationRuns;
  const templates = schema.migrationTemplates;
  const pages = schema.migrationPages;
  const ofRun = <T extends { spaceId: unknown; environmentId: unknown; runId: unknown }>(
    t: T,
    scope: Scope,
    runId: string,
  ) => and(scopeFilter(t, scope), eq(t.runId as never, runId));

  return {
    async createRun(scope, run) {
      await x.write(
        db.insert(runs).values({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          id: run.id,
          name: run.name,
          source: run.source,
          status: run.status,
          threshold: run.threshold,
          inventory: run.inventory,
          error: run.error,
          version: run.version,
          createdAt: new Date(run.createdAt),
          createdBy: run.createdBy,
          updatedAt: new Date(run.updatedAt),
        }),
      );
    },
    async getRun(scope, id) {
      const [row] = await db
        .select()
        .from(runs)
        .where(and(scopeFilter(runs, scope), eq(runs.id, id)));
      return row ? toRun(row) : null;
    },
    async listRuns(scope, { limit }) {
      const rows = await db
        .select()
        .from(runs)
        .where(scopeFilter(runs, scope))
        .orderBy(desc(runs.id))
        .limit(limit);
      return rows.map(toRun);
    },
    async saveRun(scope, run, expected) {
      const query = db
        .update(runs)
        .set({
          name: run.name,
          source: run.source,
          status: run.status,
          threshold: run.threshold,
          inventory: run.inventory,
          error: run.error,
          version: run.version,
          updatedAt: new Date(run.updatedAt),
        })
        .where(and(scopeFilter(runs, scope), eq(runs.id, run.id), eq(runs.version, expected)));
      if (x.inUnit) {
        await x.write(query);
        x.expectChanged(1);
        return;
      }
      let changed: unknown[];
      try {
        changed = await query.returning({ id: runs.id });
      } catch (err) {
        throw mapD1Error(err);
      }
      if (changed.length === 0) throw new TransactionConflictError();
    },

    async addPages(scope, runId, list) {
      const rows = list.map((p) => ({
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        runId,
        id: p.id,
        url: p.url,
        createdAt: new Date(p.createdAt),
        ...pageValues(p),
      }));
      const perRow = Object.keys(getTableColumns(pages)).length;
      await writeAll(
        x,
        chunked(rows, perRow, 0)
          .filter((c) => c.length > 0)
          // Either key: the page's id, or (the case that matters) its URL in the run.
          .map((chunk) => db.insert(pages).values(chunk).onConflictDoNothing()),
      );
    },
    async savePages(scope, runId, list) {
      await writeAll(
        x,
        list.map((p) =>
          db
            .update(pages)
            .set(pageValues(p))
            .where(and(ofRun(pages, scope, runId), eq(pages.id, p.id))),
        ),
      );
    },
    async getPage(scope, runId, id) {
      const [row] = await db
        .select()
        .from(pages)
        .where(and(ofRun(pages, scope, runId), eq(pages.id, id)));
      return row ? toPage(row) : null;
    },
    async knownUrls(scope, runId, urls) {
      const distinct = [...new Set(urls)];
      const found: string[] = [];
      for (let at = 0; at < distinct.length; at += IDS_PER_STATEMENT) {
        const list = JSON.stringify(distinct.slice(at, at + IDS_PER_STATEMENT));
        const rows = await db
          .select({ url: pages.url })
          .from(pages)
          .where(
            and(
              ofRun(pages, scope, runId),
              sql`${pages.url} IN (SELECT value FROM json_each(${list}))`,
            ),
          );
        found.push(...rows.map((r) => r.url));
      }
      return found;
    },
    async listPages(scope, runId, query) {
      const conds: (SQL | undefined)[] = [ofRun(pages, scope, runId)];
      if (query.after !== undefined) conds.push(gt(pages.id, query.after));
      if (query.stage !== undefined) conds.push(eq(pages.stage, query.stage));
      if (query.templateId !== undefined) conds.push(eq(pages.templateId, query.templateId));
      if (query.fetch === 'fetched') conds.push(isNotNull(pages.html));
      if (query.fetch === 'pending') conds.push(isNull(pages.html), isNull(pages.error));
      const rows = await db
        .select()
        .from(pages)
        .where(and(...conds))
        .orderBy(asc(pages.id))
        .limit(query.limit);
      return rows.map(toPage);
    },
    async countPages(scope, runId): Promise<MigrationPageCounts> {
      const rows = await db
        .select({
          stage: pages.stage,
          n: count(),
          fetched: sql<number>`coalesce(sum(${pages.html} IS NOT NULL), 0)`,
          failed: sql<number>`coalesce(sum(${pages.error} IS NOT NULL), 0)`,
        })
        .from(pages)
        .where(ofRun(pages, scope, runId))
        .groupBy(pages.stage);
      const byStage: Record<string, number> = {};
      let total = 0;
      let fetched = 0;
      let failed = 0;
      for (const r of rows) {
        byStage[r.stage] = r.n;
        total += r.n;
        fetched += Number(r.fetched);
        failed += Number(r.failed);
      }
      return { total, fetched, failed, byStage };
    },

    async listTemplates(scope, runId) {
      const rows = await db
        .select()
        .from(templates)
        .where(ofRun(templates, scope, runId))
        .orderBy(desc(templates.pageCount), asc(templates.id));
      return rows.map(toTemplate);
    },
    async getTemplate(scope, runId, id) {
      const [row] = await db
        .select()
        .from(templates)
        .where(and(ofRun(templates, scope, runId), eq(templates.id, id)));
      return row ? toTemplate(row) : null;
    },
    async saveTemplate(scope, runId, t) {
      await x.write(
        db
          .update(templates)
          .set({
            label: t.label,
            status: t.status,
            pageCount: t.pageCount,
            samplePageIds: [...t.samplePageIds],
            fingerprint: [...t.fingerprint],
            contentTypeId: t.contentTypeId,
            script: t.script,
            proposal: t.proposal,
            lastTry: t.lastTry,
            version: t.version,
            updatedAt: new Date(t.updatedAt),
          })
          .where(and(ofRun(templates, scope, runId), eq(templates.id, t.id))),
      );
    },
    async replaceTemplates(scope, runId, clusters, at) {
      const when = new Date(at);
      const statements: Query[] = [
        // Aborts the batch (TransactionConflictError) while any template is past pending.
        db
          .insert(schema.guard)
          .select(
            sql`SELECT NOT EXISTS (SELECT 1 FROM ${templates} WHERE ${templates.spaceId} = ${scope.spaceId} AND ${templates.environmentId} = ${scope.environmentId} AND ${templates.runId} = ${runId} AND ${templates.status} != 'pending') AS ok`,
          ),
        db.delete(templates).where(ofRun(templates, scope, runId)),
        db
          .update(pages)
          .set({ templateId: null, stage: 'discovered', updatedAt: when })
          .where(ofRun(pages, scope, runId)),
      ];
      const rows = clusters.map(({ template: t }) => ({
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        runId,
        id: t.id,
        label: t.label,
        status: t.status,
        pageCount: t.pageCount,
        samplePageIds: [...t.samplePageIds],
        fingerprint: [...t.fingerprint],
        contentTypeId: t.contentTypeId,
        script: t.script,
        proposal: t.proposal,
        lastTry: t.lastTry,
        version: t.version,
        createdAt: new Date(t.createdAt),
        updatedAt: new Date(t.updatedAt),
      }));
      const perRow = Object.keys(getTableColumns(templates)).length;
      for (const chunk of chunked(rows, perRow, 0)) {
        if (chunk.length > 0) statements.push(db.insert(templates).values(chunk));
      }
      for (const { template, pageIds } of clusters) {
        for (let at = 0; at < pageIds.length; at += IDS_PER_STATEMENT) {
          const ids = JSON.stringify(pageIds.slice(at, at + IDS_PER_STATEMENT));
          statements.push(
            db
              .update(pages)
              .set({ templateId: template.id, stage: 'clustered', updatedAt: when })
              .where(
                and(
                  ofRun(pages, scope, runId),
                  sql`${pages.id} IN (SELECT value FROM json_each(${ids}))`,
                ),
              ),
          );
        }
      }
      // Leaves the guard table empty; a unit of work's own trailing delete is harmless after it.
      statements.push(db.delete(schema.guard));
      await writeAll(x, statements);
    },
  };
}
