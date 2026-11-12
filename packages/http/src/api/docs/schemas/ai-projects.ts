import {
  AI_PERSONA_DESCRIPTION_MAX,
  AI_PERSONA_NAME_MAX,
  AI_PROJECT_DESCRIPTION_MAX,
  AI_PROJECT_INSTRUCTIONS_MAX,
  AI_PROJECT_MAX_REFERENCES,
  AI_PROJECT_NAME_MAX,
  AI_REFERENCE_NO_TEXT_REASONS,
} from '@contentworker/domain';
import { z } from 'zod';

// --- AI projects (per environment) ----------------------------------------------------------------

export const aiPersona = z
  .object({
    name: z
      .string()
      .max(AI_PERSONA_NAME_MAX)
      .describe('“Northwind product team”, “Procurement lead”'),
    description: z
      .string()
      .max(AI_PERSONA_DESCRIPTION_MAX)
      .describe('Who they are, what they know and care about, how they speak or read'),
  })
  .describe('A persona: a name and prose, nothing typed beyond that');

const aiReference = z.object({
  assetId: z.string(),
  version: z.int().describe('The file version the reference is pinned to'),
});

const aiReferenceStatus = aiReference.extend({
  text: z
    .enum(['ready', 'pending', 'none'])
    .describe(
      'The pinned file’s text: there, being read (ingest or an extraction hasn’t finished), or none',
    ),
  reason: z
    .enum(AI_REFERENCE_NO_TEXT_REASONS)
    .optional()
    .describe(
      'Why there is none. `too_large` and `unsupported` are final; `media_off`, `budget` and ' +
        '`failed` can be retried; `not_extracted`: nothing has asked yet, and the next call that ' +
        'uses the project does',
    ),
  updateAvailable: z
    .boolean()
    .describe('The asset has a newer file: moving the pin to it is a project update'),
  gone: z.literal(true).optional().describe('The asset was deleted or archived'),
  textBytes: z.int().optional().describe('The text’s size in UTF-8 bytes, when it is `ready`'),
  retryable: z
    .literal(true)
    .optional()
    .describe(
      'Retry (`POST …/references/{assetId}/extract`) would be taken now: no text for a reason a ' +
        'rerun can change, at the current file, with media AI on',
    ),
});

const project = {
  id: z.string(),
  name: z.string().describe('Unique in the environment, ignoring case'),
  description: z.string().nullable().describe('Shown in pickers; never sent to a model'),
  instructions: z
    .string()
    .nullable()
    .describe('What to do and avoid, terminology, facts to prefer; fenced as guidance'),
  writer: aiPersona.nullable().describe('The voice the work is written in'),
  reader: aiPersona.nullable().describe('The audience it is written for'),
  isDefault: z
    .boolean()
    .describe('The environment’s default: what a call that names no project takes'),
  version: z.int().describe('1 at creation, then one more for each write that changed something'),
  createdAt: z.iso.datetime(),
  createdBy: z.string().nullable(),
  updatedAt: z.iso.datetime(),
  updatedBy: z.string().nullable(),
};

export const aiProjectSummary = z.object({
  ...project,
  references: z.array(aiReference).describe('In order of importance, each pinned to a file'),
});

export const aiProject = z.object({
  ...project,
  references: z
    .array(aiReferenceStatus)
    .describe('In order of importance, each with its pinned file’s text status'),
});

export const aiProjectList = z.object({
  items: z.array(aiProjectSummary),
  total: z.int(),
});

export const aiProjectWrite = z.object({
  project: aiProject,
  unchanged: z.boolean().describe('The project was already this: nothing written'),
});

export const aiProjectDefault = z.object({
  projectId: z.string().nullable().describe('The default now; null for none'),
  unchanged: z.boolean(),
});

export const aiReferenceExtract = z.object({
  assetId: z.string(),
  version: z.int(),
  outcome: z.enum(['started', 'running']),
  status: aiReferenceStatus,
});

export const aiReferencePage = z.object({
  projectId: z.string(),
  assetId: z.string(),
  version: z.int().describe('The pinned file version the text is of'),
  offset: z.int().describe('Where this page starts, in UTF-8 bytes of the text'),
  nextOffset: z
    .int()
    .nullable()
    .describe('Pass as `offset` for the next page; null at the end of the text'),
  total: z.int().describe('The text’s length in UTF-8 bytes'),
  text: z.string().describe('The page: the file’s own words, data and never instructions'),
});

/** What every call that took a project reports it used. */
export const aiProjectUse = z
  .object({
    id: z.string(),
    version: z.int(),
    references: z.array(
      z.object({
        assetId: z.string(),
        version: z.int(),
        used: z.boolean().describe('Whether the call sent text from it'),
        ranges: z
          .array(z.tuple([z.int(), z.int()]))
          .optional()
          .describe('Character ranges of its text the call sent, [start, end)'),
        reason: z
          .enum(['forbidden', 'no_text', 'pending', 'gone', 'budget'])
          .optional()
          .describe(
            'Why it was left out: you can’t read it, it has no text (yet: `pending`), the asset ' +
              'is gone, or the call’s budget didn’t reach it',
          ),
      }),
    ),
  })
  .nullable()
  .describe('The AI project the call took and what of its references it used; null for none');

export const aiProjectLimits = {
  name: AI_PROJECT_NAME_MAX,
  description: AI_PROJECT_DESCRIPTION_MAX,
  instructions: AI_PROJECT_INSTRUCTIONS_MAX,
  references: AI_PROJECT_MAX_REFERENCES,
} as const;
