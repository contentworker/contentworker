import {
  ConflictError,
  type MigrationPage,
  type MigrationRun,
  type MigrationTemplate,
  type Scope,
} from '@contentworker/domain';
import {
  type MigrationCluster,
  type MigrationPageCounts,
  type MigrationPageQuery,
  type MigrationStore,
  TransactionConflictError,
} from '@contentworker/ports';
import { JournaledMap } from './journaled-map';

const scopeKey = (s: Scope) => `${s.spaceId}::${s.environmentId}`;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * Site migration records in memory, as the D1 store keeps them: a run's writes at its version's
 * compare-and-set, one page per URL in a run, templates replaced whole with their pages' stages.
 * Keyed under the scope so the in-memory environment purge clears them with the environment.
 */
export class InMemoryMigrationStore implements MigrationStore {
  /** `space::env::run` → run. */
  readonly runData = new JournaledMap<string, MigrationRun>();
  /** `space::env::run::template` → template. */
  readonly templateData = new JournaledMap<string, MigrationTemplate>();
  /** `space::env::run::page` → page. */
  readonly pageData = new JournaledMap<string, MigrationPage>();

  /** The collections a transaction can change, and the purge clears. */
  collections(): JournaledMap<string, unknown>[] {
    return [this.runData, this.templateData, this.pageData] as JournaledMap<string, unknown>[];
  }

  private pagesOf(scope: Scope, runId: string): MigrationPage[] {
    const prefix = `${scopeKey(scope)}::${runId}::`;
    return [...this.pageData.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([, p]) => p)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  private templatesOf(scope: Scope, runId: string): [string, MigrationTemplate][] {
    const prefix = `${scopeKey(scope)}::${runId}::`;
    return [...this.templateData.entries()].filter(([k]) => k.startsWith(prefix));
  }

  async createRun(scope: Scope, run: MigrationRun): Promise<void> {
    const key = `${scopeKey(scope)}::${run.id}`;
    if (this.runData.has(key)) throw new ConflictError('A unique value is already taken');
    this.runData.set(key, clone(run));
  }

  async getRun(scope: Scope, id: string): Promise<MigrationRun | null> {
    const run = this.runData.get(`${scopeKey(scope)}::${id}`);
    return run ? clone(run) : null;
  }

  async listRuns(scope: Scope, opts: { readonly limit: number }): Promise<MigrationRun[]> {
    const prefix = `${scopeKey(scope)}::`;
    return [...this.runData.entries()]
      .filter(([k]) => k.startsWith(prefix) && k.split('::').length === 3)
      .map(([, r]) => clone(r))
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, opts.limit);
  }

  async saveRun(scope: Scope, run: MigrationRun, expected: number): Promise<void> {
    const key = `${scopeKey(scope)}::${run.id}`;
    if (this.runData.get(key)?.version !== expected) throw new TransactionConflictError();
    this.runData.set(key, clone(run));
  }

  async addPages(scope: Scope, runId: string, pages: readonly MigrationPage[]): Promise<void> {
    const urls = new Set(this.pagesOf(scope, runId).map((p) => p.url));
    for (const page of pages) {
      const key = `${scopeKey(scope)}::${runId}::${page.id}`;
      if (urls.has(page.url) || this.pageData.has(key)) continue;
      urls.add(page.url);
      this.pageData.set(key, clone({ ...page, runId }));
    }
  }

  async savePages(scope: Scope, runId: string, pages: readonly MigrationPage[]): Promise<void> {
    for (const page of pages) {
      const key = `${scopeKey(scope)}::${runId}::${page.id}`;
      const current = this.pageData.get(key);
      if (!current) continue;
      // As D1: a page keeps the run and URL it was discovered with.
      this.pageData.set(key, clone({ ...page, runId, url: current.url }));
    }
  }

  async getPage(scope: Scope, runId: string, id: string): Promise<MigrationPage | null> {
    const page = this.pageData.get(`${scopeKey(scope)}::${runId}::${id}`);
    return page ? clone(page) : null;
  }

  async listPages(
    scope: Scope,
    runId: string,
    query: MigrationPageQuery,
  ): Promise<MigrationPage[]> {
    return this.pagesOf(scope, runId)
      .filter(
        (p) =>
          (query.after === undefined || p.id > query.after) &&
          (query.stage === undefined || p.stage === query.stage) &&
          (query.templateId === undefined || p.templateId === query.templateId) &&
          (query.fetch === undefined ||
            (query.fetch === 'fetched' ? p.html !== null : p.html === null && p.error === null)),
      )
      .slice(0, query.limit)
      .map(clone);
  }

  async countPages(scope: Scope, runId: string): Promise<MigrationPageCounts> {
    const pages = this.pagesOf(scope, runId);
    const byStage: Record<string, number> = {};
    for (const p of pages) byStage[p.stage] = (byStage[p.stage] ?? 0) + 1;
    return {
      total: pages.length,
      fetched: pages.filter((p) => p.html !== null).length,
      failed: pages.filter((p) => p.error !== null).length,
      byStage,
    };
  }

  async listTemplates(scope: Scope, runId: string): Promise<MigrationTemplate[]> {
    return this.templatesOf(scope, runId)
      .map(([, t]) => clone(t))
      .sort((a, b) => b.pageCount - a.pageCount || (a.id < b.id ? -1 : 1));
  }

  async getTemplate(scope: Scope, runId: string, id: string): Promise<MigrationTemplate | null> {
    const t = this.templateData.get(`${scopeKey(scope)}::${runId}::${id}`);
    return t ? clone(t) : null;
  }

  async replaceTemplates(
    scope: Scope,
    runId: string,
    clusters: readonly MigrationCluster[],
    at: string,
  ): Promise<void> {
    for (const [key] of this.templatesOf(scope, runId)) this.templateData.delete(key);
    const assigned = new Map<string, string>();
    for (const { template, pageIds } of clusters) {
      this.templateData.set(`${scopeKey(scope)}::${runId}::${template.id}`, clone(template));
      for (const id of pageIds) assigned.set(id, template.id);
    }
    for (const page of this.pagesOf(scope, runId)) {
      const templateId = assigned.get(page.id) ?? null;
      this.pageData.set(`${scopeKey(scope)}::${runId}::${page.id}`, {
        ...page,
        templateId,
        stage: templateId ? 'clustered' : 'discovered',
        updatedAt: at,
      });
    }
  }
}
