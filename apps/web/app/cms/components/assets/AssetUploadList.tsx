import { Button } from '@contentworker/ui/button';
import { Progress } from '@contentworker/ui/progress';
import { StatusBadge } from '~/cms/components/status';

export type UploadState = 'queued' | 'uploading' | 'done' | 'failed';

export interface UploadItem {
  readonly id: string;
  readonly name: string;
  readonly state: UploadState;
  readonly error?: string;
}

const STATE: Record<UploadState, { status: string; label: string }> = {
  queued: { status: 'pending', label: 'Waiting' },
  uploading: { status: 'running', label: 'Uploading' },
  done: { status: 'completed', label: 'Uploaded' },
  failed: { status: 'failed', label: 'Failed' },
};

/** "Uploading 1 of 3" while it runs; then "Uploaded 2 files; 1 failed". */
export function uploadSummary(items: readonly UploadItem[]): string {
  const done = items.filter((i) => i.state === 'done').length;
  const failed = items.filter((i) => i.state === 'failed').length;
  if (done + failed < items.length) return `Uploading ${done + failed} of ${items.length}`;
  const uploaded = `Uploaded ${done} ${done === 1 ? 'file' : 'files'}`;
  return failed > 0 ? `${uploaded}; ${failed} failed` : uploaded;
}

/**
 * The files of a drop or a pick, each with where its upload stands, and the batch's progress. The
 * summary is a polite live region, so a screen reader hears the batch move and finish.
 */
export function AssetUploadList(props: { items: readonly UploadItem[]; onDismiss: () => void }) {
  const { items } = props;
  if (items.length === 0) return null;
  const finished = items.filter((i) => i.state === 'done' || i.state === 'failed').length;
  const running = finished < items.length;
  return (
    <section aria-label="Uploads" className="card space-y-3 p-4">
      <div className="flex items-center gap-3">
        <p className="section-title" role="status">
          {uploadSummary(items)}
        </p>
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
        value={Math.round((finished / items.length) * 100)}
        aria-label="Upload progress"
        className="h-1.5"
      />
      <ul className="divide-y text-sm">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-3 py-1.5">
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
            {item.error && (
              <span className="min-w-0 truncate text-muted-foreground text-xs">{item.error}</span>
            )}
            <StatusBadge status={STATE[item.state].status} label={STATE[item.state].label} />
          </li>
        ))}
      </ul>
    </section>
  );
}
