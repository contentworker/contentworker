import { Button } from '@contentworker/ui/button';
import { Input } from '@contentworker/ui/input';
import { Label } from '@contentworker/ui/label';
import { NativeSelect, NativeSelectOption } from '@contentworker/ui/native-select';
import { Segmented, SegmentedItem } from '@contentworker/ui/segmented';
import { useId, useState } from 'react';
import { InlineConfirm } from '~/cms/components/InlineConfirm';
import { useClient } from '~/cms/lib/client-context';
import { plural } from '~/cms/lib/format';
import type { MigrationPublishTarget, MigrationRunView } from '~/cms/lib/management';
import { useScopedQuery } from '~/cms/lib/queries';

/**
 * How a run's entries go out, decided and confirmed on the page: now, or added to a release for
 * someone to ship. Publishing is public at once and the migration doesn't take it back, so the
 * question says so, with the number of entries, and the safe answer holds focus.
 */
export function PublishPlan({
  run,
  entries,
  driven = false,
  viaRelease: mayRelease,
  initial,
  fixed = false,
  returnFocus,
  onCancel,
  onConfirm,
}: {
  run: MigrationRunView['run'];
  /** Loaded entries as of the read made when this was asked. */
  entries: number;
  /** The go-ahead to the background driver, rather than publishing from here. */
  driven?: boolean;
  viaRelease: boolean;
  /** What was answered before, when this asks again. */
  initial: MigrationPublishTarget;
  /** Only `initial` can be answered: it may have been taken already. */
  fixed?: boolean;
  returnFocus: () => HTMLElement | undefined;
  onCancel: () => void;
  onConfirm: (target: MigrationPublishTarget) => void;
}) {
  const { client } = useClient();
  const id = useId();
  const [release, setRelease] = useState(mayRelease && initial.viaRelease === true);
  const [releaseId, setReleaseId] = useState(initial.releaseId ?? '');
  const [title, setTitle] = useState(initial.releaseTitle ?? '');
  const read = useScopedQuery(['releases'], () => client.listReleases(), {
    silent: true,
    enabled: release,
  });
  const releases = read.data?.filter((r) => r.status === 'open');
  const n = plural(entries, 'loaded entry', 'loaded entries');
  const target: MigrationPublishTarget = release
    ? {
        viaRelease: true,
        ...(releaseId ? { releaseId } : title.trim() ? { releaseTitle: title.trim() } : {}),
      }
    : {};
  const message = driven
    ? release
      ? `Give ${run.name}’s background run the go-ahead to add its entries to a release?`
      : `Give ${run.name}’s background run the go-ahead to publish its entries?`
    : release
      ? `Add ${n} of ${run.name} to a release?`
      : `Publish ${n} of ${run.name} now?`;
  const note = release
    ? driven
      ? `${n} so far, and every one it loads. Nothing is published until the release ships, by hand or on its schedule.`
      : 'Nothing is published until the release ships, by hand or on its schedule.'
    : driven
      ? `${n} so far, and every one it loads, go public as you. The first go-ahead stands, and the migration doesn’t undo a publish.`
      : 'They go public at once. The migration doesn’t undo a publish: each entry would have to be unpublished by hand.';
  return (
    <InlineConfirm
      message={message}
      note={note}
      cancelLabel="Not now"
      onCancel={onCancel}
      returnFocus={returnFocus}
      details={
        mayRelease && !fixed ? (
          <div className="space-y-3">
            <Segmented
              aria-label="How to publish"
              value={release ? 'release' : 'now'}
              onValueChange={(v) => setRelease(v === 'release')}
              className="grid w-full max-w-sm grid-cols-2"
            >
              <SegmentedItem value="now">Publish now</SegmentedItem>
              <SegmentedItem value="release">Through a release</SegmentedItem>
            </Segmented>
            {release ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`${id}-release`}>Release</Label>
                  <NativeSelect
                    id={`${id}-release`}
                    value={releaseId}
                    onChange={(e) => setReleaseId(e.target.value)}
                  >
                    <NativeSelectOption value="">
                      {run.releaseId ? 'This run’s release' : 'A new one for this run'}
                    </NativeSelectOption>
                    {(releases ?? [])
                      .filter((r) => r.id !== run.releaseId)
                      .map((r) => (
                        <NativeSelectOption key={r.id} value={r.id}>
                          {r.title}
                        </NativeSelectOption>
                      ))}
                  </NativeSelect>
                  {read.isPending ? (
                    <p className="text-muted-foreground text-xs">Reading the open releases…</p>
                  ) : read.isError ? (
                    <p className="text-muted-foreground text-xs">
                      The open releases couldn’t be read.{' '}
                      <Button
                        type="button"
                        variant="link"
                        size="xs"
                        className="px-0"
                        onClick={() => void read.refetch()}
                      >
                        Try again
                      </Button>
                    </p>
                  ) : null}
                </div>
                {!releaseId && !run.releaseId ? (
                  <div className="space-y-1.5">
                    <Label htmlFor={`${id}-title`}>Its title (optional)</Label>
                    <Input
                      id={`${id}-title`}
                      maxLength={200}
                      placeholder={`Migration: ${run.name}`}
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : undefined
      }
    >
      <Button type="button" size="sm" onClick={() => onConfirm(target)}>
        {driven
          ? 'Give the go-ahead'
          : release
            ? 'Add to the release'
            : `Publish ${plural(entries, 'entry', 'entries')}`}
      </Button>
    </InlineConfirm>
  );
}
