import {
  AI_PROJECT_INSTRUCTIONS_MAX,
  type AiReferenceNoTextReason,
  normalizeAiGuidance,
} from '@contentworker/domain';
import type { AiProjectInput, AiProjectView } from './management';

/**
 * The AI project editor's form: the project's parts as typed, before the API normalizes them, and
 * its references in order. A reference added here has no status until the project is saved.
 */
export interface ProjectDraft {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly writerName: string;
  readonly writerDescription: string;
  readonly readerName: string;
  readonly readerDescription: string;
  readonly references: readonly DraftReference[];
}

export interface DraftReference {
  readonly assetId: string;
  /** The pinned file version: absent for one added here (the API pins the current file). */
  readonly version?: number;
}

export const EMPTY_DRAFT: ProjectDraft = {
  name: '',
  description: '',
  instructions: '',
  writerName: '',
  writerDescription: '',
  readerName: '',
  readerDescription: '',
  references: [],
};

/** The form for a project as read. */
export function draftOfProject(p: AiProjectView): ProjectDraft {
  return {
    name: p.name,
    description: p.description ?? '',
    instructions: p.instructions ?? '',
    writerName: p.writer?.name ?? '',
    writerDescription: p.writer?.description ?? '',
    readerName: p.reader?.name ?? '',
    readerDescription: p.reader?.description ?? '',
    references: p.references.map((r) => ({ assetId: r.assetId, version: r.version })),
  };
}

const textOrNull = (s: string): string | null => (s.trim() ? s.trim() : null);

/** A persona as sent: both parts blank is no persona. */
const persona = (name: string, description: string) =>
  name.trim() || description.trim() ? { name: name.trim(), description: description.trim() } : null;

/** What a create or an update sends: every part, whole (an update clears what is left out). */
export function inputOf(d: ProjectDraft): AiProjectInput {
  return {
    name: d.name.trim(),
    description: textOrNull(d.description),
    instructions: textOrNull(d.instructions),
    writer: persona(d.writerName, d.writerDescription),
    reader: persona(d.readerName, d.readerDescription),
    references: d.references.map((r) =>
      r.version === undefined ? { assetId: r.assetId } : { assetId: r.assetId, version: r.version },
    ),
  };
}

/** Whether saving the form would change anything: the two compared as the API would keep them. */
export const draftChanged = (base: ProjectDraft, draft: ProjectDraft): boolean =>
  JSON.stringify(inputOf(base)) !== JSON.stringify(inputOf(draft));

/** How long the instructions count, as the API counts them (normalized), and whether too long. */
export function instructionsLength(text: string): {
  readonly chars: number;
  readonly over: boolean;
} {
  const chars = normalizeAiGuidance(text)?.length ?? 0;
  return { chars, over: chars > AI_PROJECT_INSTRUCTIONS_MAX };
}

/** Why a reference has no text, in words, as the API reported it. */
export const NO_TEXT_REASON: Readonly<Record<AiReferenceNoTextReason, string>> = {
  too_large: 'The file is too large to read.',
  unsupported: 'Its text can’t be read from this kind of file.',
  media_off: 'Media AI was off when it was to be read.',
  budget: 'The space’s AI budget was spent when it was to be read.',
  failed: 'Reading its text failed.',
  not_extracted: 'This file will be read by a model the first time the project is used.',
};
