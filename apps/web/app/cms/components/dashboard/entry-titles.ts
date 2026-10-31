import type { ContentType } from '@contentworker/domain';
import type { PreviewEntry } from '../../lib/management';

/** What a dashboard row needs to name and link an entry. */
export interface EntryRef {
  readonly id: string;
  readonly contentType: string;
  readonly typeName: string;
  readonly title: string;
  readonly status: string;
}

/**
 * Resolves an entry to the title an editor recognises: its display field in
 * `locale`, else any locale's value, else a short id. Preview list fields keep
 * the localized `{ field: { locale: value } }` shape.
 */
export function entryRef(
  entry: PreviewEntry,
  types: readonly ContentType[],
  locale: string,
): EntryRef {
  const type = types.find((t) => t.apiId === entry.contentType);
  const raw = type?.displayField ? entry.fields[type.displayField] : undefined;
  let title: unknown = raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const byLocale = raw as Record<string, unknown>;
    title = byLocale[locale] ?? Object.values(byLocale).find((v) => typeof v === 'string' && v);
  }
  return {
    id: entry.id,
    contentType: entry.contentType,
    typeName: type?.name ?? entry.contentType,
    title: typeof title === 'string' && title.trim() ? title : `Untitled · ${entry.id.slice(0, 8)}`,
    status: entry.status,
  };
}

export const entryPath = (e: { contentType: string; id: string }) =>
  `/content/${e.contentType}/${e.id}`;

/** "Nov 2, 14:00" — short, local, no seconds. */
export function shortDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
