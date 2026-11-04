import type { ContentType, FieldDiff } from '@contentworker/domain';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@contentworker/ui/alert-dialog';
import { Badge } from '@contentworker/ui/badge';
import { cn } from '@contentworker/ui/lib/utils';
import { humanize } from '../../lib/format';
import type { ManagementClient, PreviewEntry } from '../../lib/management';
import { EntryDiff } from '../EntryDiff';

export interface PublishConfirmProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
  /** What the entry is called (its display field, or "Untitled entry"). */
  readonly title: string;
  readonly contentType: ContentType;
  /** The entry's status before publishing: `draft` has nothing live to compare with. */
  readonly status: string | undefined;
  /**
   * Published → current, from the version diff, when the caller knows both versions (the editor,
   * right after a save). Without it, an entry that has been live is compared through `compare`.
   */
  readonly changes?: readonly FieldDiff[] | null;
  /** The draft to compare with what delivery serves, when `changes` isn't known. */
  readonly compare?: {
    readonly client: ManagementClient;
    readonly entry: PreviewEntry;
    readonly locale: string;
  };
  readonly busy: boolean;
  onConfirm(): void;
  /**
   * Where focus goes once the dialog closes, when the control that asked may be gone (a row's
   * Publish disappears once the row is live). Defaults to what was focused when it opened.
   */
  readonly returnFocus?: () => HTMLElement | null | undefined;
}

/**
 * The one publish confirmation, for the editor's Publish and an entries row's alike: it names the
 * entry and says what goes live. A first publish puts the whole entry live; an entry that has been
 * live lists the fields that change (from the version diff when known, else draft against
 * delivery), so publishing reads the same wherever it starts.
 */
export function PublishConfirm(props: PublishConfirmProps) {
  const { changes, compare, status, contentType } = props;
  const firstPublish = status === 'draft';
  const nameOf = (apiId: string) =>
    contentType.fields.find((f) => f.apiId === apiId)?.name ?? humanize(apiId);
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent
        className={cn(!changes && !firstPublish && compare && 'sm:max-w-xl')}
        onCloseAutoFocus={(e) => {
          const target = props.returnFocus?.();
          if (!target?.isConnected) return;
          e.preventDefault();
          target.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Publish “{props.title}”?</AlertDialogTitle>
          <AlertDialogDescription>
            {changes
              ? changes.length === 0
                ? 'The draft matches the published version; publishing re-confirms it.'
                : `${changes.length} ${changes.length === 1 ? 'field goes' : 'fields go'} live:`
              : firstPublish
                ? 'This entry hasn’t been published before, so the whole entry goes live.'
                : compare
                  ? 'The draft replaces what’s live now. Changed fields are listed first.'
                  : 'Everything changed since the last publish goes live.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {changes && changes.length > 0 ? (
          <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
            {changes.map((c) => (
              <li key={c.field} className="flex items-center gap-2">
                <span className="font-medium">{nameOf(c.field)}</span>
                <Badge variant="outline">{humanize(c.kind)}</Badge>
              </li>
            ))}
          </ul>
        ) : !changes && !firstPublish && compare ? (
          <div className="max-h-[50dvh] min-w-0 overflow-y-auto">
            <EntryDiff client={compare.client} entry={compare.entry} locale={compare.locale} />
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Keep as draft</AlertDialogCancel>
          <AlertDialogAction variant="default" disabled={props.busy} onClick={props.onConfirm}>
            Publish entry
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
