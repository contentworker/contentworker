import type { Asset } from '@contentworker/domain';
import { useCallback, useMemo, useRef } from 'react';
import type { Pickers, PickOption } from '../components/EntryForm';
import { useClient } from './client-context';
import type { PreviewEntry } from './management';
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
  // The client a lookup goes through, read when it runs, so the pickers are a new object only when
  // their lists are. Keyed on the client too, they were rebuilt as the scope settled after
  // hydration, which re-rendered the entry form and, in the live-preview e2e, left a click on the
  // framed page's title without focusing its field.
  const clientRef = useRef(client);
  clientRef.current = client;

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
        title: hit.title,
        label: `${hit.title} (${hit.contentType})`,
      }));
    },
    [client],
  );

  const pickers: Pickers = useMemo(() => {
    const displayFieldOf = new Map((types ?? []).map((t) => [t.apiId, t.displayField]));
    const entryOption = (e: PreviewEntry): PickOption => {
      const df = displayFieldOf.get(e.contentType);
      const value = df
        ? (e.fields[df] as Record<string, unknown> | undefined)?.[conn.locale]
        : undefined;
      // A blank or missing title is no title: the row names the entry by its id instead.
      const title = typeof value === 'string' && value !== '' ? value : undefined;
      return {
        id: e.id,
        contentType: e.contentType,
        ...(title === undefined ? {} : { title }),
        label: `${title ?? e.id} (${e.contentType})`,
      };
    };
    const assetOption = (a: Asset): PickOption => ({
      id: a.id,
      label: String(a.title?.[conn.locale] ?? a.file.fileName),
      mimeType: a.file.contentType,
    });
    return {
      entries: (allEntriesQuery.data ?? []).map(entryOption),
      assets: (assetsQuery.data ?? []).map(assetOption),
      // One lookup per 100 ids (the asset route takes at most 100 too).
      resolve: async (linkType, ids) => {
        const api = clientRef.current;
        if (linkType === 'Entry') return (await api.getEntriesByIds(ids)).map(entryOption);
        const out: PickOption[] = [];
        for (let i = 0; i < ids.length; i += 100) {
          const page = await api.listAssets({ ids: ids.slice(i, i + 100), limit: 100 });
          out.push(...page.items.map(assetOption));
        }
        return out;
      },
    };
  }, [allEntriesQuery.data, assetsQuery.data, types, conn.locale]);

  return { pickers, searchEntries };
}
