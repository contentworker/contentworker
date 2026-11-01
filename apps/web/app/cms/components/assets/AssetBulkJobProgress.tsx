import { Button } from '@contentworker/ui/button';
import { Progress } from '@contentworker/ui/progress';
import { StatusBadge, ToneBadge } from '~/cms/components/status';
import { type AssetBulkAction, BULK_VERBS, bulkSummary, jobOutcome } from '~/cms/lib/assets';
import { plural } from '~/cms/lib/format';
import type { BulkJobSummary } from '~/cms/lib/management';

/**
 * A bulk action running as a job, shown the way an import job is: batches, not assets, because
 * batches are what complete (a count that moved a chunk at a time would look stuck between
 * jumps), in the upload queue's Progress bar, with the reassurance that it keeps going if the tab
 * closes. A job that ended with failures is stamped as waiting on a person, never as done. The summary line is a polite live region, so its end is heard. What
 * failed is named beside it, by the library's failures Alert, once the report is read.
 */
export function AssetBulkJobProgress(props: {
  action: AssetBulkAction;
  job: BulkJobSummary;
  onDismiss: () => void;
}) {
  const { job } = props;
  const verbs = BULK_VERBS[props.action];
  const running = job.status === 'running';
  const summary = running
    ? `${verbs.doing} ${plural(job.totalItems, 'asset')}…`
    : job.status === 'cancelled'
      ? `Stopped: ${bulkSummary(verbs.done, jobOutcome(job))}`
      : bulkSummary(verbs.done, jobOutcome(job));
  return (
    <section aria-label="Bulk job" className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="section-title" role="status">
          {summary}
        </p>
        {!running && job.status !== 'cancelled' && job.failed > 0 ? (
          <ToneBadge tone="wait" label="Finished with failures" />
        ) : (
          <StatusBadge status={job.status} />
        )}
        {!running && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="ml-auto"
            onClick={props.onDismiss}
          >
            Dismiss
          </Button>
        )}
      </div>
      <Progress
        value={Math.round((job.completedChunks / Math.max(1, job.totalChunks)) * 100)}
        aria-label="Bulk job progress"
        className="h-1.5"
      />
      <p className="text-muted-foreground text-xs">
        {running
          ? `${job.completedChunks} of ${plural(job.totalChunks, 'batch', 'batches')} done; this keeps running if you close the tab.`
          : `${plural(job.totalChunks, 'batch', 'batches')} done.`}
      </p>
    </section>
  );
}
