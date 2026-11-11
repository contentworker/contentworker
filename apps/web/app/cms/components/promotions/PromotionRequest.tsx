import type { Promotion } from '@contentworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import { Checkbox } from '@contentworker/ui/checkbox';
import { Label } from '@contentworker/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentworker/ui/select';
import { ArrowRight } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { ConfirmDialog } from '~/cms/components/ConfirmDialog';
import { Section } from '~/cms/components/page';
import { ToneBadge } from '~/cms/components/status';
import { humanize, plural, type Tone } from '~/cms/lib/format';
import { useClient, useLocalRun } from '../../lib/client-context';
import {
  type ChangeKind,
  type Environment,
  type EnvironmentComparison,
  failedPromotionOf,
} from '../../lib/management';
import { useInvalidate } from '../../lib/queries';
import {
  copiesLine,
  type Refusal,
  RefusalAlert,
  RiskReasons,
  refusalOf,
  shortId,
  usePromotionViewer,
} from './parts';

const KIND_TONE: Record<ChangeKind, Tone> = {
  added: 'ok',
  changed: 'wait',
  removed: 'bad',
  unchanged: 'idle',
};

/** A change the source can carry: what it adds or changes (target-only items are never removed). */
const carried = (kind: ChangeKind) => kind === 'added' || kind === 'changed';

/** The two environments a promotion usually runs between: something other than main, into main. */
function defaultPair(environments: readonly Environment[]): [string, string] {
  const main = environments.find((e) => e.id === 'main');
  const other = environments.find((e) => e.id !== 'main');
  if (main && other) return [other.id, main.id];
  return [environments[0]?.id ?? '', environments[1]?.id ?? ''];
}

/**
 * Request a promotion: pick the source and target, compare them, choose what to carry (every
 * added or changed content type and entry is preselected, as Compare & merge does) and whether the
 * block catalog and config go too, then send it. The API pins the selection and runs its risk
 * check; what it answered (applied at once, or waiting for someone's approval and why, or
 * refused and why) shows under the button, with the way into the promotion's record.
 */
