import {
  PROMOTION_RISK_LEVELS,
  type Promotion,
  type PromotionAssessment,
} from '@contentworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import { useId, useState } from 'react';
import { ToneBadge } from '~/cms/components/status';
import type { ActorDirectory } from '~/cms/lib/authorship';
import { plural, statusLabel } from '~/cms/lib/format';
import {
  ApiError,
  apiErrorMessage,
  apiIssues,
  type PrincipalInfo,
  RequestTimeoutError,
} from '~/cms/lib/management';
import { useClient } from '../../lib/client-context';
import { useScopedQuery } from '../../lib/queries';

/*
 * The pieces the promotion screens share: what a promotion copies in words, its risk check, a
 * refusal's issues, and who may decide one. Every rule stays the API's: these only say what it
 * recorded, and keep Approve and Reject out of the way of someone the API would refuse anyway.
 */

/**
 * An entry id short enough for a row: its last 8 characters. Ids are UUIDv7, whose start is the
 * time they were made, so entries made together share it; the end is random and tells them apart.
 */
export const shortId = (id: string) => id.slice(-8);

/**
 * Rejected by whoever requested it: they withdrew it. The API records a withdrawal as a rejection
 * whose `decidedBy` is the requester, so this only names what the record already says.
 */
export const isWithdrawn = (p: Pick<Promotion, 'status' | 'requestedBy' | 'decidedBy'>) =>
  p.status === 'rejected' && p.decidedBy === p.requestedBy;

/** A promotion's status in words: "Withdrawn" for a requester's own rejection. */
export const statusWords = (p: Pick<Promotion, 'status' | 'requestedBy' | 'decidedBy'>) =>
  isWithdrawn(p) ? 'Withdrawn' : statusLabel(p.status);

const percent = (p: number) => `${Math.round(p * 100)}%`;

