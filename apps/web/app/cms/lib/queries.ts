import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useClient } from './client-context';
import type { EntryListQuery } from './management';

/**
 * Query keys and typed hooks for server state, backed by TanStack Query.
 * Every key is prefixed with the connection scope (base URL + space +
 * environment) so switching servers or environments can never serve another
 * scope's cached data. Invalidate with the same factories mutations use.
 */
export function useQueryKeys() {
  const { conn } = useClient();
  const { space, environment } = conn;
  return useMemo(() => {
    const scope = [space, environment] as const;
    return {
      contentTypes: [...scope, 'content-types'] as const,
      spaceConfig: [...scope, 'space-config'] as const,
      /** Prefix for every entries list — invalidate this after any entry mutation. */
      entriesRoot: [...scope, 'entries'] as const,
      entries: (typeId: string | undefined, query: EntryListQuery) =>
        [...scope, 'entries', typeId ?? 'all', query] as const,
      /** Prefix for every entry detail — status/version change on publish, so
       * mutations must invalidate this alongside `entriesRoot`. */
      entryRoot: [...scope, 'entry'] as const,
      entry: (entryId: string) => [...scope, 'entry', entryId] as const,
      /** Prefix for every asset list (the picker's and the library's filtered pages). */
      assets: [...scope, 'assets'] as const,
      assetLibrary: (query: object) => [...scope, 'assets', 'library', query] as const,
      appExtensions: [...scope, 'app-extensions'] as const,
      agentRuns: [...scope, 'agent-runs'] as const,
    };
  }, [space, environment]);
}

/**
 * Generic connection-scoped query for resources that don't need a dedicated
 * hook: `useScopedQuery(['webhooks'], () => client.listWebhooks())`. Segments
 * are appended to the scope tuple, so `useInvalidate()(['webhooks'])` after a
 * mutation refreshes exactly the matching queries.
 */
export function useScopedQuery<T>(
  segments: readonly unknown[],
  queryFn: () => Promise<T>,
  opts?: {
    readonly enabled?: boolean;
    readonly silent?: boolean;
    readonly staleTime?: number;
    /** Keep the last key's data while a new key loads (a lookup whose id set grows or shrinks). */
    readonly keepPrevious?: boolean;
  },
) {
  const { conn } = useClient();
  return useQuery({
    queryKey: [conn.space, conn.environment, ...segments],
    queryFn,
    enabled: opts?.enabled,
    staleTime: opts?.staleTime,
    placeholderData: opts?.keepPrevious ? keepPreviousData : undefined,
    meta: opts?.silent ? { silent: true } : undefined,
  });
}

/** Invalidates one or more scoped key prefixes (same segment shape as `useScopedQuery`). */
export function useInvalidate() {
  const { conn } = useClient();
  const queryClient = useQueryClient();
  const { space, environment } = conn;
  return useCallback(
    (...segmentGroups: readonly (readonly unknown[])[]) =>
      Promise.all(
        segmentGroups.map((segments) =>
          queryClient.invalidateQueries({ queryKey: [space, environment, ...segments] }),
        ),
      ).then(() => undefined),
    [queryClient, space, environment],
  );
}

export function useContentTypesQuery() {
  const { client } = useClient();
  const keys = useQueryKeys();
  return useQuery({ queryKey: keys.contentTypes, queryFn: () => client.listContentTypes() });
}

/** Silent: the layout falls back to the connection's locale when config is missing. */
export function useSpaceConfigQuery() {
  const { client } = useClient();
  const keys = useQueryKeys();
  return useQuery({
    queryKey: keys.spaceConfig,
    queryFn: () => client.getSpaceConfig(),
    meta: { silent: true },
    retry: false,
  });
}

export function useEntriesQuery(typeId: string | undefined, query: EntryListQuery) {
  const { client } = useClient();
  const keys = useQueryKeys();
  return useQuery({
    queryKey: keys.entries(typeId, query),
    queryFn: () => client.listEntries(typeId, query),
    enabled: !!typeId,
    // Keep the previous page visible while a filter change refetches — but only
    // within the same content type; another type's rows must never be shown
    // (or mutated) under this type's header. Index 3 is the key's typeId slot.
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey[3] === (typeId ?? 'all') ? prev : undefined,
  });
}

export function useEntryQuery(entryId: string | undefined) {
  const { client } = useClient();
  const keys = useQueryKeys();
  return useQuery({
    queryKey: keys.entry(entryId ?? ''),
    queryFn: () => client.getEntry(entryId ?? ''),
    enabled: !!entryId,
  });
}

/** Silent: reference pickers are best-effort; the form works without them. */
export function useAllEntriesQuery(opts?: { readonly enabled?: boolean }) {
  const { client } = useClient();
  const keys = useQueryKeys();
  return useQuery({
    queryKey: keys.entries(undefined, {}),
    queryFn: () => client.listEntries(),
    enabled: opts?.enabled,
    meta: { silent: true },
    // Pickers serve the cache instantly but always revalidate on mount, so
    // they reflect creates that happened outside the invalidation paths.
    staleTime: 0,
  });
}

/** Silent: asset pickers are best-effort; the form works without them. */
export function useAssetsQuery() {
  const { client } = useClient();
  const keys = useQueryKeys();
  return useQuery({
    queryKey: keys.assets,
    // A picker shows the newest page; the library pages on with a cursor.
    queryFn: async () => (await client.listAssets({ limit: 100 })).items,
    meta: { silent: true },
    staleTime: 0,
  });
}

/** Silent: UI extensions are optional; the editor works without them. */
export function useAppExtensionsQuery() {
  const { client } = useClient();
  const keys = useQueryKeys();
  return useQuery({
    queryKey: keys.appExtensions,
    queryFn: () => client.listAppExtensions(),
    meta: { silent: true },
  });
}

export function useAgentRunsQuery() {
  const { client } = useClient();
  const keys = useQueryKeys();
  return useQuery({ queryKey: keys.agentRuns, queryFn: () => client.listAgentRuns() });
}

/** Trailing-edge debounce, for keying list queries off fast-changing filter state. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}
