import type { AuditVia, ContentType, EntryChange } from '@contentworker/domain';
import { type ActorDirectory, actorLabel } from './authorship';
import type { AuditEntry } from './management';

/**
 * An entry's activity in words. An audit row records its action as the route it came through
 * (`PUT /spaces/:space/environments/:env/entries/:id`), the tool (`MCP entries_update`) or the
 * use-case's own name (`workflow.run.cancelled`); a person reads "Saved". What isn't named here
 * keeps its action as recorded, which is still true, just in the API's words.
 */

const SCOPED = '/spaces/:space/environments/:env';

/** By route (method and path past the environment), by tool, and by use-case action. */
const WORDS: Readonly<Record<string, string>> = {
  'POST /entries': 'Created',
  'PUT /entries/:id': 'Saved',
  'PATCH /entries/:id': 'Saved',
  'DELETE /entries/:id': 'Moved to the trash',
  'POST /entries/:id/restore': 'Restored from the trash',
  'DELETE /entries/:id/permanent': 'Deleted for good',
  'POST /entries/:id/published': 'Published',
  'DELETE /entries/:id/published': 'Unpublished',
  'POST /entries/:id/versions/:version/restore': 'Restored a version',
  'POST /entries/:id/duplicate': 'Duplicated',
  'PATCH /entries/:id/seo': 'Changed SEO',
  'PATCH /entries/:id/blocks': 'Changed blocks',
  'PUT /entries/:id/metadata': 'Changed tags',
  'POST /entries/:id/apply-tags': 'Applied suggested tags',
  'POST /entries/:id/translate': 'Translated',
  'POST /entries/:id/summarize': 'Summarized',
  'POST /entries/:id/autofill': 'Filled a field',
  'POST /entries/:id/comments': 'Commented',
  'POST /entries/:id/tasks': 'Added a task',
  'POST /entries/:id/workflow-runs': 'Started a workflow',
  'POST /agent-reviews/:id/approve': 'Approved an agent’s proposal',
  'POST /workflow-runs/:id/cancel': 'Cancelled a workflow run',
  entries_create: 'Created',
  entries_update: 'Saved',
  entries_trash: 'Moved to the trash',
  entries_restore: 'Restored from the trash',
  entries_purge: 'Deleted for good',
  entries_publish: 'Published',
  entries_unpublish: 'Unpublished',
  entries_restore_version: 'Restored a version',
  entries_duplicate: 'Duplicated',
  entries_set_seo: 'Changed SEO',
  entry_blocks_patch: 'Changed blocks',
  entries_set_metadata: 'Changed tags',
  entry_apply_tags: 'Applied suggested tags',
  entry_translate: 'Translated',
  entry_summarize: 'Summarized',
  entry_autofill_field: 'Filled a field',
  comments_add: 'Commented',
  agent_review_approve: 'Approved an agent’s proposal',
  workflow_run_cancel: 'Cancelled a workflow run',
  'workflow.run.cancelled': 'Cancelled a workflow run',
  'workflow.task.approved': 'Approved a workflow step',
  'workflow.task.rejected': 'Rejected a workflow step',
};

/**
 * How an action came in. `api`: a REST call (the admin's own, when Coworker is off, or an API
 * client's). `mcp`: an MCP client's tool call. A tool call Coworker ran says who started it
 * (`AuditVia`): Coworker's own proposal (`assistant`), or the person's button in the editor
 * (`editor`) or on another admin page (`admin`), which runs through Coworker by design.
 */
export type ActivityVia = 'api' | 'mcp' | AuditVia;

export interface ActivityAction {
  /** What happened, in words; `null` when only the recorded action can say. */
  readonly words: string | null;
  readonly via: ActivityVia;
}

/** A row's action as a person reads it, for the entry `entryId` whose activity this is. */
export function activityAction(row: AuditEntry, entryId: string): ActivityAction {
  const tool = row.action.startsWith('MCP ');
  const key = tool
    ? row.action.slice('MCP '.length)
    : row.action.replace(` ${SCOPED}/`, ' /').replace(/^(\w+) \/spaces\/:space\//, '$1 /');
  const words = WORDS[key] ?? null;
  // A duplicate's row targets its source: on the copy's own activity, it is where it came from.
  const copied =
    (words === 'Duplicated' && row.targetType === 'entry' && row.targetId !== entryId) || false;
  // Only the assistant's in-process calls record `via` (the MCP server takes it from no client).
  const via: ActivityVia = tool ? (row.detail?.via ?? 'mcp') : 'api';
  return { words: copied ? 'Created as a copy' : words, via };
}

/**
 * Who did it, and how, for a row's byline. A person's own button reads as theirs wherever it ran
 * ("You · in the editor"); what Coworker proposed reads as Coworker's, with who confirmed it, so
 * nothing it did passes for the person's own edit, nor the reverse.
 */
export function activityBy(actor: string, via: ActivityVia, directory?: ActorDirectory): string {
  switch (via) {
    case 'assistant':
      return `Coworker, confirmed by ${actorLabel(actor, directory, 'inSentence')}`;
    case 'editor':
      return `${actorLabel(actor, directory)} · in the editor`;
    case 'admin':
      return `${actorLabel(actor, directory)} · in the admin`;
    case 'mcp':
      return `${actorLabel(actor, directory)} · through MCP`;
    default:
      return actorLabel(actor, directory);
  }
}

/**
 * A changed path in the model's words: its field by name (`fields.hero.alt` is "Hero › alt"), a
 * list's element marker dropped. A field the type no longer has keeps its api id.
 */
export function pathLabel(path: string, contentType: ContentType | undefined): string {
  const [head = '', ...rest] = path
    .replace(/^fields\./, '')
    .replace(/\[\]/g, '')
    .split('.');
  const name = contentType?.fields.find((f) => f.apiId === head)?.name ?? head;
  return [name, ...rest].join(' › ');
}

/**
 * What a row says it changed in this entry. `unrecorded`: the row has no `detail` (written before
 * changes were recorded, or an action that saves nothing), which says nothing either way.
 * `unlisted`: it has detail, but this entry's part didn't fit. Otherwise the entry's change.
 */
export type ActivityChange =
  | { readonly kind: 'unrecorded' }
  | { readonly kind: 'unlisted' }
  | {
      readonly kind: 'change';
      readonly change: EntryChange;
      /** How many other entries the same action saved. */
      readonly others: number;
      readonly truncated: boolean;
    };

export function activityChange(row: AuditEntry, entryId: string): ActivityChange {
  // A detail that only says who started it (a publish through Coworker) says nothing of changes.
  if (!row.detail || isOnlyVia(row.detail)) return { kind: 'unrecorded' };
  const change = row.detail.entries.find((e) => e.entryId === entryId);
  if (!change) return { kind: 'unlisted' };
  return {
    kind: 'change',
    change,
    others: row.detail.entries.length - 1,
    truncated: row.detail.truncated === true,
  };
}

const isOnlyVia = (detail: NonNullable<AuditEntry['detail']>) =>
  detail.entries.length === 0 && Object.keys(detail).every((k) => k === 'entries' || k === 'via');
