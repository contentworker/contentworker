import { Button } from '@contentworker/ui/button';
import { CircleSlash, Send, X } from 'lucide-react';

/**
 * What can be done to the ticked entries at once, in place of the filter bar while anything is
 * ticked, and held under the shell's header as the list scrolls. It offers only what applies:
 * Publish while a ticked entry isn't live as it is (a draft or changed), Unpublish while one is
 * live. Labelled as the asset library's bar is ("2 selected", "Publish selected").
 */
export function EntryBulkBar(props: {
  count: number;
  /** How many ticked entries each action would change. */
  publishable: number;
  unpublishable: number;
  busy: boolean;
  onPublish: () => void;
  onUnpublish: () => void;
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
      {props.publishable > 0 ? (
        <Button type="button" size="sm" disabled={props.busy} onClick={props.onPublish}>
          <Send aria-hidden="true" />
          Publish selected
        </Button>
      ) : null}
      {props.unpublishable > 0 ? (
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