export function PromotionRequest(props: {
  environments: readonly Environment[];
  onOpen: (id: string) => void;
}) {
  const { environments, onOpen } = props;
  const { client } = useClient();
  const { busy, run } = useLocalRun();
  const invalidate = useInvalidate();
  const { access, canRequest } = usePromotionViewer();
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [diff, setDiff] = useState<EnvironmentComparison | null>(null);
  const [types, setTypes] = useState<Set<string>>(new Set());
  const [entries, setEntries] = useState<Set<string>>(new Set());
  const [blocks, setBlocks] = useState(true);
  const [outcome, setOutcome] = useState<
    | { readonly kind: 'answered'; readonly promotion: Promotion }
    | { readonly kind: 'refused'; readonly target: string; readonly refusal: Refusal }
    | null
  >(null);
  const blocksId = useId();
  const noteId = useId();

  useEffect(() => {
    if (source || target || environments.length < 2) return;
    const [s, t] = defaultPair(environments);
    setSource(s);
    setTarget(t);
  }, [environments, source, target]);

  // A new pair is a new question: the last diff and answer were about the old one.
  const pick = (side: 'source' | 'target', id: string) => {
    (side === 'source' ? setSource : setTarget)(id);
    setDiff(null);
    setOutcome(null);
  };

  const compare = () =>
    run(async () => {
      setOutcome(null);
      const result = await client.compareEnvironments(source, target);
      setDiff(result);
      setTypes(new Set(result.contentTypes.filter((c) => carried(c.kind)).map((c) => c.apiId)));
      setEntries(new Set(result.entries.filter((e) => carried(e.kind)).map((e) => e.entryId)));
    });

  /**
   * Sends the request (from the confirm, which holds until it answers). A refusal is said under
   * the button, grouped; one that stopped partway comes back as its failed record; anything else
   * (a 5xx, no answer) stays in the confirm, which says it may have gone through. Answered, the picker closes: the answer is the news, and pressing Request
   * again would file the same promotion twice.
   */
  const request = async () => {
    setOutcome(null);
    try {
      const promotion = await client.requestPromotion({
        source,
        target,
        contentTypes: [...types],
        entries: [...entries],
        blocks,
      });
      setOutcome({ kind: 'answered', promotion });
      setDiff(null);
      setTypes(new Set());
      setEntries(new Set());
      setBlocks(true);
    } catch (err) {
      // Applied at once and stopped after a write: the API's 409 carries the failed record, which
      // is the answer (something was written), not a refusal.
      const failed = failedPromotionOf(err);
      if (failed) {
        setOutcome({ kind: 'answered', promotion: failed });
        setDiff(null);
        setTypes(new Set());
        setEntries(new Set());
        setBlocks(true);
        return;
      }
      const refusal = refusalOf(err);
      if (!refusal || refusal.kind === 'unconfirmed') throw err;
      setOutcome({ kind: 'refused', target, refusal });
    } finally {
      await invalidate(['promotions']);
    }
  };

  // Only what a promotion can carry is listed; what only the target holds is counted, since a
  // promotion never removes it (a fresh source can leave hundreds of those to scroll past).
  const shownTypes = diff?.contentTypes.filter((c) => carried(c.kind)) ?? [];
  const shownEntries = diff?.entries.filter((e) => carried(e.kind)) ?? [];
  const typesOnlyThere = diff?.contentTypes.filter((c) => c.kind === 'removed').length ?? 0;
  const entriesOnlyThere = diff?.entries.filter((e) => e.kind === 'removed').length ?? 0;
  const onlyThere = typesOnlyThere + entriesOnlyThere;
  const selected = types.size + entries.size;
  const same = !!source && source === target;

  return (
    <Section
      title="Promote"
      description="Copy content from one environment into another, live: what is published in the source is published in the target, and drafts go as drafts. Some promotions wait for someone else to approve them (one into main always does); the answer says why."
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <Label>Source</Label>
            <Select value={source} onValueChange={(v) => pick('source', v)}>
              <SelectTrigger aria-label="Source environment to promote from" className="w-[160px]">
                <SelectValue placeholder="From" />
              </SelectTrigger>
              <SelectContent>
                {environments.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <ArrowRight aria-hidden="true" className="mb-2 size-4 text-muted-foreground" />
          <div className="space-y-1.5">
            <Label>Target</Label>
            <Select value={target} onValueChange={(v) => pick('target', v)}>
              <SelectTrigger aria-label="Target environment to promote into" className="w-[160px]">
                <SelectValue placeholder="Into" />
              </SelectTrigger>
              <SelectContent>
                {environments.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={compare}
            disabled={busy || !source || !target || same}
            aria-describedby={same ? noteId : undefined}
          >
            Compare
          </Button>
        </div>
        {same ? (
          <p id={noteId} className="text-muted-foreground text-sm">
            Pick two different environments.
          </p>
        ) : null}

        {diff ? (
          <div className="space-y-4">
            {shownTypes.length === 0 && shownEntries.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                Nothing in {source} differs from {target}. The block catalog and config can still go
                on their own.
              </p>
            ) : null}
            {onlyThere > 0 ? (
              <p className="max-w-measure text-muted-foreground text-sm">
                {[
                  ...(typesOnlyThere ? [plural(typesOnlyThere, 'content type')] : []),
                  ...(entriesOnlyThere ? [plural(entriesOnlyThere, 'entry', 'entries')] : []),
                ].join(' and ')}{' '}
                {onlyThere === 1 ? 'is' : 'are'} only in {target}: a promotion leaves{' '}
                {onlyThere === 1 ? 'it' : 'them'} as {onlyThere === 1 ? 'it is' : 'they are'}.
              </p>
            ) : null}
            {shownTypes.length > 0 ? (
              <Choices
                legend="Content types"
                items={shownTypes.map((c) => ({ id: c.apiId, label: c.apiId, kind: c.kind }))}
                picked={types}
                onChange={setTypes}
              />
            ) : null}
            {shownEntries.length > 0 ? (
              <Choices
                legend="Entries"
                items={shownEntries.map((e) => ({
                  id: e.entryId,
                  label: `${e.contentTypeApiId} · ${shortId(e.entryId)}`,
                  kind: e.kind,
                }))}
                picked={entries}
                onChange={setEntries}
              />
            ) : null}
            <div className="flex items-start gap-2">
              <Checkbox
                id={blocksId}
                checked={blocks}
                onCheckedChange={(c) => setBlocks(c === true)}
                aria-describedby={`${blocksId}-hint`}
                className="mt-0.5"
              />
              <div className="space-y-0.5">
                <Label htmlFor={blocksId} className="font-normal">
                  Include the block catalog and block config
                </Label>
                <p id={`${blocksId}-hint`} className="max-w-measure text-muted-foreground text-xs">
                  Only when they differ from the target’s.
                </p>
              </div>
            </div>

            {outcome?.kind === 'refused' ? (
              <RefusalAlert
                // A refusal writes nothing: an apply that stopped partway answers with its
                // record, `failed`, which shows as the answer below instead.
                title={`Nothing was promoted into ${outcome.target}`}
                refusal={outcome.refusal}
                // Some checks run as it applies: one of those leaves the record, `failed`.
                note="Some checks run as it applies, so Promotions below may list it as failed. Nothing was copied either way."
              />
            ) : null}
            <ConfirmDialog
              tone="default"
              message={`Request a promotion into ${target}?`}
              note={`What is live in ${source} goes live in ${target} at once, unless it needs someone’s approval first. Readers and webhooks get it then, and there is no undo.`}
              confirmLabel="Request promotion"
              onConfirm={request}
            >
              {(ask) => (
                <Button
                  type="button"
                  onClick={ask}
                  disabled={!canRequest || (selected === 0 && !blocks)}
                  aria-describedby={access && !canRequest ? `${noteId}-role` : undefined}
                >
                  Request promotion into {target}…
                </Button>
              )}
            </ConfirmDialog>
            {access && !canRequest ? (
              <p id={`${noteId}-role`} className="max-w-measure text-muted-foreground text-sm">
                Requesting a promotion takes a role that can manage and publish content, with no
                content-type or field limits.
              </p>
            ) : null}
            <p className="text-muted-foreground text-xs" aria-live="polite">
              {selected === 0 && !blocks
                ? 'Choose something to promote.'
                : `${[
                    ...(types.size ? [plural(types.size, 'content type')] : []),
                    ...(entries.size ? [plural(entries.size, 'entry', 'entries')] : []),
                    ...(blocks ? ['blocks, if they differ'] : []),
                  ].join(', ')} selected.`}
            </p>
          </div>
        ) : null}

        {/* Always mounted, so the answer is heard when it lands inside it. */}
        <div aria-live="polite">
          {outcome?.kind === 'answered' ? (
            <Answer promotion={outcome.promotion} onOpen={() => onOpen(outcome.promotion.id)} />
          ) : null}
        </div>
      </div>
    </Section>
  );
}

/**
 * One kind of change to choose from: a group named by its legend, with its count, Select all and
 * Select none, and a list that scrolls in place when it runs long (a promotion carries up to 200
 * entries), focusable so the keyboard can scroll it too.
 */
function Choices(props: {
  legend: string;
  items: readonly { id: string; label: string; kind: ChangeKind }[];
  picked: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}) {
  const { items, picked, onChange } = props;
  const pickable = items;
  const count = pickable.filter((i) => picked.has(i.id)).length;
  const toggle = (id: string) => {
    const next = new Set(picked);
    next.has(id) ? next.delete(id) : next.add(id);
    onChange(next);
  };
  const long = items.length > 8;
  const legendId = useId();
  return (
    <fieldset aria-labelledby={legendId} className="min-w-0 space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id={legendId} className="font-medium text-sm">
          {props.legend}{' '}
          <span className="font-normal text-muted-foreground">
            {count} of {pickable.length} selected
          </span>
        </p>
        {pickable.length > 1 ? (
          <div className="flex gap-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={`Select all ${props.legend.toLowerCase()}`}
              disabled={count === pickable.length}
              onClick={() => onChange(new Set(pickable.map((i) => i.id)))}
            >
              Select all
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={`Select none of the ${props.legend.toLowerCase()}`}
              disabled={count === 0}
              onClick={() => onChange(new Set())}
            >
              Select none
            </Button>
          </div>
        ) : null}
      </div>
      {/* Focusable when it scrolls, so the keyboard can scroll it too. */}
      <ul
        aria-label={props.legend}
        tabIndex={long ? 0 : undefined}
        className={
          long
            ? 'max-h-72 overflow-y-auto rounded-xl border p-1 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'
            : undefined
        }
      >
        {items.map((i) => (
          <li
            key={i.id}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50"
          >
            <Checkbox
              checked={picked.has(i.id)}
              onCheckedChange={() => toggle(i.id)}
              aria-label={`Promote ${i.label}`}
            />
            <span className="flex-1 truncate font-mono text-xs">{i.label}</span>
            <ToneBadge tone={KIND_TONE[i.kind]} label={humanize(i.kind)} />
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

/**
 * What the API made of a request: applied at once (or failed applying), or waiting for someone
 * else's approval, with the reasons and the risk check. Heard through the live region it lands
 * in; a failure keeps the Alert's own `alert` role.
 */
function Answer(props: { promotion: Promotion; onOpen: () => void }) {
  const { promotion: p } = props;
  const view = (
    <Button type="button" variant="outline" size="sm" onClick={props.onOpen}>
      View promotion
    </Button>
  );
  if (p.status === 'completed') {
    const r = p.result;
    return (
      <Alert variant="success" role="note">
        <AlertTitle>Promoted into {p.target}</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>
            {copiesLine(p)} copied
            {r?.published.length ? `, ${plural(r.published.length, 'entry', 'entries')} live` : ''}.
          </p>
          {r?.gated.length ? (
            <p>
              {plural(r.gated.length, 'entry', 'entries')} went as drafts: a workflow publishes them
              in {p.target}.
            </p>
          ) : null}
          {r?.mismatched.length ? (
            <p>
              {plural(r.mismatched.length, 'entry doesn’t', 'entries don’t')} match the pinned
              version in {p.target}. Open the promotion to see which.
            </p>
          ) : null}
          {view}
        </AlertDescription>
      </Alert>
    );
  }
  if (p.status === 'failed') {
    return (
      <Alert variant="destructive">
        <AlertTitle>The promotion failed</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>{p.error ?? 'It stopped without saying why.'}</p>
          {view}
        </AlertDescription>
      </Alert>
    );
  }
  if (p.status === 'awaiting_approval') {
    return (
      <Alert variant="warning" role="note">
        <AlertTitle>Waiting for approval</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>
            Nothing is copied into {p.target} until someone other than you approves it. They decide
            in its record, here under Promotions.
          </p>
          <RiskReasons promotion={p} />
          {view}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert role="note">
      <AlertTitle>{humanize(p.status)}</AlertTitle>
      <AlertDescription>{view}</AlertDescription>
    </Alert>
  );
}
