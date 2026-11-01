import {
  type AppContext,
  createHasher,
  createSpace,
  createTag,
  getSpaceConfig,
  listTags,
} from '@contentworker/application';
import { type ApiKeyKind, scopesForKind } from '@contentworker/domain';
import { logger } from '@contentworker/telemetry';
import { seedAgents } from './agents.js';
import { seedAssets } from './assets.js';
import { seedAutomation } from './automation.js';
import { seedCollaboration } from './collaboration.js';
import { seedContentModel } from './content-model.js';
import { seedCorpus } from './corpus.js';
import { seedGovernance } from './governance.js';
import { seedReleases } from './releases.js';
import { seedTaxonomy } from './taxonomy.js';
import type { SeedConfig, SeedDeps, SeedRun } from './types.js';

export { volumes } from './corpus.js';
export type { SeedConfig, SeedDeps } from './types.js';
export { seedConfigFrom } from './types.js';

/**
 * Bump when the dataset changes shape; the marker tag short-circuits every
 * subsequent boot to a single query and self-heals after a crashed partial
 * seed (it is created last).
 */
const MARKER_TAG = 'demo-seed-v3';

/**
 * Idempotently bootstraps a fully-populated dev environment: the seed space,
 * dev API keys, and a demo dataset exercising every platform capability —
 * content model (all field types), a scaled entry corpus, assets, taxonomy,
 * releases, workflows, comments/tasks, webhooks/functions/extensions/AI
 * actions, scheduled actions, agent runs/reviews/schedules, roles, and audit.
 *
 * Safe to run on every boot from any composition root (Node API or edge
 * Worker): only `@contentworker/application` use-cases and ports, no adapters, no
 * `node:` APIs, no randomness (index-derived data + the injected clock).
 */
export async function seedDev(
  ctx: AppContext,
  config: SeedConfig,
  deps: SeedDeps = {},
): Promise<void> {
  const scope = { spaceId: config.spaceId, environmentId: config.environmentId };
  const run: SeedRun = {
    ctx,
    scope,
    locale: config.defaultLocale,
    locales: config.locales,
    hasDe: config.locales.includes('de-DE'),
    scale: Math.max(1, Math.floor(config.scale ?? 1)),
  };

  // 1. Space + environment (skip if it already exists).
  if (!(await spaceExists(ctx, scope))) {
    await createSpace(ctx, {
      spaceId: config.spaceId,
      name: config.spaceId,
      defaultLocale: config.defaultLocale,
      locales: config.locales,
      environments: [config.environmentId],
    });
    logger.info({ space: config.spaceId }, 'seed: created space');
  }

  // 2. Dev API keys — insert each only if its hashed token isn't present yet.
  const hasher = createHasher(config.tokenPepper);
  const tokens: Record<ApiKeyKind, string> = {
    cma: config.cmaKey,
    cda: config.cdaKey,
    cpa: config.cpaKey,
  };
  for (const [kind, token] of Object.entries(tokens) as [ApiKeyKind, string][]) {
    // Unset (a deployment never gets dev keys): nothing to seed for this kind.
    if (!token) continue;
    const hashedToken = hasher.hash(token);
    if (!(await ctx.store.auth.findByHash(hashedToken))) {
      await ctx.store.auth.createApiKey({
        id: ctx.ids.newId(),
        spaceId: config.spaceId,
        kind,
        name: `dev-${kind}`,
        hashedToken,
        scopes: scopesForKind(kind),
        revoked: false,
      });
      logger.info({ kind }, 'seed: created dev api key');
    }
  }

  // 3. Rich demo dataset, short-circuited by the marker tag once complete.
  const tags = await listTags(ctx, scope);
  if (tags.some((t) => t.name === MARKER_TAG)) return;

  await seedContentModel(run);
  const assetIds = deps.blob ? await seedAssets(run, deps.blob) : [];
  const taxonomy = await seedTaxonomy(run);
  const corpus = await seedCorpus(run, assetIds, taxonomy);
  const releases = await seedReleases(run, corpus.articleIds, corpus.productIds);
  await seedCollaboration(run, corpus.articleIds);
  await seedAutomation(
    run,
    releases.autumnReleaseId,
    corpus.draftArticleIds[0] ?? null,
    // An article deep in the published set, so the scheduled unpublish never
    // collides with the entries used by workflows/comments/reviews demos.
    corpus.publishedArticleIds[20] ?? null,
  );
  await seedAgents(run, corpus.articleIds);
  await seedGovernance(run, config);

  await createTag(ctx, scope, { name: MARKER_TAG });
  logger.info({ scale: run.scale }, 'seed: demo dataset complete');
}

async function spaceExists(ctx: AppContext, scope: { spaceId: string; environmentId: string }) {
  try {
    await getSpaceConfig(ctx, scope);
    return true;
  } catch {
    return false;
  }
}
