import {
  AI_CAPABILITIES,
  AI_CAPABILITY_INFO,
  AI_GUIDANCE_MAX_CHARS,
  type AiCapability,
  type AiModelTier,
  type AiSettingsView as AiSettingsDoc,
  isAboveTierCap,
  SCOPES,
} from '@contentworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import { Label } from '@contentworker/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentworker/ui/select';
import { SkeletonText } from '@contentworker/ui/skeleton';
import { Switch } from '@contentworker/ui/switch';
import { Textarea } from '@contentworker/ui/textarea';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { useBlocker } from 'react-router';
import { InlineConfirm } from '~/cms/components/InlineConfirm';
import { LoadingStatus } from '~/cms/components/loading';
import { Section } from '~/cms/components/page';
import { CopyButton } from '~/components/copy-button';
import {
  AI_SETTINGS_KEY,
  type AiCapabilityDraft,
  type AiSettingsDraft,
  changedCapabilities,
  draftOf,
  guidanceLength,
} from '../lib/ai-settings';
import { useClient } from '../lib/client-context';
import {
  ApiError,
  apiErrorMessage,
  type ManagementClient,
  RequestTimeoutError,
} from '../lib/management';
import { useScopedQuery } from '../lib/queries';
import { useToast } from '../lib/toast';

/** The tier select's choices, each with what it means in a line. `default` stands for null. */
export const TIER_CHOICES = [
  { value: 'default', label: 'Default', meaning: 'What each feature uses on its own' },
  { value: 'flagship', label: 'Flagship', meaning: 'Most capable; slower and costs more' },
  { value: 'balanced', label: 'Balanced', meaning: 'Good quality at a moderate cost' },
  { value: 'fast', label: 'Fast', meaning: 'Quickest and cheapest; for short, simple text' },
] as const;

const count = new Intl.NumberFormat('en-US');

/** A refused stale save: the version stored now, and whether the save before may have landed. */
interface Stale {
  readonly version: number;
  readonly unconfirmed: boolean;
}

/**
 * Settings → AI: one row per AI capability, each with a switch, a model tier and guidance added to
 * its built-in prompt, saved together with one Save. The save is held to the version the page read:
 * someone else's save in between is refused (409), and the page keeps the edits and offers to load
 * theirs. Changing them needs space:admin: without it the page reads only and says so.
 */
