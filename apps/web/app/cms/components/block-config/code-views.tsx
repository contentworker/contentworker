/**
 * The Rules card's Code and Narrowed from code views (`BlockRules`): the block config as the API
 * takes it, and each place's code rule against the one in force. The text comes from
 * `lib/block-config-code`; the editor is CodeMirror, fetched the first time either view opens (and
 * ahead of that when a pointer or the keyboard reaches its segment), so /blocks ships none of it.
 */
import type { StaleNarrowing } from '@contentworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import { CodeBlock } from '@contentworker/ui/code-block';
import { Label } from '@contentworker/ui/label';
import { Skeleton } from '@contentworker/ui/skeleton';
import { Switch } from '@contentworker/ui/switch';
import { useEffect, useId, useState } from 'react';
import { CopyButton } from '~/cms/components/copy-button';
import { LoadingStatus } from '~/cms/components/loading';
import { ToneBadge } from '~/cms/components/status';
import { changedText, type PlaceCode, placesToShow } from '~/cms/lib/block-config-code';
import type { Place } from '~/cms/lib/block-config-draft';
import { TABLET, useMedia } from '~/cms/lib/device';
import { plural } from '~/cms/lib/format';

type Editor = typeof import('./codemirror');

let loading: Promise<Editor> | undefined;
/** Fetches the editor once; a failed fetch is forgotten, so Try again fetches it anew. */
export function loadEditor(): Promise<Editor> {
  loading ??= import('./codemirror').catch((err: unknown) => {
    loading = undefined;
    throw err;
  });
  return loading;
}

