import type { ContentType, ReferenceEdge } from '@contentworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import { Link2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useClient } from '~/cms/lib/client-context';
import { plural } from '~/cms/lib/format';

interface UsedIn {
  readonly entryId: string;
  readonly field: string;
  readonly contentType?: string;
  readonly title: string;
}

/**
 * Why an asset wasn't deleted: the entries that still link to it, each a link to the entry, with
 * archiving offered instead (it stops delivery without breaking those links).
 */
export function AssetInUseNotice(props: {
  name: string;
  usage: readonly ReferenceEdge[];
  types: readonly ContentType[];
  onArchive?: () => void;
  onDismiss: () => void;
}) {
  const { client, conn } = useClient();
  const [rows, setRows] = useState<UsedIn[] | null>(null);

  useEffect(() => {
    let live = true;
    const displayOf = new Map(props.types.map((t) => [t.apiId, t.displayField]));
    void Promise.all(
      props.usage.map(async (u): Promise<UsedIn> => {
        try {
          const entry = await client.getEntry(u.fromEntryId);
          const df = displayOf.get(entry.contentType);
          const title = df
            ? (entry.fields[df] as Record<string, unknown> | undefined)?.[conn.locale]
            : undefined;
          return {
            entryId: u.fromEntryId,
            field: u.fromField,
            contentType: entry.contentType,
            title: String(title ?? u.fromEntryId),
          };
        } catch {
          return { entryId: u.fromEntryId, field: u.fromField, title: u.fromEntryId };
        }
      }),
    ).then((resolved) => live && setRows(resolved));
    return () => {
      live = false;
    };
  }, [client, conn.locale, props.usage, props.types]);

  return (
    <Alert variant="warning">
      <Link2 aria-hidden="true" />
      <AlertTitle>
        “{props.name}” is used by {plural(props.usage.length, 'entry', 'entries')}
      </AlertTitle>
      <AlertDescription>
        <p>Remove it from these entries before deleting it, or archive it to stop delivering it.</p>
        <ul className="space-y-1">
          {(
            rows ??
            props.usage.map(
              (u) =>
                ({ entryId: u.fromEntryId, field: u.fromField, title: u.fromEntryId }) as UsedIn,
            )
          ).map((r) => (
            <li key={`${r.entryId}:${r.field}`} className="flex items-center gap-2">
              {r.contentType ? (
                <Link
                  to={`/content/${r.contentType}/${r.entryId}`}
                  className="font-medium text-link hover:underline"
                >
                  {r.title}
                </Link>
              ) : (
                <span className="font-mono text-xs">{r.entryId}</span>
              )}
              <span className="text-muted-foreground">in</span>
              <span className="font-mono text-xs">{r.field}</span>
            </li>
          ))}
        </ul>
        <div className="flex gap-2 pt-1">
          {props.onArchive && (
            <Button type="button" size="sm" variant="outline" onClick={props.onArchive}>
              Archive instead
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={props.onDismiss}>
            Dismiss
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
