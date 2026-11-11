import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import { ComposeLoader, composeIcons } from '@contentworker/ui/compose-loader';
import { RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ToneBadge } from '~/cms/components/status';
import { TURN_ON_HINT } from '../lib/ai-settings';
import { useClient } from '../lib/client-context';
import { ApiError, apiErrorMessage, type ChangeSummary as Summary } from '../lib/management';

type State =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly fresh: boolean; readonly previous?: Summary }
  | { readonly status: 'ready'; readonly summary: Summary }
  | { readonly status: 'failed'; readonly message: string; readonly off: boolean };

/**
 * "Summarize changes" over a version compare: a few sentences on what changed between `from` and
 * `to`, asked for on demand (it may call a model), shown above the diff it was written from. A
 * model's summary is stamped "Written by AI" and can be written again; one built from the diff by
 * rule (no model configured) says so instead. The diff below stays the record: the summary is a
 * reading aid, and its note says to check it there. The parent hides this when the space turned
 * field-assist off; a refusal that still comes back (the setting changed meanwhile) says why.
 */
export function ChangeSummary(props: { entryId: string; from: number; to: number }) {
  const { client } = useClient();
  const [state, setState] = useState<State>({ status: 'idle' });
  const pending = useRef<AbortController | null>(null);
  // A summary in flight is dropped when the compare closes or moves to other versions.
  useEffect(() => () => pending.current?.abort(), []);

  const summarize = async (fresh: boolean) => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setState((s) => ({
      status: 'loading',
      fresh,
      ...(s.status === 'ready' ? { previous: s.summary } : {}),
    }));
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
      setState({ status: 'failed', message: apiErrorMessage(err), off });
    }
  };

  const busy = state.status === 'loading';
  const shown = state.status === 'ready' ? state.summary : busy ? state.previous : undefined;

  return (
    <section aria-label="Summary of changes" className="space-y-2">
      {shown ? (
        <SummaryText summary={shown} />
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="-ms-2"
          disabled={busy}
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
      )}
      {shown?.source === 'model' ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="-ms-2"
          disabled={busy}
          onClick={() => void summarize(true)}
        >
          {busy ? (
            <ComposeLoader icon={composeIcons.write} className="text-ai" />
          ) : (
            <RotateCcw className="size-3.5" />
          )}
          {busy ? 'Writing it again…' : 'Write it again'}
        </Button>
      ) : null}
      <p role="status" className="sr-only">
        {busy ? 'Summarizing the changes…' : state.status === 'ready' ? 'Summary ready.' : ''}
      </p>
      {state.status === 'failed' ? (
        <Alert variant={state.off ? 'default' : 'destructive'}>
          <AlertTitle>
            {state.off ? 'Writing help is turned off' : 'The summary couldn’t be written'}
          </AlertTitle>
          <AlertDescription>
            <p>{state.off ? TURN_ON_HINT : state.message}</p>
            {state.off ? null : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => void summarize(false)}
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

function SummaryText({ summary }: { summary: Summary }) {
  const byModel = summary.source === 'model';
  return (
    <div className="space-y-2 border-l pl-3">
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
