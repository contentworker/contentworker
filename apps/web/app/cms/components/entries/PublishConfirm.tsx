import type { FieldDiff } from '@contentworker/domain';
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
import { cn } from '@contentworker/ui/lib/utils';
import type { ManagementClient, PreviewEntry } from '../../lib/management';
import {
  ChangedFields,
  EntryDiff,
  FIRST_PUBLISH,
  fieldsGoLive,
  HiddenChanges,
  hiddenGoLive,
  NO_CHANGES,
  reviewFields,
} from './EntryReview';

export interface PublishConfirmProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
  /** What the entry is called (its display field, or "Untitled entry"). */
  readonly title: string;
  /** The entry's status before publishing: `draft` has nothing live to compare with. */
  readonly status: string | undefined;
  /**
   * Published → current, from the version diff, when the caller knows both versions (the editor,
   * right after a save). Without it, an entry that has been live is compared through `compare`.
   */
  readonly changes?: readonly FieldDiff[] | null;
  /** With `changes`: how many more changed that this person may not read. */
  readonly hiddenChanges?: number;
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
 * live shows each field that changes, published beside draft, from the same review the assistant's
 * card reads (`EntryReview`), so publishing reads the same wherever it starts.
 */
export function PublishConfirm(props: PublishConfirmProps) {
  const { changes, compare, status, hiddenChanges = 0 } = props;
  const firstPublish = status === 'draft';
  const review = !firstPublish && (!changes || changes.length > 0);
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent
        className={cn(review && compare && 'sm:max-w-xl')}
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
                ? hiddenChanges > 0
                  ? hiddenGoLive(hiddenChanges, true)
                  : NO_CHANGES
                : fieldsGoLive(changes.length)
              : firstPublish
                ? FIRST_PUBLISH
                : compare
                  ? 'The draft replaces what’s live now. Changed fields are listed first.'
                  : 'Everything changed since the last publish goes live.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {review && (compare || changes) ? (
          <section
            aria-label="What changes"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard.
            tabIndex={0}
            className="cw-scroll cw-scroll-cue -m-1 max-h-[50dvh] min-w-0 overflow-y-auto rounded-sm p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {compare ? (
              <EntryDiff
                client={compare.client}
                entry={compare.entry}
                locale={compare.locale}
                {...(changes ? { changes, hiddenChanges } : {})}
              />
            ) : changes ? (
              <div className="space-y-3">
                <ChangedFields fields={reviewFields(changes, '')} />
                {hiddenChanges > 0 ? <HiddenChanges count={hiddenChanges} alone={false} /> : null}
              </div>
            ) : null}
          </section>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>
            {firstPublish ? 'Keep as draft' : 'Keep live version'}
          </AlertDialogCancel>
          <AlertDialogAction disabled={props.busy} onClick={props.onConfirm}>
            Publish entry
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
