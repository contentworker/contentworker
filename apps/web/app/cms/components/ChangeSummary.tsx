import { SCOPES } from '@contentworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import { ComposeLoader, composeIcons } from '@contentworker/ui/compose-loader';
import { useEffect, useRef, useState } from 'react';
import { ToneBadge } from '~/cms/components/status';
import { TURN_ON_HINT } from '../lib/ai-settings';
import { useClient } from '../lib/client-context';
import { ApiError, apiErrorMessage, type ChangeSummary as Summary } from '../lib/management';
import { useScopedQuery } from '../lib/queries';

type State =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly fresh: boolean; readonly previous?: Summary }
  | { readonly status: 'ready'; readonly summary: Summary }
  | {
      readonly status: 'failed';
      readonly message: string;
      /** Refused because Writing help is off: nothing to try again. */
      readonly off: boolean;
      /** What failed asked past the cache, so trying again does too. */
      readonly fresh: boolean;
      /** The summary on screen when Write it again failed: it stays in sight. */
      readonly previous?: Summary;
    };

/**
 * "Summarize changes" over a version compare: a few sentences on what changed between `from` and
 * `to`, asked for on demand (it may call a model), shown above the diff it was written from. A
 * model's summary is stamped "Written by AI" and, for someone who can edit, can be written again;
 * one built from the diff by rule (no model configured) says so instead. The diff below stays the
 * record: the summary is a reading aid, and its note says to check it there. The parent hides this
 * when the space turned field-assist off; a refusal that still comes back (the setting changed
 * meanwhile) says why and offers nothing more.
 *
 * Focus never drops to the page: the button that asked stays mounted (inert while it waits), a
 * first summary takes focus where the button was, and a failure focuses its Try again.
 */
export function ChangeSummary(props: { entryId: string; from: number; to: number }) {
  const { client } = useClient();
  const [state, setState] = useState<State>({ status: 'idle' });
  const pending = useRef<AbortController | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  /** Where focus goes when the answer lands, set by the press that asked. */
  const focusNext = useRef<'summary' | 'alert' | null>(null);
  // A summary in flight is dropped when the compare closes or moves to other versions.
  useEffect(() => () => pending.current?.abort(), []);
  // Writing it again asks past the cache, which the API allows to those who can edit content;
  // anyone else would get the same summary back, so it isn't offered.
  const access = useScopedQuery(['space-access'], () => client.getSpaceAccess(), { silent: true });
  const canRewrite = access.data?.scopes.includes(SCOPES.contentWrite) ?? false;

  useEffect(() => {
    const next = focusNext.current;
    if (state.status === 'ready' && next === 'summary') summaryRef.current?.focus();
    if (state.status === 'failed' && next) (retryRef.current ?? alertRef.current)?.focus();
    if (state.status === 'ready' || state.status === 'failed') focusNext.current = null;
  }, [state]);

  const busy = state.status === 'loading';
  const shown =
    state.status === 'ready'
      ? state.summary
      : state.status === 'loading' || state.status === 'failed'
        ? state.previous
        : undefined;

  const summarize = async (fresh: boolean) => {
    if (busy) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    // A first summary replaces the button that asked, so focus goes to it; Write it again stays put.
    focusNext.current = shown ? null : 'summary';
    setState({ status: 'loading', fresh, ...(shown ? { previous: shown } : {}) });
    try {
      const summary = await client.summarizeChange(
        props.entryId,
        props.from,
        props.to,
        { fresh },
        controller.signal,
      );
      if (!controller.signal.aborted) setState({ status: 'ready', summary });
    } catch (err) {
      if (controller.signal.aborted) return;
      const off = err instanceof ApiError && err.code === 'ai_capability_disabled';
      focusNext.current = 'alert';
      setState({
        status: 'failed',
        message: apiErrorMessage(err),
        off,
        fresh,
        ...(shown ? { previous: shown } : {}),
      });
    }
  };

  const failed = state.status === 'failed' ? state : null;
  // Named, and so a landmark, only once it holds something to read.
  const labelled = Boolean(shown || failed);

  return (
    <section aria-label={labelled ? 'Summary of changes' : undefined} className="space-y-2">
      {shown ? <SummaryText ref={summaryRef} summary={shown} /> : null}
      {!shown && !failed ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="-ms-2"
          aria-disabled={busy || undefined}
          onClick={() => void summarize(false)}
        >
          {/* The mark at rest; the task's icon composes while the model works. */}
          <ComposeLoader
            icon={busy ? composeIcons.write : composeIcons.aiMark}
            playing={busy}
            className="text-ai"
          />
          {busy ? 'Summarizing…' : 'Summarize changes'}
        </Button>
      ) : null}
      {shown?.source === 'model' && canRewrite && !failed ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="-ms-2"
          aria-disabled={busy || undefined}
          onClick={() => void summarize(true)}
        >
          <ComposeLoader
            icon={busy ? composeIcons.write : composeIcons.aiMark}
            playing={busy}
            className="text-ai"
          />
          {busy ? 'Writing it again…' : 'Write it again'}
        </Button>
      ) : null}
      <p role="status" className="sr-only">
        {busy ? 'Summarizing the changes…' : state.status === 'ready' ? 'Summary ready.' : ''}
      </p>
      {failed ? (
        <Alert
          ref={alertRef}
          tabIndex={-1}
          variant={failed.off ? 'default' : 'destructive'}
          className="outline-none"
        >
          <AlertTitle>
            {failed.off ? 'Writing help is turned off' : 'The summary couldn’t be written'}
          </AlertTitle>
          <AlertDescription>
            <p>{failed.off ? TURN_ON_HINT : failed.message}</p>
            {failed.off ? null : (
              <Button
                ref={retryRef}
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => void summarize(failed.fresh)}
              >
                Try again
              </Button>
            )}
          </AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}

function SummaryText({ summary, ref }: { summary: Summary; ref: React.Ref<HTMLDivElement> }) {
  const byModel = summary.source === 'model';
  return (
    // Focusable from code only: a first summary takes the focus of the button it replaces.
    <div ref={ref} tabIndex={-1} className="space-y-2 border-s ps-3 outline-none">
      <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
        {byModel ? (
          <ToneBadge tone="ai" label="Written by AI" />
        ) : (
          <ToneBadge tone="idle" label="Listed from the changes" />
        )}
        {summary.truncated ? (
          <span>Covers some of the changes; the list below has them all</span>
        ) : null}
      </div>
      {/* Plain text from the API, rendered as text: never markup. */}
      <p className="max-w-prose text-sm">{summary.summary}</p>
      {summary.highlights.length > 0 ? (
        <ul aria-label="Notable changes" className="max-w-prose list-disc space-y-0.5 ps-5 text-sm">
          {summary.highlights.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
      ) : null}
      {byModel ? (
        <p className="text-muted-foreground text-xs">
          Written by a model from the changes below. Check it against them before you rely on it.
        </p>
      ) : null}
    </div>
  );
}