function useEditor() {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Again on each `attempt`: Try again bumps it.
  useEffect(() => {
    let live = true;
    setFailed(false);
    loadEditor().then(
      (m) => live && setEditor(m),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [attempt]);
  return { editor, failed, retry: () => setAttempt((n) => n + 1) };
}

/** The editor's frame: a code block, ringed while the editor inside it has focus. */
const FRAME =
  'has-[.cm-focused]:border-ring has-[.cm-focused]:ring-3 has-[.cm-focused]:ring-ring/30';

/** A failed fetch of the editor, said once for the view, with Try again. */
function EditorFailed({ retry }: { retry: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>The code view couldn’t be loaded</AlertTitle>
      <AlertDescription>
        <p>Check the connection, then try again.</p>
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={retry}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/** Waiting on the editor: a block the height of the lines that replace it. */
function EditorSkeleton({ lines }: { lines: number }) {
  return (
    <Skeleton
      aria-hidden="true"
      className="w-full rounded-xl"
      style={{ height: `calc(${Math.min(lines, 24)} * 1.625 * 0.75rem + 1.5rem)` }}
    />
  );
}

/** Says the editor is on its way, once for the view (The Drawn Page Rule). */
function EditorLoading({ editor, failed }: { editor: Editor | null; failed: boolean }) {
  return !editor && !failed ? <LoadingStatus>Loading the code view…</LoadingStatus> : null;
}

/** "Unsaved" where the view shows the draft, not the rules in force. */
function Unsaved({ on }: { on: boolean }) {
  return on ? <ToneBadge tone="wait" label="Unsaved" /> : null;
}

/**
 * The config as JSON, read-only: the rules in force, or with unsaved edits the draft, which is
 * exactly what Save rules sends (with the version it was edited from).
 */
export function BlockConfigCode(props: {
  text: string;
  unsaved: boolean;
  invalid: boolean;
  /** The version a save is held to. */
  version: number;
  ignored: number;
}) {
  const { editor, failed, retry } = useEditor();
  const about = useId();
  const lines = props.text.split('\n').length;
  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Unsaved on={props.unsaved} />
        <p id={about} className="max-w-measure flex-1 text-muted-foreground text-xs">
          {props.unsaved ? (
            <>
              What Save rules would send: the body of <code className="font-mono">PUT</code> …
              <code className="font-mono">/block-config</code>, with{' '}
              <code className="font-mono">expectedVersion</code>{' '}
              <span className="font-mono">{props.version}</span>.
            </>
          ) : (
            <>
              The rules in force, as <code className="font-mono">PUT</code> …
              <code className="font-mono">/block-config</code> takes them.
            </>
          )}
          {props.ignored > 0
            ? ` ${props.ignored === 1 ? 'The ignored part isn’t' : 'The ignored parts aren’t'} in it: saving removes ${props.ignored === 1 ? 'it' : 'them'}.`
            : ''}
        </p>
        <CopyButton text={props.text} label="Copy JSON" />
      </div>
      {props.invalid ? (
        <p className="max-w-measure text-destructive text-xs">
          Fix the rules marked in Rules before this can be sent: a bound that isn’t a whole number
          is left out here.
        </p>
      ) : null}
      <EditorLoading editor={editor} failed={failed} />
      {failed ? (
        <EditorFailed retry={retry} />
      ) : editor ? (
        <CodeBlock className={FRAME}>
          <editor.JsonCode value={props.text} label="Block config as JSON" describedBy={about} />
        </CodeBlock>
      ) : (
        <EditorSkeleton lines={lines} />
      )}
    </div>
  );
}

/** How tall a place's diff is: the longer side, side by side; both sides' changed lines, unified. */
function diffLines(p: PlaceCode, split: boolean): number {
  const a = p.code.split('\n');
  const b = p.inForce.split('\n');
  if (split) return Math.max(a.length, b.length);
  return b.length + a.filter((line) => !b.includes(line)).length;
}

/**
 * Each place's code rule against the one in force: only where they differ (or where a part of the
 * config is ignored), unless Show all is on. Side by side from md, one column on a phone.
 */
export function BlockConfigDiff(props: {
  list: readonly PlaceCode[];
  /** Ignored parts no place holds (a target or a block the catalog no longer has). */
  elsewhere: readonly StaleNarrowing[];
  placeName: (place: Place) => string;
  unsaved: boolean;
}) {
  const { editor, failed, retry } = useEditor();
  const [all, setAll] = useState(false);
  const split = useMedia(TABLET);
  const id = useId();
  const shown = placesToShow(props.list, all);
  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Unsaved on={props.unsaved} />
        <p className="max-w-measure flex-1 text-muted-foreground text-xs">
          {props.unsaved
            ? 'The rules as Save rules would set them, against the code’s.'
            : 'The rules in force against the code’s: what the admin narrowed.'}{' '}
          {split
            ? 'The code’s rule is on the left, marked −; the rule in force on the right, marked +.'
            : 'The code’s lines are marked −, the rule in force’s +.'}
        </p>
        <div className="flex items-center gap-2">
          <Switch id={`${id}-all`} checked={all} onCheckedChange={setAll} />
          <Label htmlFor={`${id}-all`} className="font-normal">
            Show all
          </Label>
        </div>
      </div>
      <EditorLoading editor={editor} failed={failed} />
      {failed && shown.length > 0 ? <EditorFailed retry={retry} /> : null}
      {shown.length === 0 ? (
        <p className="max-w-measure text-muted-foreground text-sm">
          Nothing is narrowed: everywhere, editors may place what the code allows.
        </p>
      ) : (
        <ul
          aria-label={all ? 'Every place, code against in force' : 'Places narrowed from code'}
          className="space-y-5"
        >
          {shown.map((p) => {
            const name = props.placeName(p.place);
            const headingId = `${id}-${props.list.indexOf(p)}`;
            return (
              <li key={p.place.key} className="space-y-2">
                <div className="space-y-0.5">
                  <h3 id={headingId} className="font-medium text-sm">
                    {name}
                  </h3>
                  <p className="text-muted-foreground text-xs">
                    <code className="font-mono">{p.place.key}</code>
                    {' · '}
                    {p.narrowed ? `Narrowed: ${changedText(p.changed)}` : 'As the code allows'}
                  </p>
                  {p.ignored.length > 0 ? (
                    <ul className="text-muted-foreground text-xs">
                      {p.ignored.map((s) => (
                        <li key={`${s.at}:${s.message}`}>
                          Ignored: {s.message} (<code className="font-mono">{s.at}</code>)
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                {split ? (
                  <div aria-hidden="true" className="grid grid-cols-2 gap-px">
                    <span className="caption text-muted-foreground">Code</span>
                    <span className="caption ps-2 text-muted-foreground">In force</span>
                  </div>
                ) : null}
                {failed ? null : editor ? (
                  <CodeBlock className={FRAME}>
                    <editor.JsonDiff
                      code={p.code}
                      inForce={p.inForce}
                      layout={split ? 'split' : 'unified'}
                      codeLabel={`The code’s rule for ${name}, as JSON`}
                      inForceLabel={`The rule in force for ${name}, as JSON`}
                      unifiedLabel={`The rule in force for ${name}, with the code’s lines it replaces, as JSON`}
                    />
                  </CodeBlock>
                ) : (
                  <EditorSkeleton lines={diffLines(p, split)} />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {props.elsewhere.length > 0 ? (
        <div className="space-y-1">
          <h3 className="font-medium text-sm">
            Ignored: {plural(props.elsewhere.length, 'part')} the catalog no longer has a place for
          </h3>
          <ul className="text-muted-foreground text-xs">
            {props.elsewhere.map((s) => (
              <li key={`${s.at}:${s.message}`}>
                <code className="font-mono">{s.at}</code>: {s.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
