import {
  ConflictError,
  type DomainEvent,
  InvalidStateError,
  type LocaleCode,
  NotFoundError,
  type Scope,
  ValidationError,
} from '@contentworker/domain';
import type { EnvironmentAlias, SpaceConfig } from '@contentworker/ports';
import type { AppContext } from './context.js';
import { allPages } from './paging.js';
import { ensureRolePresets } from './team.js';

export interface CreateSpaceInput {
  readonly spaceId: string;
  readonly name: string;
  readonly defaultLocale: LocaleCode;
  readonly locales?: readonly LocaleCode[];
  readonly fallbacks?: Record<LocaleCode, LocaleCode | null>;
  /** Environments to create alongside the space. Defaults to ["main"]. */
  readonly environments?: readonly string[];
}

/**
 * Provisions a space with its locales and one or more environments. This is the
 * entry point that lets the platform be set up over the API instead of by hand.
 */
export async function createSpace(ctx: AppContext, input: CreateSpaceInput): Promise<SpaceConfig> {
  const locales = input.locales?.length ? input.locales : [input.defaultLocale];
  if (!locales.includes(input.defaultLocale)) {
    throw new ValidationError([
      { field: 'defaultLocale', message: 'defaultLocale must be included in locales' },
    ]);
  }
  const config: SpaceConfig = {
    spaceId: input.spaceId,
    name: input.name,
    defaultLocale: input.defaultLocale,
    locales,
    fallbacks: input.fallbacks,
  };
  await ctx.store.spaces.create(config);
  const environments = input.environments?.length ? input.environments : ['main'];
  for (const env of environments) {
    await ctx.store.spaces.createEnvironment(input.spaceId, env, env);
  }
  // Every space starts with the built-in role presets (Viewer … Administrator).
  await ensureRolePresets(ctx, input.spaceId);
  return config;
}

/** Reads a space's configuration (locales, default locale, fallbacks). */
export async function getSpaceConfig(ctx: AppContext, scope: Scope): Promise<SpaceConfig> {
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  return config;
}

/** All spaces (admin view). */
export async function listSpaces(ctx: AppContext): Promise<SpaceConfig[]> {
  return ctx.store.spaces.list();
}

/** Adds an environment (branch) to an existing space. */
export async function createEnvironment(
  ctx: AppContext,
  spaceId: string,
  environmentId: string,
  name?: string,
): Promise<void> {
  await ctx.store.spaces.createEnvironment(spaceId, environmentId, name ?? environmentId);
}

/** Lists a space's environments (branches). */
export async function listEnvironments(ctx: AppContext, spaceId: string) {
  return ctx.store.spaces.listEnvironments(spaceId);
}

/** Entry ids per `environment.deleted` event (keeps each outbox row and queue message small). */
export const ENVIRONMENT_DELETED_CHUNK = 500;

export interface DeletedEnvironment {
  readonly environmentId: string;
  /** Published entries whose search documents and vectors the engine removes. */
  readonly publishedEntries: number;
}

/**
 * Deletes an environment and everything in it (its audit history stays). Refuses `main`, an
 * unknown environment, and one an alias points at (repoint or remove the alias first, so delivery
 * under the alias never breaks). The rows go in one atomic write with `environment.deleted`
 * events, from which the engine removes the published entries' search documents and vectors and
 * purges the environment's delivery cache. `confirm` must repeat the environment's id: deleting
 * one is irreversible, and an agent (or a script) shouldn't do it by a slip of an argument.
 */
