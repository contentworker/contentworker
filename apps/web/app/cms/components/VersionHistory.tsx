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
import { Button } from '@contentworker/ui/button';
import { cn } from '@contentworker/ui/lib/utils';
import { SkeletonPill, SkeletonText } from '@contentworker/ui/skeleton';
import { History, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Ago } from '~/cms/components/ago';
import { CollapsibleCard } from '~/cms/components/CollapsibleCard';
import { LoadingStatus } from '~/cms/components/loading';
import { ToneBadge } from '~/cms/components/status';
import { useAssistantEdit } from '../lib/assistant';
import { useClient, useLocalRun } from '../lib/client-context';
import type { VersionDiff } from '../lib/management';
import { useInvalidate, useScopedQuery } from '../lib/queries';
import { useToast } from '../lib/toast';

const show = (v: unknown): string =>
  v === undefined || v === null ? '—' : typeof v === 'string' ? v : JSON.stringify(v);

/**
 * Timeline of an entry's saved versions with diff-against-current and restore.
 * Restore appends a NEW version carrying the old fields, so history is never
 * rewritten — after it runs, the parent reloads the form via `onRestored`. It goes through the
 * assistant, as a confirm card in its panel; when the assistant can't be reached, it confirms in
 * its own dialog and restores through the API.
 */
export function VersionHistory(props: {
  entryId: string;
  /** What the assistant's card calls the entry: its title. */
  about?: string;
  /** Current draft version, to flag "current" and pick a diff baseline. */
  currentVersion: number;
  /** Published version (if any), to flag "live". */
  publishedVersion?: number | null;
  /** Whether the editor form holds unsaved edits — restoring discards them,
   * so the confirmation warns before that happens. */
  hasUnsavedChanges?: () => boolean;
  onRestored: () => void;
}) {
  const { client } = useClient();
  const { busy, run } = useLocalRun();
  const toast = useToast();
  const invalidate = useInvalidate();
  const edit = useAssistantEdit();
  const versionsQuery = useScopedQuery(['versions', props.entryId], () =>
    client.listVersions(props.entryId),
  );
  const versions = versionsQuery.data ?? [];
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [diffWith, setDiffWith] = useState<number | null>(null);
  // Version awaiting restore confirmation (restore reseeds the form, so it is
  // never a single-click action).
  const [confirmRestore, setConfirmRestore] = useState<number | null>(null);

  const toggleDiff = (version: number) =>
    run(async () => {
      if (diffWith === version) {
        setDiff(null);
        setDiffWith(null);
        return;
      }
      setDiff(await client.diffVersions(props.entryId, version, props.currentVersion));
      setDiffWith(version);
    });

  // Asks through the assistant's card; without it, through this panel's own dialog.
  const requestRestore = (version: number) =>
    run(async () => {
      // The card says what the dialog warned of: restoring discards the form's unsaved edits.
      const what = props.about ? `Version ${version} of ${props.about}` : `Version ${version}`;
      const unsaved = props.hasUnsavedChanges?.()
        ? ' · unsaved edits in the form are discarded'
        : '';
      const r = await edit(
        'entries_restore_version',
        // Held to the draft on screen: one saved since makes the card refuse.
        { id: props.entryId, version, expectedVersion: props.currentVersion },
        what + unsaved,
      );
      if (r === null) setConfirmRestore(version);
      else if ('output' in r) await restored(version);
    });

  const restore = (version: number) =>
    run(async () => {
      await client.restoreVersion(props.entryId, version);
      await restored(version);
    });

  const restored = async (version: number) => {
    toast.success(`Restored version ${version} as a new draft`);
    setDiff(null);
    setDiffWith(null);
    setConfirmRestore(null);
    await invalidate(['versions', props.entryId]);
    props.onRestored();
  };

  return (
    <CollapsibleCard
      title={
        <>
          <History className="size-4" />
          Version history
        </>
      }
      contentClassName="space-y-3"
    >
      {versionsQuery.isLoading ? (
        <>
          <LoadingStatus>Loading versions…</LoadingStatus>
          <ul className="space-y-1">
            {[0, 1, 2].map((i) => (
              <li key={i} aria-hidden="true" className="rounded-md border px-3 py-2">
                <div className="flex min-h-8 items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">
                      <SkeletonText width="1.5rem" />
                    </span>
                    {i === 0 ? <SkeletonPill className="w-14" /> : null}
                    <span className="text-xs">
                      <SkeletonText width="4rem" />
                    </span>
                  </div>
                  {i === 0 ? null : <SkeletonPill className="h-8 w-[5.5rem]" />}
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : versions.length === 0 ? (
        <p className="text-muted-foreground text-sm">No versions yet.</p>
      ) : (
        <ul className="space-y-1">
          {versions.map((v) => {
            const isCurrent = v.version === props.currentVersion;
            const isPublished = v.version === props.publishedVersion;
            return (
              <li key={v.version} className="rounded-md border px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">v{v.version}</span>
                    {isCurrent && <Badge variant="secondary">current</Badge>}
                    {isPublished && <ToneBadge tone="ok" label="Live" />}
                    <span className="text-muted-foreground text-xs">
                      {v.createdAt ? <Ago at={v.createdAt} /> : null}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    {!isCurrent && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => toggleDiff(v.version)}
                        disabled={busy}
                      >
                        {diffWith === v.version ? 'Hide diff' : 'Diff'}
                      </Button>
                    )}
                    {!isCurrent && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void requestRestore(v.version)}
                        disabled={busy}
                      >
                        <RotateCcw className="size-3.5" />
                        Restore
                      </Button>
                    )}
                  </div>
                </div>

                {diffWith === v.version && diff && (
                  <div className="mt-2 space-y-1 border-t pt-2">
                    <p className="text-muted-foreground text-xs">
                      v{diff.from} → v{diff.to} (current)
                    </p>
                    {diff.changes.filter((c) => c.kind !== 'unchanged').length === 0 ? (
                      <p className="text-muted-foreground text-sm">No field changes.</p>
                    ) : (
                      diff.changes
                        .filter((c) => c.kind !== 'unchanged')
                        .map((c) => (
                          <div key={c.field} className="text-sm">
                            <span className="font-medium">{c.field}</span>{' '}
                            <Badge variant="outline" className="capitalize">
                              {c.kind}
                            </Badge>
                            <div className="grid grid-cols-2 gap-2 text-xs">
                              <span
                                className={cn(
                                  'truncate text-muted-foreground',
                                  c.kind === 'removed' && 'text-destructive',
                                )}
                              >
                                {show(c.before).slice(0, 120)}
                              </span>
                              <span className="truncate">{show(c.after).slice(0, 120)}</span>
                            </div>
                          </div>
                        ))
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <AlertDialog
        open={confirmRestore !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmRestore(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore version {confirmRestore}?</AlertDialogTitle>
            <AlertDialogDescription>
              Version {confirmRestore}’s fields become a new draft version; history is kept.
              {props.hasUnsavedChanges?.() ? ' Unsaved edits in the form will be discarded.' : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep current draft</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                if (confirmRestore !== null) void restore(confirmRestore);
              }}
            >
              Restore version
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </CollapsibleCard>
  );
}
