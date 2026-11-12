/**
 * AI projects: a named, reusable context for AI work in one environment. Instructions, a writer
 * persona (the voice), a reader persona (the audience) and reference files whose extracted text a
 * model may consult. Someone picks a project per request (or stores one on an AI action or an agent
 * schedule), and every model call in that work carries it, fenced as data under the space's own
 * guidance (`docs/specs/ai-projects.md`).
 *
 * Versioned like the AI settings: each update is a compare-and-set on `version`. References are
 * pinned to one file version, so a replaced file changes no prompt until someone moves the pin.
 */

import { DomainError, type FieldIssue, ValidationError } from '../errors';
import { type AiCapability, normalizeAiGuidance } from './ai-settings';

/** Longest name, in characters (unique in the environment, ignoring case). */
export const AI_PROJECT_NAME_MAX = 100;
/** Longest description: shown in pickers, never sent to a model. */
export const AI_PROJECT_DESCRIPTION_MAX = 500;
/** Longest instructions, after the guidance normalization. */
export const AI_PROJECT_INSTRUCTIONS_MAX = 4000;
/** Longest persona name. */
export const AI_PERSONA_NAME_MAX = 100;
/** Longest persona description. */
export const AI_PERSONA_DESCRIPTION_MAX = 1000;
/** Most references a project holds, in order of importance. */
export const AI_PROJECT_MAX_REFERENCES = 10;
/** Most projects one environment holds: a picker, not a library. */
export const AI_PROJECT_MAX_PER_ENVIRONMENT = 100;

/** Who is writing, or who it is for: a name and prose, nothing typed beyond that. */
export interface AiPersona {
  readonly name: string;
  /** Who they are, what they know and care about, how they speak or read. */
  readonly description: string;
}

/** A reference pinned to one file version: a replaced file changes nothing until moved to. */
export interface AiReference {
  readonly assetId: string;
  readonly version: number;
}

export interface AiProject {
  readonly id: string;
  readonly name: string;
  /** Shown in pickers; never sent to a model. */
  readonly description: string | null;
  /** What to do and avoid, terminology, facts to prefer. */
  readonly instructions: string | null;
  readonly writer: AiPersona | null;
  readonly reader: AiPersona | null;
  /** In order of importance. */
  readonly references: readonly AiReference[];
  /** At most one per environment; only `space:admin` sets or clears it. */
  readonly isDefault: boolean;
  /** 1 at creation, then one more for each write that changed something. */
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
}

/**
 * The capabilities whose calls carry a project (decision 6, amended D and G). Media, search,
 * workflows, moderation, change summaries and promotion reviews don't: an explicit project there
 * is refused.
 */
export const AI_PROJECT_CAPABILITIES = [
  'drafting',
  'layout',
  'assistant',
  'field-assist',
  'translation',
  'agents',
] as const satisfies readonly AiCapability[];
export type AiProjectCapability = (typeof AI_PROJECT_CAPABILITIES)[number];

export const takesAiProject = (capability: AiCapability): capability is AiProjectCapability =>
  (AI_PROJECT_CAPABILITIES as readonly string[]).includes(capability);

/** A project's own text as one capability receives it: translation takes less (amendment G). */
export interface AiProjectParts {
  readonly instructions: boolean;
  readonly writer: boolean;
  readonly reader: boolean;
  readonly references: boolean;
}

export function aiProjectPartsFor(capability: AiProjectCapability): AiProjectParts {
  // Translation keeps the source's voice (no writer) and its facts (no references); the
  // instructions carry terminology and the reader says who the target text is for.
  if (capability === 'translation') {
    return { instructions: true, writer: false, reader: true, references: false };
  }
  return { instructions: true, writer: true, reader: true, references: true };
}

/** One reference as a save sends it: without `version`, the asset's current file is pinned. */
export interface AiReferenceInput {
  readonly assetId: string;
  readonly version?: number;
}

/** A project as a create or an update sends it: every editable part, whole. */
export interface AiProjectInput {
  readonly name: string;
  readonly description?: string | null;
  readonly instructions?: string | null;
  readonly writer?: AiPersona | null;
  readonly reader?: AiPersona | null;
  readonly references?: readonly AiReferenceInput[];
}

/** {@link AiProjectInput} checked and normalized; references not yet pinned. */
export interface AiProjectDraft {
  readonly name: string;
  readonly description: string | null;
  readonly instructions: string | null;
  readonly writer: AiPersona | null;
  readonly reader: AiPersona | null;
  readonly references: readonly AiReferenceInput[];
}

/** The key a name is unique by: case folded, whitespace collapsed. */
export const aiProjectNameKey = (name: string): string =>
  name.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');

const text = (v: unknown): v is string => typeof v === 'string';

