import {
  AI_CAPABILITIES,
  AI_CAPABILITY_INFO,
  AI_GUIDANCE_MAX_CHARS,
  type AiCapability,
  type AiSettings as AiSettingsDoc,
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
import { useEffect, useId, useRef, useState } from 'react';
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
import { ApiError, apiErrorMessage, type ManagementClient } from '../lib/management';
import { useInvalidate, useScopedQuery } from '../lib/queries';
import { useToast } from '../lib/toast';

/** The tier select's choices, each with what it means in a line. `default` stands for null. */
export const TIER_CHOICES = [
  { value: 'default', label: 'Default', meaning: 'What each feature uses on its own' },
  { value: 'flagship', label: 'Flagship', meaning: 'Most capable; slower and costs more' },
  { value: 'balanced', label: 'Balanced', meaning: 'Good quality at a moderate cost' },
  { value: 'fast', label: 'Fast', meaning: 'Quickest and cheapest; for short, simple text' },
] as const;

const count = new Intl.NumberFormat('en-US');

/**
 * Settings → AI: one row per AI capability, each with a switch, a model tier and guidance added to
 * its built-in prompt, saved together with one Save. The save is held to the version the page read:
 * someone else's save in between is refused (409), and the page keeps the edits and offers to load
 * theirs. Changing them needs space:admin; the API's refusal says so.
 */
export function AiSettings(props: { client: ManagementClient }) {
  const { client } = props;
  const toast = useToast();
  const invalidate = useInvalidate();
  // Silent: a failed load is said here, in place, with Retry, not as a toast.
  const settings = useScopedQuery(AI_SETTINGS_KEY, () => client.getAiSettings(), {
    silent: true,
  });

  // What the form was edited from, and the form. A refetch never replaces edits under way.
  const [base, setBase] = useState<AiSettingsDoc>();
  const [draft, setDraft] = useState<AiSettingsDraft>();
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState<{ version: number }>();
  const [loading, setLoading] = useState(false);
  const staleRef = useRef<HTMLDivElement>(null);

  const changes = base && draft ? changedCapabilities(base, draft) : {};
  const dirty = Object.keys(changes).length > 0;
  const over = draft ? AI_CAPABILITIES.some((c) => guidanceLength(draft[c].guidance).over) : false;

  useEffect(() => {
    const data = settings.data;
    // Follows what is saved (it loaded, or another tab saved), unless there are edits to keep.
    if (!data || base?.version === data.version) return;
    if (base && draft && dirtyOf(base, draft)) return;
    setBase(data);
    setDraft(draftOf(data));
  }, [settings.data, base, draft]);

  useEffect(() => {
    if (stale) staleRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [stale]);

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
      setStale(undefined);
      setBase(res.settings);
      setDraft(draftOf(res.settings));
      await invalidate(AI_SETTINGS_KEY);
      toast.success('AI settings saved');
    } catch (err) {
      const theirs = staleVersion(err);
      if (theirs !== undefined) setStale({ version: theirs });
      else toast.error(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const loadLatest = async () => {
    setLoading(true);
    try {
      const latest = await client.getAiSettings();
      setBase(latest);
      setDraft(draftOf(latest));
      setStale(undefined);
      await invalidate(AI_SETTINGS_KEY);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const description =
    'What AI may do in this space, the model tier each part runs on, and guidance added to its ' +
    'built-in instructions.';

  if (!draft || !base) {
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

  return (
    <Section title="AI" description={description} flush>
      <ul className="divide-y border-t">
        {AI_CAPABILITIES.map((c) => (
          <CapabilityRow
            key={c}
            capability={c}
            value={draft[c]}
            disabled={busy}
            onChange={(next) => edit(c, next)}
          />
        ))}
      </ul>
      <div className="space-y-3 border-t px-(--card-spacing) py-4">
        <p className="max-w-measure text-muted-foreground text-sm">
          Guidance shapes tone, style and wording. It can’t change what a feature does, the tools it
          may use, or what it returns.
        </p>
        {stale ? (
          <Alert ref={staleRef} variant="warning">
            <AlertTitle className="line-clamp-none">
              The AI settings changed since you opened them
            </AlertTitle>
            <AlertDescription>
              <p>
                Someone else saved them as v{stale.version}, so your changes weren’t saved: saving
                them would undo theirs. Load the latest to edit them (your changes here are
                discarded), or copy your version first.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <CopyButton
                  text={JSON.stringify(changes, null, 2)}
                  label="Copy my changes as JSON"
                />
                <Button
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
        <div className="flex flex-wrap items-center justify-end gap-2">
          {dirty ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setDraft(draftOf(base));
                setStale(undefined);
              }}
            >
              Discard changes
            </Button>
          ) : null}
          <Button
            type="button"
            disabled={!dirty || over || busy || stale !== undefined}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </Section>
  );
}

const dirtyOf = (base: AiSettingsDoc, draft: AiSettingsDraft) =>
  Object.keys(changedCapabilities(base, draft)).length > 0;

/** The version a 409 says the settings are at now; undefined for any other error. */
function staleVersion(err: unknown): number | undefined {
  if (!(err instanceof ApiError) || err.status !== 409) return undefined;
  const error = (err.body as { error?: { code?: unknown; details?: { version?: unknown } } })
    ?.error;
  const version = error?.code === 'conflict' ? error.details?.version : undefined;
  return typeof version === 'number' ? version : undefined;
}

function CapabilityRow(props: {
  capability: AiCapability;
  value: AiCapabilityDraft;
  disabled: boolean;
  onChange: (next: Partial<AiCapabilityDraft>) => void;
}) {
  const { capability, value, disabled, onChange } = props;
  const info = AI_CAPABILITY_INFO[capability];
  const id = useId();
  const { chars, over } = guidanceLength(value.guidance);
  const tier = value.tier ?? 'default';
  return (
    <li className="space-y-3 px-(--card-spacing) py-4" aria-labelledby={`${id}-name`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 id={`${id}-name`} className="font-medium text-sm">
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
            <Label htmlFor={`${id}-tier`}>Model tier</Label>
            <Select
              value={tier}
              disabled={disabled}
              onValueChange={(v) =>
                onChange({ tier: v === 'default' ? null : (v as AiCapabilityDraft['tier']) })
              }
            >
              <SelectTrigger id={`${id}-tier`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIER_CHOICES.map((t) => (
                  <SelectItem key={t.value} value={t.value} textValue={t.label}>
                    <span className="flex flex-col">
                      <span>{t.label}</span>
                      <span className="text-muted-foreground text-xs">{t.meaning}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-guidance`}>Guidance</Label>
            <Textarea
              id={`${id}-guidance`}
              value={value.guidance}
              disabled={disabled}
              rows={2}
              placeholder="For example: write in British English; keep headlines under eight words."
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
