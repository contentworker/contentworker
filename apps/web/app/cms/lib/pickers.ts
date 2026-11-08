import { useCallback, useMemo } from 'react';
import type { Pickers, PickOption } from '../components/EntryForm';
import { useClient } from './client-context';
import { useAllEntriesQuery, useAssetsQuery, useContentTypesQuery } from './queries';

/**
 * What a Link field's picker offers (every entry and asset the list endpoints return, labelled in
 * the connection's locale), and a server-side search for the entries beyond that first page. Both
 * are best-effort: a field editor still works without them. The entry editor and the canvas
 * inspector share it.
 */
export function useEntryPickers(): {
  readonly pickers: Pickers;
  readonly searchEntries: (
    query: string,
    contentTypes?: readonly string[],
  ) => Promise<PickOption[]>;
} {
  const { client, conn } = useClient();
  const types = useContentTypesQuery().data;
  const allEntriesQuery = useAllEntriesQuery();
  const assetsQuery = useAssetsQuery();

  /**
   * Resolves reference matches on the server.
   *
   * The seeded `pickers.entries` list is capped by the list endpoint, so
   * filtering it cannot reach an entry beyond that page — not slowly, at all.
   * One request per content type the field allows, because a reference field
   * restricted to two types should not search the rest of the space.
   */
  const searchEntries = useCallback(
    async (query: string, contentTypes?: readonly string[]): Promise<PickOption[]> => {
      const targets = contentTypes?.length ? contentTypes : [undefined];
      const batches = await Promise.all(
        targets.map((contentType) =>
          client.suggestEntries({ q: query, ...(contentType ? { contentType } : {}) }),
        ),
      );
      return batches.flat().map((hit) => ({
        id: hit.id,
        contentType: hit.contentType,
        label: `${hit.title} (${hit.contentType})`,
      }));
    },
    [client],
  );

  const pickers: Pickers = useMemo(() => {
    const displayFieldOf = new Map((types ?? []).map((t) => [t.apiId, t.displayField]));
    return {
      entries: (allEntriesQuery.data ?? []).map((e) => {
        const df = displayFieldOf.get(e.contentType);
        const title = df
          ? (e.fields[df] as Record<string, unknown> | undefined)?.[conn.locale]
          : undefined;
        return {
          id: e.id,
          contentType: e.contentType,
          label: `${String(title ?? e.id)} (${e.contentType})`,
        };
      }),
      assets: (assetsQuery.data ?? []).map((a) => ({
        id: a.id,
        label: String(a.title?.[conn.locale] ?? a.file.fileName),
        mimeType: a.file.contentType,
      })),
    };
  }, [allEntriesQuery.data, assetsQuery.data, types, conn.locale]);

  return { pickers, searchEntries };
}