/** "2 content types, 14 entries and the block catalog": what a promotion copies. */
export function copiesLine(p: Pick<Promotion, 'contentTypes' | 'entries' | 'blocks'>): string {
  const parts = [
    ...(p.contentTypes.length ? [plural(p.contentTypes.length, 'content type')] : []),
    ...(p.entries.length ? [plural(p.entries.length, 'entry', 'entries')] : []),
    ...(p.blocks ? ['the block catalog and config'] : []),
  ];
  if (parts.length === 0) return 'Nothing';
  if (parts.length === 1) return parts[0] as string;
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/** Where a refusal's issue points, in the screen's words: the part it names, else its field. */
const ISSUE_PLACES: Record<string, string> = {
  contentTypes: 'Content types',
  entries: 'Entries',
  blocks: 'Blocks',
  target: 'Target',
  source: 'Source',
};
const placeOf = (field: string) => ISSUE_PLACES[field.split(/[.[]/)[0] ?? ''] ?? field;

/** What the API answered a request or decision it didn't carry out with. */
export type Refusal =
  | { readonly kind: 'issues'; readonly issues: readonly { field: string; message: string }[] }
  | { readonly kind: 'message'; readonly message: string }
  /** No answer in time: it may have gone through. */
  | { readonly kind: 'unconfirmed' };

/**
 * A failed request or decision, as the screen says it: a 422's issues (each in the API's words), a
 * 403, 404 or 409's message, or no answer. Null for anything else, which the caller rethrows (the
 * runner toasts it).
 */
export function refusalOf(err: unknown): Refusal | null {
  if (err instanceof RequestTimeoutError) return { kind: 'unconfirmed' };
  const issues = apiIssues(err);
  if (issues.length > 0) return { kind: 'issues', issues };
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
    return { kind: 'message', message: apiErrorMessage(err) };
  }
  return null;
}

/**
 * A refusal as a destructive Alert: grouped by the part each issue names (Content types, Entries,
 * Blocks), in the API's words, which name the type or entry and what to change. `title` says
 * what didn't happen ("Nothing was promoted into main"). An unconfirmed one is a plain Alert: it
 * may have gone through.
 */
export function RefusalAlert(props: {
  title: string;
  refusal: Refusal;
  /** What to do when the answer never came. */
  unconfirmed?: string;
  /** A line under the issues. */
  note?: string;
}) {
  const { refusal } = props;
  if (refusal.kind === 'unconfirmed') {
    return (
      <Alert>
        <AlertTitle>No answer yet</AlertTitle>
        <AlertDescription>
          <p>{props.unconfirmed ?? 'It may still have gone through: check before trying again.'}</p>
        </AlertDescription>
      </Alert>
    );
  }
  if (refusal.kind === 'message') {
    return (
      <Alert variant="destructive">
        <AlertTitle>{props.title}</AlertTitle>
        <AlertDescription>
          <p>{refusal.message}</p>
          {props.note ? <p>{props.note}</p> : null}
        </AlertDescription>
      </Alert>
    );
  }
  const groups = new Map<string, string[]>();
  for (const i of refusal.issues) {
    const place = placeOf(i.field);
    groups.set(place, [...(groups.get(place) ?? []), i.message]);
  }
  return (
    <Alert variant="destructive">
      <AlertTitle>{props.title}</AlertTitle>
      <AlertDescription className="space-y-2">
        {[...groups].map(([place, messages]) => (
          <div key={place} className="space-y-1">
            {/* One part only (the usual case) needs no heading over it. */}
            {groups.size > 1 ? <p className="font-medium">{place}</p> : null}
            <ul className="list-disc space-y-1 ps-4">
              {messages.map((m, i) => (
                // Keyed by position: two issues may read the same, and the list never reorders.
                <li key={i}>{m}</li>
              ))}
            </ul>
          </div>
        ))}
        {props.note ? <p>{props.note}</p> : null}
      </AlertDescription>
    </Alert>
  );
}

/**
 * Why a promotion needs a person (the rules' lines and the risk check's), each a sentence the API
 * wrote, then the decision model's view when it gave one.
 */
export function RiskReasons(props: { promotion: Pick<Promotion, 'risk'>; headingLevel?: 3 | 4 }) {
  const { risk } = props.promotion;
  const Heading = props.headingLevel === 4 ? 'h4' : 'h3';
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Heading className="caption">
          {risk.requiresApproval ? 'Why it needs approval' : 'Risk check'}
        </Heading>
        {risk.reasons.length > 0 ? (
          <ul className="list-disc space-y-1 ps-4 text-sm">
            {risk.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">No rule asked for a person to check it.</p>
        )}
      </div>
      {risk.assessment ? <Assessment assessment={risk.assessment} /> : null}
    </div>
  );
}

/**
 * The decision model's answer: its risk level and its two probabilities, in words and figures.
 * A heuristic answer says so, and why the model didn't answer: the figures aren't a model's then.
 */
function Assessment({ assessment }: { assessment: PromotionAssessment }) {
  const level = PROMOTION_RISK_LEVELS[Math.round(assessment.risk)] ?? 'Unrated';
  const model = assessment.source === 'model';
  return (
    <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1 text-sm">
      <dt className="caption">Assessed by</dt>
      <dd className="flex flex-wrap items-center gap-2">
        {model ? (
          <ToneBadge tone="ai" label="The model" />
        ) : (
          <>
            <ToneBadge tone="idle" label="A fallback" />
            {assessment.fallback ? (
              <span className="text-muted-foreground">
                The model didn’t answer ({assessment.fallback})
              </span>
            ) : null}
          </>
        )}
      </dd>
      <dt className="caption">Risk</dt>
      <dd>{level}</dd>
      <dt className="caption">Should be checked</dt>
      <dd className="tabular">{percent(assessment.review)}</dd>
      <dt className="caption">Could break content</dt>
      <dd className="tabular">{percent(assessment.breaking)}</dd>
    </dl>
  );
}

/**
 * A list that may run to hundreds (a promotion pins up to 200 entries): the first few, then Show
 * all, which keeps focus where it was and hands it to the first row it brought in.
 */
export function LongList<T>(props: {
  items: readonly T[];
  label: string;
  render: (item: T) => React.ReactNode;
  keyOf: (item: T) => string;
  first?: number;
}) {
  const first = props.first ?? 8;
  const [all, setAll] = useState(false);
  const listId = useId();
  const shown = all ? props.items : props.items.slice(0, first);
  const more = props.items.length - first;
  return (
    <div className="space-y-1">
      <ul id={listId} aria-label={props.label} className="divide-y rounded-xl bg-muted/50 text-sm">
        {shown.map((item, i) => (
          <li
            key={props.keyOf(item)}
            // The first row Show all brought in takes focus, so the keyboard carries on from there.
            tabIndex={all && i === first ? -1 : undefined}
            className="flex min-w-0 items-center gap-2 px-3 py-2"
          >
            {props.render(item)}
          </li>
        ))}
      </ul>
      {more > 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-controls={listId}
          aria-expanded={all}
          onClick={() => {
            setAll((a) => !a);
            if (!all) {
              requestAnimationFrame(() =>
                document
                  .getElementById(listId)
                  ?.querySelector<HTMLElement>(`li:nth-child(${first + 1})`)
                  ?.focus(),
              );
            }
          }}
        >
          {all ? 'Show fewer' : `Show all ${props.items.length}`}
        </Button>
      ) : null}
    </div>
  );
}