export async function deleteEnvironment(
  ctx: AppContext,
  spaceId: string,
  environmentId: string,
  opts: { readonly confirm?: string } = {},
): Promise<DeletedEnvironment> {
  if (opts.confirm !== environmentId) {
    throw new ValidationError([
      {
        field: 'confirm',
        message: `Deleting an environment is irreversible: pass confirm="${environmentId}" to proceed`,
      },
    ]);
  }
  if (environmentId === 'main') {
    throw new ValidationError([
      { field: 'environmentId', message: 'The main environment cannot be deleted' },
    ]);
  }
  const environments = await ctx.store.spaces.listEnvironments(spaceId);
  if (!environments.some((e) => e.id === environmentId)) {
    throw new NotFoundError('Environment', environmentId);
  }
  const aliases = (await ctx.store.spaces.listAliases(spaceId)).filter(
    (a) => a.targetEnvironmentId === environmentId,
  );
  if (aliases.length > 0) {
    throw new ConflictError(
      `Environment "${environmentId}" is the target of ${aliases.map((a) => `"${a.alias}"`).join(', ')}; repoint or remove the alias first`,
    );
  }

  const scope: Scope = { spaceId, environmentId };
  const published = await allPages((skip, limit) =>
    ctx.store.entries.listPublished(scope, { skip, limit }),
  );
  const ids = published.map((p) => p.entryId);
  const occurredAt = ctx.clock.now().toISOString();
  const chunks: string[][] = [];
  for (let at = 0; at < ids.length; at += ENVIRONMENT_DELETED_CHUNK) {
    chunks.push(ids.slice(at, at + ENVIRONMENT_DELETED_CHUNK));
  }
  // At least one event, even for an empty environment: its delivery cache is purged either way.
  const events: DomainEvent[] = (chunks.length > 0 ? chunks : [[]]).map((entryIds) => ({
    id: ctx.ids.newId(),
    type: 'environment.deleted',
    scope,
    occurredAt,
    entryIds,
  }));
  await ctx.store.spaces.deleteEnvironment(spaceId, environmentId, events);
  return { environmentId, publishedEntries: ids.length };
}

// --- environment aliases (blue/green) --------------------------------------

async function requireEnvironment(ctx: AppContext, spaceId: string, environmentId: string) {
  const envs = await ctx.store.spaces.listEnvironments(spaceId);
  if (!envs.some((e) => e.id === environmentId)) {
    throw new NotFoundError('Environment', `${spaceId}/${environmentId}`);
  }
}

/**
 * Creates or atomically repoints an environment alias at a target environment.
 * Rejects an alias whose name collides with a real environment (so resolution is
 * never ambiguous) and a target that doesn't exist. Repointing is how blue/green
 * cutover works: flip the alias from the old env to the new one in one write.
 */
export async function setEnvironmentAlias(
  ctx: AppContext,
  spaceId: string,
  alias: string,
  targetEnvironmentId: string,
): Promise<EnvironmentAlias> {
  await requireEnvironment(ctx, spaceId, targetEnvironmentId);
  const envs = await ctx.store.spaces.listEnvironments(spaceId);
  if (envs.some((e) => e.id === alias)) {
    throw new InvalidStateError(
      `"${alias}" is already an environment; an alias cannot share its name`,
    );
  }
  const at = ctx.clock.now().toISOString();
  await ctx.store.spaces.setAlias(spaceId, alias, targetEnvironmentId, at);
  await announceAliasChange(ctx, spaceId, alias, targetEnvironmentId);
  return { alias, targetEnvironmentId, updatedAt: at };
}

/** Lists a space's environment aliases. */
export async function listEnvironmentAliases(
  ctx: AppContext,
  spaceId: string,
): Promise<EnvironmentAlias[]> {
  return ctx.store.spaces.listAliases(spaceId);
}

export async function deleteEnvironmentAlias(
  ctx: AppContext,
  spaceId: string,
  alias: string,
): Promise<void> {
  if (!(await ctx.store.spaces.getAlias(spaceId, alias))) {
    throw new NotFoundError('EnvironmentAlias', `${spaceId}/${alias}`);
  }
  await ctx.store.spaces.deleteAlias(spaceId, alias);
  await announceAliasChange(ctx, spaceId, alias, null);
}

/**
 * Appends `environment_alias.changed` so caches keyed by the alias are purged. Appended after the
 * change rather than with it (the spaces repo is not part of a unit of work): if it is lost,
 * delivery under the alias goes stale only until its cached responses' max-age.
 */
async function announceAliasChange(
  ctx: AppContext,
  spaceId: string,
  alias: string,
  targetEnvironmentId: string | null,
): Promise<void> {
  await ctx.store.outbox.append({
    id: ctx.ids.newId(),
    type: 'environment_alias.changed',
    scope: { spaceId, environmentId: alias },
    occurredAt: ctx.clock.now().toISOString(),
    targetEnvironmentId,
  });
}

/**
 * Resolves an environment-or-alias name to a concrete environment id. If the
 * name is a registered alias it returns the alias target; otherwise it returns
 * the name unchanged (a direct environment reference). This is the single seam
 * the API uses so an alias works anywhere `:env` does.
 */
export async function resolveEnvironment(
  ctx: AppContext,
  spaceId: string,
  envOrAlias: string,
): Promise<string> {
  const alias = await ctx.store.spaces.getAlias(spaceId, envOrAlias);
  return alias?.targetEnvironmentId ?? envOrAlias;
}
