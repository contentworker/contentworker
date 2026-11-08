import {
  type BlockCatalog,
  type BlockConfig,
  blockConfigIssues,
  blockVariants,
  ConflictError,
  type ContentType,
  canonicalJson,
  checkBlockConfig,
  diffBlockConfigs,
  type EffectiveBlockRules,
  EMPTY_BLOCK_CONFIG,
  type EntryFields,
  effectiveBlockRules,
  type LocaleCode,
  type Scope,
  ValidationError,
} from '@contentworker/domain';
import { TransactionConflictError } from '@contentworker/ports';
import { auditActor } from './audit';
import { assertContentTypeCaller, type ContentTypeCaller, SYSTEM_CALLER } from './content-types';
import type { AppContext } from './context';

/**
 * The block config (see `@contentworker/domain`'s block-config module): what an environment's
 * admins allow of the blocks the catalog provides, only ever narrower than the code. Setting it
 * needs `content:manage`, as pushing the catalog does, checked by the surfaces; reading it and
 * the rules in force needs what reading the catalog does.
 *
 * Every entry save holds new edits to it (`assertBlockConfigAllows`, from the save path in
 * `entries.ts`), so the editor, the API, MCP, block patches and AI all meet the same refusals.
 */

/** The environment's config: version 0 and empty before the first set. A read: writes nothing. */
export async function getBlockConfig(ctx: AppContext, scope: Scope): Promise<BlockConfig> {
  return (await ctx.store.blockConfigs.get(scope)) ?? EMPTY_BLOCK_CONFIG;
}

/** What `setBlockConfig` takes. `targets` and `blocks` are checked here, whatever sent them. */
export interface SetBlockConfigInput {
  /** The version the config was edited from (0 before the first set): another is a conflict. */
  readonly expectedVersion: number;
  readonly targets: unknown;
  readonly blocks: unknown;
}

/** What a set did: the config in force after it, and whether it wrote a new version. */
export interface BlockConfigSet {
  readonly config: BlockConfig;
  /** The config was already this: nothing written, the version unchanged. */
  readonly unchanged: boolean;
}

/**
 * Replaces the environment's config with `input`, checked against the catalog in force
 * (`checkBlockConfig`: names it has, and only ever narrower), as a new version. Setting the config
 * in force again writes nothing, whatever `expectedVersion` says, so a retried set whose first
 * try landed is a no-op.
 *
 * Refused (409) when `expectedVersion` isn't the version in force, or when another set commits
 * first (the version is the compare-and-set the write rides with); 422 naming each part that
 * names something the catalog doesn't have or widens what it allows.
 */
export async function setBlockConfig(
  ctx: AppContext,
  caller: ContentTypeCaller,
  scope: Scope,
  input: SetBlockConfigInput,
): Promise<BlockConfigSet> {
  assertContentTypeCaller(caller);
  const [stored, catalog] = await Promise.all([
    ctx.store.blockConfigs.get(scope),
    ctx.store.blockCatalogs.latest(scope),
  ]);
  const current = stored ?? EMPTY_BLOCK_CONFIG;
  const { targets, blocks } = checkBlockConfig(input, catalog);
  if (
    canonicalJson({ targets, blocks }) ===
    canonicalJson({ targets: current.targets, blocks: current.blocks })
  ) {
    return { config: current, unchanged: true };
  }
  if (input.expectedVersion !== current.version) {
    throw new ConflictError(
      `The block config is at version ${current.version}, not ${input.expectedVersion}: ` +
        'someone changed it since. Review it again and set it over theirs.',
      { version: current.version },
    );
  }
  const config: BlockConfig = {
    version: current.version + 1,
    targets,
    blocks,
    updatedAt: ctx.clock.now().toISOString(),
    updatedBy: caller === SYSTEM_CALLER ? null : auditActor(caller),
  };
  try {
    await ctx.store.withTransaction(async (tx) => {
      await tx.blockConfigs.save(scope, config);
    });
  } catch (err) {
    if (!(err instanceof TransactionConflictError)) throw err;
    throw new ConflictError('The block config changed while it was being set; try again', {
      version: current.version,
    });
  }
  // Committed: the audit row says what changed, a lock taken off above all.
  ctx.changes?.noteBlockConfig(diffBlockConfigs(current, config));
  return { config, unchanged: false };
}

/**
 * The rules every target and slot of the catalog in force follows once the config is laid over
 * it, with the config's stale parts (what the catalog no longer has), for the canvas and the dock.
 * A read path: it writes nothing.
 */
export async function getEffectiveBlockRules(
  ctx: AppContext,
  scope: Scope,
): Promise<EffectiveBlockRules> {
  const [config, catalog] = await Promise.all([
    getBlockConfig(ctx, scope),
    ctx.store.blockCatalogs.latest(scope),
  ]);
  return effectiveBlockRules(catalog, config);
}

/** The config and the catalog a type's saves are judged by, when there is anything to judge. */
export interface BlockRulesInForce {
  readonly config: BlockConfig;
  readonly catalog: BlockCatalog;
}

/**
 * What a save of `contentType` is held to, read only when it can matter: nothing for a type
 * with no blocks field (no statement), else one statement (`blockConfigs.inForce`) that answers
 * nothing when the environment has no config, and the config with the catalog in force when it
 * has one. Null when nothing applies: no config, none that touches the type, or a type the
 * catalog doesn't target. A caller saving many entries of one type reads this once.
 */
export async function loadBlockRules(
  ctx: AppContext,
  scope: Scope,
  contentType: ContentType,
): Promise<BlockRulesInForce | null> {
  if (!contentType.fields.some((f) => blockVariants(f) !== undefined)) return null;
  const held = await ctx.store.blockConfigs.inForce(scope);
  if (!held?.catalog) return null;
  const { config, catalog } = held;
  // A block narrowing applies wherever its block is placed; a target one only to its own type.
  const touches =
    config.blocks.length > 0 ||
    config.targets.some((t) => t.contentTypeApiId === contentType.apiId);
  if (!touches || !catalog.targets.some((t) => t.contentTypeApiId === contentType.apiId)) {
    return null;
  }
  return { config, catalog };
}

/**
 * Refuses (422) a save whose new edits the block config doesn't allow (`blockConfigIssues`):
 * a block placed where the narrowed list doesn't take it, a locked slot's blocks changed, a count
 * pushed past the narrowed bounds. `before` is the stored fields, undefined for a create. `rules`
 * is what `loadBlockRules` read, when the caller read it already; undefined reads it here.
 */
export async function assertBlockConfigAllows(
  ctx: AppContext,
  scope: Scope,
  contentType: ContentType,
  before: EntryFields | undefined,
  after: EntryFields,
  locales: readonly LocaleCode[],
  rules?: BlockRulesInForce | null,
): Promise<void> {
  const held = rules === undefined ? await loadBlockRules(ctx, scope, contentType) : rules;
  if (!held) return;
  const issues = blockConfigIssues(contentType, held.catalog, held.config, before, after, locales);
  if (issues.length > 0) throw new ValidationError(issues);
}