/** What a viewer may do with promotions, and if not, why: the API's rules, read off its answer. */
export interface PromotionViewer {
  readonly access: PrincipalInfo | undefined;
  readonly directory: ActorDirectory;
  /** Whether Request is offered (content:manage and content:publish, unrestricted). */
  readonly canRequest: boolean;
  /** Whether Approve is offered: never to its requester, and with types or blocks, content:manage. */
  readonly canApprove: (p: Pick<Promotion, 'requestedBy' | 'contentTypes' | 'blocks'>) => boolean;
  /** Whether Reject is offered: never to its requester. */
  readonly canReject: (p: Pick<Promotion, 'requestedBy'>) => boolean;
  /** Whether Withdraw is offered: to its requester, as a person, whose role could reject it. */
  readonly canWithdraw: (p: Pick<Promotion, 'requestedBy'>) => boolean;
}

/**
 * Who the session is in this space (its scopes and subject, the `['space-access']` query the
 * editor shares) and the team (an administrator's only), so actors read as names and the
 * controls show only to someone the API would let use them. The API decides regardless: these
 * only keep a control out of the way of someone it would refuse, as `useCan` does.
 */
export function usePromotionViewer(): PromotionViewer {
  const { client } = useClient();
  const access = useScopedQuery(['space-access'], () => client.getSpaceAccess(), {
    silent: true,
  }).data;
  const isAdmin = access?.scopes.includes('space:admin') === true;
  const team = useScopedQuery(['team'], () => client.getTeam(), {
    silent: true,
    enabled: isAdmin,
  }).data;
  const directory: ActorDirectory = {
    ...(access?.subject ? { me: access.subject } : {}),
    ...(team?.people ? { people: team.people } : {}),
  };
  const has = (scope: string) => access?.scopes.includes(scope) === true;
  const unrestricted = !!access && !access.restricted;
  const canReject = (p: Pick<Promotion, 'requestedBy'>) =>
    unrestricted &&
    has('content:publish') &&
    // A person decides (the admin's every call is one): never whoever asked for it.
    !!access?.subject &&
    access.subject !== p.requestedBy;
  return {
    access,
    directory,
    canRequest: unrestricted && has('content:publish') && has('content:manage'),
    canReject,
    canWithdraw: (p) =>
      unrestricted &&
      has('content:publish') &&
      !!access?.subject &&
      access.subject === p.requestedBy,
    canApprove: (p) =>
      canReject(p) && (has('content:manage') || (p.contentTypes.length === 0 && !p.blocks)),
  };
}