export function AiSettings(props: { client: ManagementClient }) {
  const { client } = props;
  const toast = useToast();
  const queryClient = useQueryClient();
  const { conn } = useClient();
  // Silent: a failed load is said here, in place, with Retry, not as a toast.
  const settings = useScopedQuery(AI_SETTINGS_KEY, () => client.getAiSettings(), {
    silent: true,
  });
  const access = useScopedQuery(['space-access'], () => client.getSpaceAccess(), { silent: true });
  // Until access is known the form waits, rather than offering edits it may refuse.
  const canEdit = access.data?.scopes.includes(SCOPES.spaceAdmin) === true;

  // What the form was edited from, and the form. A refetch never replaces edits under way, and
  // never takes the form back to an older version than it holds.
  const [base, setBase] = useState<AiSettingsDoc>();
  const [draft, setDraft] = useState<AiSettingsDraft>();
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState<Stale>();
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [said, setSaid] = useState('');
  const loadLatestRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLElement>(null);

  const changes = base && draft ? changedCapabilities(base, draft) : {};
  const dirty = Object.keys(changes).length > 0;
  const over = draft ? AI_CAPABILITIES.some((c) => guidanceLength(draft[c].guidance).over) : false;

  useEffect(() => {
    const data = settings.data;
    if (!data || (base && data.version <= base.version)) return;
    if (base && draft && Object.keys(changedCapabilities(base, draft)).length > 0) return;
    setBase(data);
    setDraft(draftOf(data));
  }, [settings.data, base, draft]);

  // On a refused stale save, the way on takes focus; the Alert's text is read as it appears.
  useEffect(() => {
    if (stale) loadLatestRef.current?.focus();
  }, [stale]);

  // Work in the form is never left quietly: leaving the page asks, closing the tab warns.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  /** What the page holds now, written to the cache first, so no reader goes back to older. */
  const settle = (next: AiSettingsDoc) => {
    queryClient.setQueryData([conn.space, conn.environment, ...AI_SETTINGS_KEY], next);
    setBase(next);
    setDraft(draftOf(next));
    setStale(undefined);
  };

  const edit = (capability: AiCapability, next: Partial<AiCapabilityDraft>) =>
    setDraft((d) => (d ? { ...d, [capability]: { ...d[capability], ...next } } : d));

  const save = async () => {
    if (!base || !draft || !dirty || over) return;
    setBusy(true);
    try {
      const res = await client.setAiSettings({
        expectedVersion: base.version,
        capabilities: changes,
      });
      settle(res.settings);
      setUnconfirmed(false);
      toast.success('AI settings saved');
    } catch (err) {
      const theirs = staleVersion(err);
      if (theirs !== undefined) setStale({ version: theirs, unconfirmed });
      else {
        // An outcome nobody knows (no answer, a dropped connection, a 5xx): a 409 on the retry
        // may be this very save, so the warning won't blame someone else for it.
        if (!(err instanceof ApiError) || err.status >= 500 || err instanceof RequestTimeoutError) {
          setUnconfirmed(true);
        }
        toast.error(apiErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const loadLatest = async () => {
    setLoading(true);
    try {
      const latest = await client.getAiSettings();
      settle(latest);
      setUnconfirmed(false);
      setSaid(`Loaded v${latest.version}. Your changes here were discarded.`);
      headingRef.current?.focus();
    } catch (err) {
      toast.error(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const discard = () => {
    if (!base) return;
    setDraft(draftOf(base));
    setStale(undefined);
    headingRef.current?.focus();
  };

  const description =
    'What AI may do in this space, the model tier each part runs on, and guidance added to its ' +
    'built-in instructions.';

  if (!draft || !base || access.isPending) {
    return (
      <Section title="AI" description={description}>
        {settings.isError ? (
          <Alert variant="destructive">
            <AlertTitle>The AI settings didn’t load</AlertTitle>
            <AlertDescription>
              <p>{apiErrorMessage(settings.error)}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => void settings.refetch()}
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <div aria-busy="true">
            <LoadingStatus>Loading the AI settings…</LoadingStatus>
            <SkeletonText width="20rem" />
          </div>
        )}
      </Section>
    );
  }

  const readOnly = !canEdit;
  return (
    <Section title="AI" description={description} flush>
      {/* Where focus goes once the form is reseeded (a load, a discard): the list it heads. */}
      <section ref={headingRef} tabIndex={-1} aria-label="AI capabilities" className="outline-none">
        <p className="sr-only" role="status">
          {said}
        </p>
        {readOnly ? (
          <p className="max-w-measure px-(--card-spacing) pb-3 text-muted-foreground text-sm">
            Changing these takes the space:admin scope. They’re shown here read-only.
          </p>
        ) : null}
        <ul className="divide-y border-t">
          {AI_CAPABILITIES.map((c) => (
            <CapabilityRow
              key={c}
              capability={c}
              value={draft[c]}
              maxTier={base.maxTier ?? 'flagship'}
              disabled={busy || readOnly}
              onChange={(next) => edit(c, next)}
            />
          ))}
        </ul>
      </section>
      <div className="space-y-3 border-t px-(--card-spacing) py-4">
        <p className="max-w-measure text-muted-foreground text-sm">
          Guidance shapes tone, style and wording. It can’t change what a feature does, the tools it
          may use, or what it returns.
        </p>
        {stale ? (
          <Alert variant="warning">
            <AlertTitle className="line-clamp-none">
              The AI settings changed since you opened them
            </AlertTitle>
            <AlertDescription>
              <p>
                {stale.unconfirmed
                  ? `They’re at v${stale.version} now: that may be your own save that didn’t confirm, or someone else’s. Your changes here weren’t saved.`
                  : `Someone else saved them as v${stale.version}, so your changes weren’t saved: saving them would undo theirs.`}{' '}
                Load the latest to edit them (your changes here are discarded), or copy yours first.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <CopyButton
                  text={JSON.stringify(changes, null, 2)}
                  label="Copy my changes as JSON"
                />
                <Button
                  ref={loadLatestRef}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={loading}
                  onClick={() => void loadLatest()}
                >
                  {loading ? 'Loading…' : 'Load the latest'}
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : null}
        {blocker.state === 'blocked' ? (
          <InlineConfirm
            className="rounded-none bg-wait/10 px-4"
            message="The AI settings have unsaved changes. Leave without saving them?"
            cancelLabel="Stay"
            onCancel={() => blocker.reset?.()}
          >
            <Button type="button" size="sm" variant="outline" onClick={() => blocker.proceed?.()}>
              Leave without saving
            </Button>
          </InlineConfirm>
        ) : null}
        {readOnly ? null : (
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
            <p
              className={over ? 'text-destructive text-sm' : 'text-muted-foreground text-sm'}
              aria-live="polite"
            >
              {over ? 'Shorten the guidance marked to save.' : dirty ? 'Unsaved changes' : ''}
            </p>
            <Button type="button" variant="outline" disabled={busy || !dirty} onClick={discard}>
              Discard changes
            </Button>
            <Button
              type="button"
              disabled={!dirty || over || busy || stale !== undefined}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        )}
      </div>
    </Section>
  );
}

/** The version a 409 says the settings are at now; undefined for any other error. */
function staleVersion(err: unknown): number | undefined {
  if (!(err instanceof ApiError) || err.status !== 409) return undefined;
  const error = (err.body as { error?: { code?: unknown; details?: { version?: unknown } } })
    ?.error;
  const version = error?.code === 'conflict' ? error.details?.version : undefined;
  return typeof version === 'number' ? version : undefined;
}

/** A tier's label, as the select names it. */
const tierLabel = (tier: AiModelTier): string =>
  TIER_CHOICES.find((t) => t.value === tier)?.label ?? tier;

/**
 * What the tier select says under it: the chosen tier's meaning, and the deployment's cap when it
 * has one. A tier above the cap (chosen before the cap was lowered) is kept as set, and the hint
 * says what it runs on instead; the API reports the same as `effectiveTier`.
 */
export function tierHint(tier: AiModelTier | null, maxTier: AiModelTier): string {
  const meaning = TIER_CHOICES.find((t) => t.value === (tier ?? 'default'))?.meaning ?? '';
  if (maxTier === 'flagship') return meaning;
  const cap = tierLabel(maxTier);
  if (tier && isAboveTierCap(tier, maxTier)) {
    return `Runs on ${cap}: this deployment caps AI at ${cap}.`;
  }
  return `${meaning}. Capped at ${cap} by this deployment.`;
}

function CapabilityRow(props: {
  capability: AiCapability;
  value: AiCapabilityDraft;
  /** The deployment's tier cap: tiers above it can't be chosen. */
  maxTier: AiModelTier;
  disabled: boolean;
  onChange: (next: Partial<AiCapabilityDraft>) => void;
}) {
  const { capability, value, maxTier, disabled, onChange } = props;
  const info = AI_CAPABILITY_INFO[capability];
  const id = useId();
  const { chars, over } = guidanceLength(value.guidance);
  const tier = value.tier ?? 'default';
  const chosen = TIER_CHOICES.find((t) => t.value === tier) ?? TIER_CHOICES[0];
  const name = `${id}-name`;
  return (
    <li className="space-y-3 px-(--card-spacing) py-4" aria-labelledby={name}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 id={name} className="font-medium text-sm">
            {info.label}
          </h3>
          <p id={`${id}-covers`} className="max-w-measure text-muted-foreground text-sm">
            {info.covers}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-muted-foreground text-ui" aria-hidden="true">
            {value.enabled ? 'On' : 'Off'}
          </span>
          <Switch
            checked={value.enabled}
            disabled={disabled}
            aria-label={info.label}
            aria-describedby={`${id}-covers`}
            onCheckedChange={(enabled) => onChange({ enabled })}
          />
        </div>
      </div>
      {info.guided ? (
        <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
          <div className="space-y-1.5">
            <Label id={`${id}-tier-label`} htmlFor={`${id}-tier`}>
              Model tier
            </Label>
            <Select
              value={tier}
              disabled={disabled}
              onValueChange={(v) =>
                onChange({ tier: v === 'default' ? null : (v as AiCapabilityDraft['tier']) })
              }
            >
              <SelectTrigger
                id={`${id}-tier`}
                className="w-full"
                aria-labelledby={`${id}-tier-label ${name}`}
                aria-describedby={`${id}-tier-hint`}
              >
                <SelectValue>{chosen.label}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {TIER_CHOICES.map((t) => {
                  const above = t.value !== 'default' && isAboveTierCap(t.value, maxTier);
                  return (
                    <SelectItem key={t.value} value={t.value} textValue={t.label} disabled={above}>
                      {t.label}
                      <span className="sr-only">: </span>
                      <span className="ml-1.5 text-muted-foreground text-xs">
                        {above ? `Above this deployment’s cap (${tierLabel(maxTier)})` : t.meaning}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <p id={`${id}-tier-hint`} className="text-muted-foreground text-xs">
              {tierHint(value.tier, maxTier)}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label id={`${id}-guidance-label`} htmlFor={`${id}-guidance`}>
              Guidance
            </Label>
            <Textarea
              id={`${id}-guidance`}
              value={value.guidance}
              disabled={disabled}
              rows={2}
              placeholder="For example: write in British English; keep headlines under eight words."
              aria-labelledby={`${id}-guidance-label ${name}`}
              aria-invalid={over || undefined}
              aria-describedby={`${id}-count`}
              onChange={(e) => onChange({ guidance: e.target.value })}
            />
            <p
              id={`${id}-count`}
              className={over ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}
            >
              {count.format(chars)} of {count.format(AI_GUIDANCE_MAX_CHARS)} characters
              {over ? ': shorten it to save.' : ''}
            </p>
            {/* Said once, as it crosses the limit, not on every keystroke. */}
            <p className="sr-only" role="status">
              {over
                ? `${info.label} guidance is over ${count.format(AI_GUIDANCE_MAX_CHARS)} characters`
                : ''}
            </p>
          </div>
        </div>
      ) : (
        <p className="max-w-measure text-muted-foreground text-sm">
          Embeddings run on the deployment’s embedding model, with no prompt: there is no tier or
          guidance to set.
        </p>
      )}
    </li>
  );
}
