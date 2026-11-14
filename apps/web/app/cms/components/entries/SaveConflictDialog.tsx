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
import { Button } from '@contentworker/ui/button';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { Ago } from '~/cms/components/ago';
import { RevisionDiff } from '~/cms/components/RevisionDiff';
import { actorLabel } from '~/cms/lib/authorship';
import { useClient } from '~/cms/lib/client-context';
import type { PrincipalInfo, TeamSummary } from '~/cms/lib/management';
import { useScopedQuery } from '~/cms/lib/queries';

/**
 * A draft save refused because someone saved the entry after it was opened (a 409 from
 * `expectedVersion`), and the honest way on: keep editing, load their version (what is typed
 * here is discarded), or save over theirs (it stays in the version history, to restore). The
 * entry form and the canvas editor both ask this; neither ever overwrites a save unseen.
 *
 * It names who saved their version and when (the version's own record, worded as every writer is,
 * `actorLabel`), and See what changed shows their version against the one the edits started from
 * before anything is chosen. Keep editing is the safe answer, so it is the primary one and has
 * focus: both others discard something, one here and one there. The entry is the route's
 * (`:entryId`), as both editors are routed.
 */
export function SaveConflictDialog(props: {
  readonly open: boolean;
  /** The version the entry is at now, as the refusal said. */
  readonly theirs: number;
  /** The version the edits were made from. */
  readonly mine: number;
  /** Where the edits are: "the form", "the canvas". */
  readonly where: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onLoadTheirs: () => void;
  readonly onSaveOver: () => void;
}) {
  const { theirs, mine } = props;
  const { client, conn } = useClient();
  const entryId = useParams().entryId;
  const known = props.open && !!entryId && theirs > 0;
  const [comparing, setComparing] = useState(false);
  // Each refusal starts with the comparison closed.
  useEffect(() => {
    if (!props.open) setComparing(false);
  }, [props.open]);

  // Who's who, as the editor already read it (its own keys): read from the cache, never fetched
  // again here, since a refetch of the person's access re-reads what the editor's form may edit.
  // The team is read only for an administrator; without it a teammate reads as one.
  const cache = useQueryClient();
  const access = cache.getQueryData<PrincipalInfo>([conn.space, conn.environment, 'space-access']);
  const team = cache.getQueryData<TeamSummary>([conn.space, conn.environment, 'team']);
  const version = useScopedQuery(
    ['entry-version', entryId, theirs],
    () => client.getVersion(entryId as string, theirs),
    { enabled: known, silent: true },
  );
  const diff = useScopedQuery(
    ['entry-version-diff', entryId, mine, theirs],
    () => client.diffVersions(entryId as string, mine, theirs),
    { enabled: known && comparing, silent: true },
  );

  const saved = version.data;
  const who = saved?.createdBy
    ? actorLabel(saved.createdBy, { me: access?.subject, people: team?.people })
    : null;
  const keep = useRef<HTMLButtonElement>(null);
  const changesId = useId();

  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent
        className="sm:max-w-xl"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          keep.current?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Someone saved this entry while you worked</AlertDialogTitle>
          <AlertDialogDescription>
            It’s at v{theirs} now, and {props.where} started from v{mine}. Load theirs to carry on
            from it (your edits here are discarded), or save yours over it: theirs stays in the
            version history, and can be restored from there.
          </AlertDialogDescription>
          {saved && (who || saved.createdAt) ? (
            <p className="text-sm">
              {who ? `${who} saved v${theirs}` : `v${theirs} was saved`}
              {saved.createdAt ? (
                <span className="text-muted-foreground">
                  {' · '}
                  <Ago at={saved.createdAt} />
                </span>
              ) : null}
            </p>
          ) : null}
        </AlertDialogHeader>
        {entryId ? (
          <div className="min-w-0 space-y-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={comparing}
              aria-controls={comparing ? changesId : undefined}
              onClick={() => setComparing((c) => !c)}
            >
              {comparing ? 'Hide what changed' : 'See what changed'}
            </Button>
            {comparing ? (
              // Its own scroller, so a long diff never pushes the answers off the dialog; it
              // takes focus so a keyboard can scroll it.
              <section
                id={changesId}
                aria-label={`What changed from v${mine} to v${theirs}`}
                // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard.
                tabIndex={0}
                className="cw-scroll cw-scroll-cue -m-1 max-h-72 min-w-0 overflow-y-auto rounded-sm p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {diff.data ? (
                  <RevisionDiff diff={diff.data} fromLabel={`v${mine}`} toLabel={`v${theirs}`} />
                ) : diff.isError ? (
                  <p className="text-sm">
                    Couldn’t load what changed.{' '}
                    <Button
                      type="button"
                      variant="link"
                      size="xs"
                      className="px-0"
                      onClick={() => void diff.refetch()}
                    >
                      Try again
                    </Button>
                  </p>
                ) : (
                  <p className="text-muted-foreground text-sm">Comparing…</p>
                )}
              </section>
            ) : null}
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={props.onSaveOver}>Save mine over it</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={props.onLoadTheirs}>
            Load theirs
          </AlertDialogAction>
          <AlertDialogAction ref={keep} variant="default">
            Keep editing
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
