import {
  type AppContext,
  addEntryToRelease,
  type CreateSpaceInput,
  createRelease,
  createSpace,
  getSpaceConfig,
  listAssets,
  listContentTypes,
  listPreviewEntries,
  listReleases,
} from '@contentworker/application';
import type { Scope } from '@contentworker/domain';
import type { SpaceConfig } from '@contentworker/ports';
import { logger } from '@contentworker/telemetry';
import { FILES, seedAssets } from './assets';
import { seedContentModel } from './content-model';
import { type CorpusVolumes, seedCorpus } from './corpus';
import { seedTaxonomy } from './taxonomy';
import type { SeedDeps, SeedRun } from './types';

/** What a new space starts with: nothing, or the sample content below. */
export const STARTERS = ['empty', 'sample'] as const;
export type Starter = (typeof STARTERS)[number];

/**
 * The sample corpus: every content type gets a handful of entries, enough to see lists, links,
 * drafts, changed and published entries at work without a new space reading like a load test (the
 * dev seed's scale 1 is ~550 entries; this is 39, three of them the curated pages). Sized by what
 * it costs in D1 calls inside one request: ~9 per entry (create, metadata, publish, edit).
 */
export const STARTER_VOLUMES: CorpusVolumes = {
  authors: 4,
  categories: 5,
  articles: 12,
  products: 4,
  events: 3,
  recipes: 3,
  pages: 3,
  landingPages: 2,
};

/** Images and documents only: a video without a video host behind it is a broken asset. */
const STARTER_FILES = FILES.filter((f) => f.contentType !== 'video/mp4').slice(0, 8);

const RELEASE_TITLE = 'First release';

/** What the starter holds in the environment once installed (not what this run added). */
export interface StarterSummary {
  readonly contentTypes: number;
  readonly entries: number;
  readonly assets: number;
  readonly tags: number;
  readonly concepts: number;
  readonly releases: number;
}

/**
 * Installs the sample content into one environment of an existing space: the demo content model
 * (every field type), a small corpus with drafts, changed and published entries, the taxonomy,
 * sample images and documents when a blob store is bound, and one open release.
 *
 * Deliberately not the dev seed's rest: no API keys, comments or tasks from people who don't
 * exist, webhooks or functions pointing at example hosts, agent runs, schedules, reviews or audit
 * entries. A real space's history starts with its real people.
 *
 * Idempotent: each piece finds what an earlier run made (a content type by apiId, entries by
 * their title, tags and concepts by name, the release by title, assets by any being present) and
 * adds only what's missing, so a retry after a failure part-way finishes the job. A content type
 * that already exists is left alone, so installing next to someone's model never rewrites it.
 * Every write goes through the application use-cases, which batch each one into a unit of work
 * (the D1 query budget this costs is measured in packages/db/test/starter.test.ts).
 */
export async function installStarter(
  ctx: AppContext,
  scope: Scope,
  deps: SeedDeps = {},
): Promise<StarterSummary> {
  const config = await getSpaceConfig(ctx, scope);
  const run: SeedRun = {
    ctx,
    scope,
    locale: config.defaultLocale,
    locales: config.locales,
    hasDe: config.locales.includes('de-DE'),
    scale: 1,
    keepExistingTypes: true,
  };

  await seedContentModel(run);
  const assetIds = deps.blob ? await seedAssets(run, deps.blob, STARTER_FILES) : [];
  const taxonomy = await seedTaxonomy(run);
  const corpus = await seedCorpus(run, assetIds, taxonomy, STARTER_VOLUMES);

  const releases = await listReleases(ctx, scope);
  let releaseCount = releases.length;
  const members = [...corpus.articleIds.slice(1, 3), ...corpus.productIds.slice(1, 2)];
  if (!releases.some((r) => r.title === RELEASE_TITLE) && members.length === 3) {
    const release = await createRelease(ctx, scope, {
      title: RELEASE_TITLE,
      description: 'Two articles and a product that publish together. Open it to see what ships.',
    });
    for (const entityId of members) await addEntryToRelease(ctx, scope, release.id, { entityId });
    releaseCount += 1;
  }

  const summary: StarterSummary = {
    contentTypes: (await listContentTypes(ctx, scope)).length,
    entries: (await listPreviewEntries(ctx, scope, { locale: run.locale, limit: 1000 })).length,
    assets: deps.blob ? (await listAssets(ctx, scope, { limit: 1000 })).items.length : 0,
    tags: taxonomy.tagIds.length,
    concepts: taxonomy.conceptIds.length,
    releases: releaseCount,
  };
  logger.info({ space: scope.spaceId, ...summary }, 'starter: installed');
  return summary;
}

export interface CreatedSpace {
  readonly space: SpaceConfig;
  readonly starter: Starter;
  /** Present when the sample content was installed. */
  readonly installed?: StarterSummary;
}

/**
 * Creates a space (as `createSpace`) and, for the `sample` starter, installs the sample content
 * into its first environment. The one entry point the HTTP route and the MCP tool share, so both
 * surfaces create the same space. Creating a space is an upsert, so repeating the call after a
 * failed install finishes the install rather than failing on the existing space.
 */
export async function createSpaceWithStarter(
  ctx: AppContext,
  input: CreateSpaceInput & { readonly starter?: Starter },
  deps: SeedDeps = {},
): Promise<CreatedSpace> {
  const { starter = 'empty', ...spaceInput } = input;
  const space = await createSpace(ctx, spaceInput);
  if (starter === 'empty') return { space, starter };
  const environmentId = spaceInput.environments?.[0] ?? 'main';
  const installed = await installStarter(ctx, { spaceId: space.spaceId, environmentId }, deps);
  return { space, starter, installed };
}
