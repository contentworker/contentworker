import { Button } from '@contentworker/ui/button';
import { ArchiveRestore, CircleSlash, Send, Trash2, X } from 'lucide-react';

/**
 * What can be done to the ticked entries at once, in place of the filter bar while anything is
 * ticked, and held under the shell's header as the list scrolls. It offers only what applies:
 * Publish while a ticked entry isn't live as it is (a draft or changed), Unpublish while one is
 * live, Move to trash for any. In the trash it offers Restore and Delete permanently instead.
 * Labelled as the asset library's bar is ("2 selected", "Publish selected").
 */
export function EntryBulkBar(props: {
  count: number;
  /** How many ticked entries each action would change. */
  publishable?: number;
  unpublishable?: number;
  busy: boolean;
  onPublish?: () => void;
  onUnpublish?: () => void;
  /** The list's bar: move the ticked entries to the trash. */
  onTrash?: () => void;
  /** The trash's bar: bring them back as drafts, or delete them for good. */
  onRestore?: () => void;
  onPurge?: () => void;
  onClear: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of buttons, not a form fieldset
    <div
      role="group"
      aria-label="Selected entries"
      className="flex min-h-12 flex-wrap items-center gap-2 rounded-2xl bg-muted px-3 py-2 animate-arrive"
    >
      <span className="text-muted-foreground text-sm">{props.count} selected</span>
      {props.onPublish && (props.publishable ?? 0) > 0 ? (
        <Button type="button" size="sm" disabled={props.busy} onClick={props.onPublish}>
          <Send aria-hidden="true" />
          Publish selected
        </Button>
      ) : null}
      {props.onUnpublish && (props.unpublishable ?? 0) > 0 ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={props.busy}
          onClick={props.onUnpublish}
        >
          <CircleSlash aria-hidden="true" />
          Unpublish selected
        </Button>
      ) : null}
      {props.onTrash ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={props.busy}
          onClick={props.onTrash}
        >
          <Trash2 aria-hidden="true" />
          Move to trash
        </Button>
      ) : null}
      {props.onRestore ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={props.busy}
          onClick={props.onRestore}
        >
          <ArchiveRestore aria-hidden="true" />
          Restore selected
        </Button>
      ) : null}
      {props.onPurge ? (
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={props.busy}
          onClick={props.onPurge}
        >
          <Trash2 aria-hidden="true" />
          Delete permanently…
        </Button>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="ml-auto"
        onClick={props.onClear}
        aria-label="Clear selection"
      >
        <X aria-hidden="true" />
        Clear
      </Button>
    </div>
  );
}
