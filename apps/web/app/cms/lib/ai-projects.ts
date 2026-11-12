import {
  type AiCapability,
  type AiEditSize,
  type AiProjectCapability,
  type AiProjectUse,
  type AiProposalOutcome,
  type AiReferenceLeftOut,
  aiEditSize,
} from '@contentworker/domain';
import { useCallback } from 'react';
import { useAiCapability } from './ai-settings';
import { useClient } from './client-context';
import type { AiProjectSummary, ProjectChoice } from './management';
import { useScopedQuery } from './queries';

/** The query key every reader of the environment's AI projects shares, so a save refreshes all. */
export const AI_PROJECTS_KEY = ['ai-projects'] as const;

/**
 * The environment's AI projects, for the pickers and the provenance lines. Silent: a person whose
 * role can't list them (listing takes content:write) gets none, and every picker stays hidden.
 */
export function useAiProjects(enabled = true) {
  const { client } = useClient();
  return useScopedQuery(AI_PROJECTS_KEY, () => client.listAiProjects(), {
    silent: true,
    staleTime: 60_000,
    enabled,
  });
}

/** A picker's value: the environment's default, none, or one project by id. */
export type PickerValue = 'default' | 'none' | string;

/** What a picker's value sends: absent for the default, null for none, else the id. */
export const choiceOf = (value: PickerValue): ProjectChoice =>
  value === 'default' ? undefined : value === 'none' ? null : value;

/** A picker's value for a stored or sent choice. */
export const pickerValueOf = (choice: ProjectChoice): PickerValue =>
  choice === undefined ? 'default' : choice === null ? 'none' : choice;

export interface PickerOption {
  readonly value: PickerValue;
  readonly label: string;
  readonly description?: string | null;
}

/**
 * A picker's choices in the spec's order: the default first ("Default (Brand voice)"), then the
 * others by name, then None. With no default, the default choice is the same as none, so it isn't
 * offered twice: None comes first.
 *
 * `stored` is for a choice kept on an AI action or a schedule, where there is no "none": absent
 * means the environment's default at each run, so that comes first, then every project by name
 * (picking the default project by name keeps it even if the default changes).
 */
export function pickerOptions(
  projects: readonly AiProjectSummary[],
  opts: { readonly stored?: boolean } = {},
): PickerOption[] {
  const fallback = projects.find((p) => p.isDefault);
  if (opts.stored) {
    return [
      {
        value: 'default',
        label: fallback
          ? `The default at each run (now ${fallback.name})`
          : 'The default at each run',
      },
      ...projects.map((p) => ({ value: p.id, label: p.name, description: p.description })),
    ];
  }
  const others = projects
    .filter((p) => !p.isDefault)
    .map((p) => ({ value: p.id, label: p.name, description: p.description }));
  return fallback
    ? [
        {
          value: 'default',
          label: `Default (${fallback.name})`,
          description: fallback.description,
        },
        ...others,
        { value: 'none', label: 'None' },
      ]
    : [{ value: 'default', label: 'None' }, ...others];
}

/**
 * Whether a picker shows: there are projects to pick, and at least one capability it serves is on
 * for the space. A capability that is off hides what it powers, as Settings → AI says.
 */
export function usePickerShown(...capabilities: readonly AiCapability[]): {
  readonly shown: boolean;
  readonly projects: readonly AiProjectSummary[];
} {
  const a = useAiCapability(capabilities[0] ?? 'drafting');
  const b = useAiCapability(capabilities[1] ?? capabilities[0] ?? 'drafting');
  const on = a || b;
  const projects = useAiProjects(on).data ?? [];
  return { shown: on && projects.length > 0, projects };
}

/** What a reference left out says, in a few words. */
const LEFT_OUT: Readonly<Record<AiReferenceLeftOut, string>> = {
  forbidden: 'you can’t read it',
  no_text: 'it has no text',
  pending: 'it’s still being read',
  gone: 'the file is gone',
  budget: 'there was no room for it',
};

