/**
 * The one quiet line that says Coworker's proposal is on the page (the canvas and the Site pane):
 * marked "Proposed" there, decided in Coworker's card, and nothing saved until it is confirmed. Or,
 * when the page can't show it, that the card is where to review it. Always in the tree, so a screen
 * reader hears it when its words arrive; empty while nothing is proposed.
 */
import { cn } from '@contentworker/ui/lib/utils';
import { Mark } from '~/components/mark';

export function ProposalLine({
  waiting,
  shown,
  refused,
  unsupported,
  saving = false,
  className,
}: {
  /** A Coworker card for this entry waits for an answer, or is saving what was confirmed. */
  waiting: boolean;
  /** Confirmed: its save is under way. */
  saving?: boolean;
  /** The page draws its blocks now. */
  shown: boolean;
  /** The page couldn't show it. */
  refused: boolean;
  /** The page's SDK doesn't show proposals. */
  unsupported: boolean;
  className?: string;
}) {
  const text = !waiting
    ? ''
    : saving
      ? 'Saving Coworker’s proposal: the page shows the entry as saved once it lands.'
      : shown
        ? 'Coworker’s proposal is on the page, marked Proposed. Nothing is saved until you confirm it in Coworker; Not now takes it off.'
        : refused
          ? 'The page couldn’t show Coworker’s proposal. Review it in Coworker before you confirm.'
          : unsupported
            ? 'This site’s ContentWorker SDK doesn’t show proposals on the page. Review it in Coworker before you confirm.'
            : '';
  return (
    <p
      role="status"
      data-proposal-line={text ? (shown ? 'shown' : 'card') : undefined}
      className={cn(
        'flex items-start gap-2 text-muted-foreground text-xs empty:hidden',
        text ? className : undefined,
      )}
    >
      {text ? (
        <>
          <Mark className="mt-px size-3.5 shrink-0 text-ai" />
          <span>{text}</span>
        </>
      ) : null}
    </p>
  );
}