function persona(raw: unknown, field: string, issues: FieldIssue[]): AiPersona | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ field, message: 'An object with name and description, or null' });
    return null;
  }
  const p = raw as { name?: unknown; description?: unknown };
  const name = text(p.name) ? p.name.replace(/\s+/g, ' ').trim() : '';
  const description = text(p.description) ? (normalizeAiGuidance(p.description) ?? '') : '';
  if (!name) issues.push({ field: `${field}.name`, message: 'Required' });
  else if (name.length > AI_PERSONA_NAME_MAX) {
    issues.push({ field: `${field}.name`, message: `At most ${AI_PERSONA_NAME_MAX} characters` });
  }
  if (!description) issues.push({ field: `${field}.description`, message: 'Required' });
  else if (description.length > AI_PERSONA_DESCRIPTION_MAX) {
    issues.push({
      field: `${field}.description`,
      message: `At most ${AI_PERSONA_DESCRIPTION_MAX} characters (it has ${description.length})`,
    });
  }
  return { name, description };
}

function optionalText(
  raw: unknown,
  field: string,
  max: number,
  issues: FieldIssue[],
): string | null {
  if (raw === null || raw === undefined) return null;
  if (!text(raw)) {
    issues.push({ field, message: 'Plain text, or null for none' });
    return null;
  }
  const kept = normalizeAiGuidance(raw);
  if (kept && kept.length > max) {
    issues.push({ field, message: `At most ${max} characters (it has ${kept.length})` });
  }
  return kept;
}

/**
 * A create's or an update's body checked, whatever surface sent it: 422 naming each part that is
 * out of bounds. References are checked for shape here (at most ten, each asset once); whether
 * each one names a readable document or recording is the use-case's question.
 */
export function checkAiProjectInput(input: unknown): AiProjectDraft {
  const issues: FieldIssue[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError([{ field: '', message: 'An AI project object' }]);
  }
  const raw = input as Record<string, unknown>;
  const name = text(raw.name) ? raw.name.replace(/\s+/g, ' ').trim() : '';
  if (!name) issues.push({ field: 'name', message: 'Required' });
  else if (name.length > AI_PROJECT_NAME_MAX) {
    issues.push({ field: 'name', message: `At most ${AI_PROJECT_NAME_MAX} characters` });
  }
  const description = optionalText(
    raw.description,
    'description',
    AI_PROJECT_DESCRIPTION_MAX,
    issues,
  );
  const instructions = optionalText(
    raw.instructions,
    'instructions',
    AI_PROJECT_INSTRUCTIONS_MAX,
    issues,
  );
  const writer = persona(raw.writer, 'writer', issues);
  const reader = persona(raw.reader, 'reader', issues);
  const references: AiReferenceInput[] = [];
  const refs = raw.references ?? [];
  if (!Array.isArray(refs)) {
    issues.push({ field: 'references', message: 'A list of { assetId, version? }' });
  } else {
    if (refs.length > AI_PROJECT_MAX_REFERENCES) {
      issues.push({
        field: 'references',
        message: `At most ${AI_PROJECT_MAX_REFERENCES} references (it has ${refs.length})`,
      });
    }
    const seen = new Set<string>();
    refs.slice(0, AI_PROJECT_MAX_REFERENCES).forEach((r: unknown, i) => {
      const field = `references[${i}]`;
      const ref = (typeof r === 'object' && r !== null ? r : {}) as {
        assetId?: unknown;
        version?: unknown;
      };
      if (!text(ref.assetId) || !ref.assetId || ref.assetId.length > 128) {
        issues.push({ field: `${field}.assetId`, message: 'An asset id' });
        return;
      }
      if (seen.has(ref.assetId)) {
        issues.push({ field: `${field}.assetId`, message: 'Each asset is referenced once' });
        return;
      }
      seen.add(ref.assetId);
      if (
        ref.version !== undefined &&
        (typeof ref.version !== 'number' || !Number.isInteger(ref.version) || ref.version < 1)
      ) {
        issues.push({ field: `${field}.version`, message: 'A file version, from 1' });
        return;
      }
      references.push({
        assetId: ref.assetId,
        ...(ref.version !== undefined ? { version: ref.version as number } : {}),
      });
    });
  }
  if (issues.length > 0) throw new ValidationError(issues);
  return { name, description, instructions, writer, reader, references };
}

/** The parts of a project a write can change, as audit rows name them. */
export const AI_PROJECT_PARTS = [
  'name',
  'description',
  'instructions',
  'writer',
  'reader',
  'references',
  'isDefault',
] as const;
export type AiProjectPart = (typeof AI_PROJECT_PARTS)[number];