export const leftOutWords = (reason: AiReferenceLeftOut | undefined): string =>
  reason ? LEFT_OUT[reason] : 'it wasn’t used';

/**
 * The provenance line's text: "Used project: Brand voice · 2 references (1 left out: you can't
 * read it)". A project the list can't name (deleted since, or not readable) says "an AI project".
 */
export function provenanceLine(use: AiProjectUse, name: string | undefined): string {
  const total = use.references.length;
  const out = use.references.filter((r) => !r.used);
  const head = `Used project: ${name ?? 'an AI project'}`;
  if (total === 0) return `${head} · no references`;
  const refs = `${total} ${total === 1 ? 'reference' : 'references'}`;
  if (out.length === 0) return `${head} · ${refs}`;
  const reasons = [...new Set(out.map((r) => leftOutWords(r.reason)))];
  return `${head} · ${refs} (${out.length} left out: ${reasons.join('; ')})`;
}

/** The characters a value reads as, for measuring an edit: strings as they are, others as JSON. */
const textOf = (v: unknown): string =>
  v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v);

/**
 * How many characters differ between two texts: what is left once the common start and end are
 * taken off, on the longer side. Cheap and deterministic; a bucket needs no more.
 */
function changedChars(a: string, b: string): number {
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a[start] === b[start]) start++;
  let end = 0;
  while (end < max - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return Math.max(a.length, b.length) - start - end;
}

/**
 * What a person did with a proposal of field values, measured here (its text never leaves the
 * browser): kept as proposed, or edited by a size bucket. `kept` holds the values as saved,
 * keyed like `proposed` (`field` → `locale` → value).
 */
export function outcomeOf(
  proposed: Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>>,
  kept: Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>>,
): { readonly outcome: AiProposalOutcome; readonly edit?: AiEditSize } {
  let total = 0;
  let changed = 0;
  for (const [field, byLocale] of Object.entries(proposed)) {
    for (const [locale, value] of Object.entries(byLocale ?? {})) {
      const was = textOf(value);
      total += was.length;
      changed += changedChars(was, textOf(kept[field]?.[locale]));
    }
  }
  return changed === 0
    ? { outcome: 'accepted' }
    : { outcome: 'edited', edit: aiEditSize(changed, total) };
}

/**
 * Reports what became of a proposal made in a project (the spec's production signal), fire and
 * forget: a count per project, never content, and a failed report never troubles the person. A
 * proposal made in no project reports nothing.
 */
export function useProjectOutcome() {
  const { client } = useClient();
  return useCallback(
    (
      use: AiProjectUse | null | undefined,
      capability: AiProjectCapability,
      outcome: AiProposalOutcome,
      edit?: AiEditSize,
    ) => {
      if (!use) return;
      void client
        .recordAiProjectOutcome(use.id, { capability, outcome, ...(edit ? { edit } : {}) })
        .catch(() => undefined);
    },
    [client],
  );
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The AI project a Coworker tool call reported working in, from its output in the conversation:
 * the tool's JSON while the turn streams (fenced as `<user_content>`), or the cut-down record the
 * agent keeps once the turn is over. Null when it took none or the output says nothing of it.
 */
export function projectOfOutput(output: unknown): AiProjectUse | null {
  let value = output;
  if (typeof value === 'string') {
    const start = value.indexOf('{');
    const end = value.lastIndexOf('}');
    if (start < 0 || end < start) return null;
    try {
      value = JSON.parse(value.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  const project = isRecord(value) ? value.project : undefined;
  if (!isRecord(project) || typeof project.id !== 'string') return null;
  const refs = Array.isArray(project.references) ? project.references.filter(isRecord) : [];
  return {
    id: project.id,
    version: typeof project.version === 'number' ? project.version : 0,
    references: refs.map((r) => ({
      assetId: typeof r.assetId === 'string' ? r.assetId : '',
      version: typeof r.version === 'number' ? r.version : 0,
      used: r.used === true,
      ...(typeof r.reason === 'string' ? { reason: r.reason as AiReferenceLeftOut } : {}),
    })),
  };
}
