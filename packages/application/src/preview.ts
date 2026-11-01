import { NotFoundError, type Scope } from '@contentworker/domain';
import type { EntryQuery } from '@contentworker/ports';
import type { AppContext } from './context';
import { localeFallbackChain, type RenderOptions } from './delivery';
import { renderFields } from './render';

/** A previewed entry: the current (draft) version, including its status. */
export interface PreviewedEntry {
  readonly id: string;
  readonly contentType: string;
  readonly status: string;
  readonly version: number;
  readonly fields: Record<string, unknown>;
}

async function spaceConfig(ctx: AppContext, scope: Scope) {
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  return config;
}

/**
 * Read path for the Preview API (CPA). Serves the current/draft version of an
 * entry — what an editor sees before publishing — rather than the published
 * snapshot.
 */
export async function getPreviewEntry(
  ctx: AppContext,
  scope: Scope,
  id: string,
  opts: RenderOptions = {},
): Promise<PreviewedEntry> {
  const found = await ctx.store.entries.get(scope, id);
  if (!found) throw new NotFoundError('Entry', id);
  const config = await spaceConfig(ctx, scope);
  return {
    id: found.entry.id,
    contentType: found.entry.contentTypeApiId,
    status: found.entry.status,
    version: found.entry.currentVersion,
    fields: renderFields(found.fields, config, opts.locale),
  };
}

export async function listPreviewEntries(
  ctx: AppContext,
  scope: Scope,
  query: EntryQuery = {},
  opts: RenderOptions = {},
): Promise<PreviewedEntry[]> {
  const config = await spaceConfig(ctx, scope);
  const locale = query.locale ?? opts.locale ?? config.defaultLocale;
  const rows = await ctx.store.entries.list(scope, {
    ...query,
    locale,
    fallbackLocales: localeFallbackChain(config, locale),
  });
  return rows.map((found) => ({
    id: found.entry.id,
    contentType: found.entry.contentTypeApiId,
    status: found.entry.status,
    version: found.entry.currentVersion,
    fields: renderFields(found.fields, config, opts.locale),
  }));
}

/** One entry, reduced to what a chooser shows. */
export interface EntrySuggestion {
  readonly id: string;
  readonly contentType: string;
  readonly status: string;
  /** The display field's value in the requested locale, or the id when it has none. */
  readonly title: string;
}

/** How many suggestions one call returns, and the ceiling a caller can ask for. */
export const SUGGEST_DEFAULT_LIMIT = 20;
export const SUGGEST_MAX_LIMIT = 50;

export interface SuggestEntriesInput {
  /** What the person has typed so far. Empty returns the most recent entries. */
  readonly q?: string;
  /** Restrict to one content type — which is what a reference field always wants. */
  readonly contentTypeApiId?: string;
  readonly locale?: string;
  readonly limit?: number;
}

/**
 * Entries matching what someone is typing, resolved server-side.
 *
 * This exists because a chooser cannot be built by listing entries and
 * filtering in the browser: the list endpoint is capped, so on a space with
 * more entries than one page, the ones past the cap are simply unreachable —
 * not slow to find, *impossible* to pick. Matching where the data is turns a
 * silent ceiling into an ordinary query.
 *
 * Matches on the content type's display field, because that is the string a
 * person is typing when they are looking for an entry. Cross-type search over
 * every field is a different question, and the search endpoints answer it.
 */
export async function suggestEntries(
  ctx: AppContext,
  scope: Scope,
  input: SuggestEntriesInput = {},
): Promise<EntrySuggestion[]> {
  const limit = Math.min(Math.max(input.limit ?? SUGGEST_DEFAULT_LIMIT, 1), SUGGEST_MAX_LIMIT);
  const config = await spaceConfig(ctx, scope);
  const locale = input.locale ?? config.defaultLocale;

  const types = input.contentTypeApiId
    ? [await ctx.store.contentTypes.get(scope, input.contentTypeApiId)].filter(
        (t): t is NonNullable<typeof t> => t !== null,
      )
    : await ctx.store.contentTypes.list(scope);
  if (types.length === 0) return [];

  const q = input.q?.trim() ?? '';
  // One query per content type, because the field to match on is per type.
  // Bounded by the number of types in a space, which is a modelling decision
  // rather than a data volume — unlike entries, which is why this is not the
  // shape that was failing.
  const perType = await Promise.all(
    types.map(async (type) => {
      const entries = await ctx.store.entries.list(scope, {
        contentTypeApiId: type.apiId,
        limit,
        archived: false,
        ...(q ? { filters: [{ field: type.displayField, op: 'match' as const, value: q }] } : {}),
      });
      return entries.map((found) => ({
        id: found.entry.id,
        contentType: type.apiId,
        status: found.entry.status,
        title: titleOf(found.fields[type.displayField], locale, config, found.entry.id),
      }));
    }),
  );

  return perType.flat().slice(0, limit);
}

/** The display value a person recognises, or the id when the field is empty. */
function titleOf(
  value: unknown,
  locale: string,
  config: { defaultLocale: string; locales: readonly string[]; fallbacks?: unknown },
  fallback: string,
): string {
  const localized = value as Record<string, unknown> | undefined;
  const resolved = localized?.[locale] ?? localized?.[config.defaultLocale];
  return typeof resolved === 'string' && resolved ? resolved : fallback;
}