/** A reference a write added, removed or moved to another file version. */
export interface AiReferenceChange {
  readonly assetId: string;
  readonly from: number | null;
  readonly to: number | null;
}

/**
 * What one write of a project changed, for its audit row: parts and pins named, never the text.
 * `from` is 0 for a create; `to` is 0 for a delete.
 */
export interface AiProjectChange {
  readonly projectId: string;
  readonly from: number;
  readonly to: number;
  readonly changed: readonly AiProjectPart[];
  readonly references?: readonly AiReferenceChange[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The parts of the project that differ, and each reference added, removed or moved. */
export function diffAiProjects(before: AiProject | null, after: AiProject | null): AiProjectChange {
  const id = (after ?? before)?.id ?? '';
  const changed: AiProjectPart[] = [];
  for (const part of AI_PROJECT_PARTS) {
    const a = before ? before[part] : undefined;
    const b = after ? after[part] : undefined;
    if (part === 'isDefault' ? Boolean(a) !== Boolean(b) : !same(a ?? null, b ?? null)) {
      if (part === 'references' && !before?.references.length && !after?.references.length) {
        continue;
      }
      changed.push(part);
    }
  }
  const was = new Map((before?.references ?? []).map((r) => [r.assetId, r.version]));
  const now = new Map((after?.references ?? []).map((r) => [r.assetId, r.version]));
  const references: AiReferenceChange[] = [];
  for (const [assetId, to] of now) {
    const from = was.get(assetId);
    if (from !== to) references.push({ assetId, from: from ?? null, to });
  }
  for (const [assetId, from] of was) {
    if (!now.has(assetId)) references.push({ assetId, from, to: null });
  }
  return {
    projectId: id,
    from: before?.version ?? 0,
    to: after?.version ?? 0,
    changed,
    ...(references.length > 0 ? { references } : {}),
  };
}

/**
 * Where a reference's text stands at its pinned version, derived on read from blob storage and the
 * extraction record, never stored on the project.
 * - `ready`: the text is there.
 * - `pending`: ingest, or an extraction for the pinned version, hasn't finished.
 * - `none`: no text, with why. `too_large` and `unsupported` are final (no rerun changes them);
 *   `media_off`, `budget` and `failed` can be retried; `not_extracted` means nothing has asked
 *   for it yet (the next call that uses the project does).
 */
export type AiReferenceTextState = 'ready' | 'pending' | 'none';
export const AI_REFERENCE_NO_TEXT_REASONS = [
  'too_large',
  'unsupported',
  'media_off',
  'budget',
  'failed',
  'not_extracted',
] as const;
export type AiReferenceNoTextReason = (typeof AI_REFERENCE_NO_TEXT_REASONS)[number];

/** A reason no rerun changes: never re-extracted. */
export const isFinalNoTextReason = (r: AiReferenceNoTextReason): boolean =>
  r === 'too_large' || r === 'unsupported';

/** One reference as a project read reports it. */
export interface AiReferenceStatus extends AiReference {
  readonly text: AiReferenceTextState;
  /** Set when `text` is `none`. */
  readonly reason?: AiReferenceNoTextReason;
  /** The asset has a newer file than the pinned one: moving to it is a project update. */
  readonly updateAvailable: boolean;
  /** The asset is gone (deleted or archived): the reference reaches no prompt. */
  readonly gone?: true;
}

/** Why a call left a reference out, as its answer reports it. */
export type AiReferenceLeftOut = 'forbidden' | 'no_text' | 'pending' | 'gone' | 'budget';

/** One reference as a call that took the project reports it: used, and where, or why not. */
export interface AiReferenceUse {
  readonly assetId: string;
  readonly version: number;
  readonly used: boolean;
  /** Character ranges of the reference's text the call sent, `[start, end)`. */
  readonly ranges?: readonly (readonly [number, number])[];
  readonly reason?: AiReferenceLeftOut;
}

/** What a call that took a project says it used: `project` in its answer. */
export interface AiProjectUse {
  readonly id: string;
  readonly version: number;
  readonly references: readonly AiReferenceUse[];
}

/**
 * Deleting a project an AI action or an agent schedule names (decision 5): refused with 409,
 * listing them, so nothing that stored it falls back to another project unasked.
 */
export class AiProjectInUseError extends DomainError {
  readonly aiActions: readonly string[];
  readonly agentSchedules: readonly string[];
  constructor(id: string, aiActions: readonly string[], agentSchedules: readonly string[]) {
    super(
      'project_in_use',
      `The AI project "${id}" is used by ${aiActions.length} AI action(s) and ` +
        `${agentSchedules.length} agent schedule(s); point them at another project first.`,
      { aiActions, agentSchedules },
    );
    this.aiActions = aiActions;
    this.agentSchedules = agentSchedules;
  }
}
