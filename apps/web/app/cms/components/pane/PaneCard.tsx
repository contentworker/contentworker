import { Card, CardContent, CardHeader } from '@contentworker/ui/card';
import { cn } from '@contentworker/ui/lib/utils';
import { ChevronRight } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import type { ReactNode } from 'react';
import { useCardOpen } from './use-card-open';

const heading = 'font-heading font-medium text-base';

/**
 * One of the side pane's cards. Folded (`rememberAs`), its heading holds the trigger, led by a
 * chevron that turns as it opens, as the entry form's folded groups are, and whether it is open is
 * kept per browser; a closed card unmounts its body, which also defers its reads until it is
 * first opened. A caller that opens it from elsewhere passes `open` and `onOpenChange`. Without
 * `rememberAs` it is a plain card that never folds: the panels an editor works in all day.
 */
export function PaneCard(props: {
  title: ReactNode;
  /** A muted line under the title, shown folded too. */
  description?: ReactNode;
  /** The name its open state is kept under; leave it out for a card that never folds. */
  rememberAs?: string;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  contentClassName?: string;
  children: ReactNode;
}) {
  const controlled = props.open !== undefined;
  // A caller holding `open` keeps it (and remembers it) itself.
  const [kept, setKept] = useCardOpen(
    controlled ? undefined : props.rememberAs,
    props.defaultOpen ?? false,
  );
  const description = props.description ? (
    <p className="text-muted-foreground text-sm">{props.description}</p>
  ) : null;

  if (!props.rememberAs && !controlled) {
    return (
      <Card>
        <CardHeader>
          <h2 className={cn(heading, 'flex items-center gap-2')}>{props.title}</h2>
          {description}
        </CardHeader>
        <CardContent className={props.contentClassName}>{props.children}</CardContent>
      </Card>
    );
  }

  return (
    <Collapsible.Root
      open={props.open ?? kept}
      onOpenChange={controlled ? props.onOpenChange : setKept}
    >
      <Card>
        <CardHeader>
          <h2 className={heading}>
            <Collapsible.Trigger className="group -ml-1 flex w-full items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ChevronRight
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
              />
              <span className="flex min-w-0 flex-wrap items-center gap-x-2">{props.title}</span>
            </Collapsible.Trigger>
          </h2>
          {description}
        </CardHeader>
        <Collapsible.Content>
          <CardContent className={props.contentClassName}>{props.children}</CardContent>
        </Collapsible.Content>
      </Card>
    </Collapsible.Root>
  );
}
