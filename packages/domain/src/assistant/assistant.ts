/**
 * The assistant, as data both its sides read: the agent (`@contentworker/http/assistant`, hosted
 * by the engine) and the admin's panel (`apps/web`). Its tools are MCP tools, by their MCP names,
 * run in-process under the person's own principal, so the assistant can never do what an MCP
 * client can't. This file only says which of them the assistant offers and how each is treated.
 */

/** Where a turn works: the space, environment and locale the admin's header has chosen. */
export interface AssistantScope {
  readonly spaceId: string;
  readonly environmentId: string;
  readonly locale?: string;
}

/**
 * The scope of a turn with no space to work in: a deployment admin setting up a space, on a
 * deployment that has none yet (setup's last step, or the panel before the first space exists).
 * Only `SETUP_TOOLS` run in it, as the person's deployment-wide principal; nothing else does.
 */
export const SETUP_SCOPE: AssistantScope = Object.freeze({ spaceId: '*', environmentId: '*' });

export const isSetupScope = (scope: Pick<AssistantScope, 'spaceId' | 'environmentId'>) =>
  scope.spaceId === SETUP_SCOPE.spaceId && scope.environmentId === SETUP_SCOPE.environmentId;

/** What "this" means on the page the person is on (the panel's context chip). */
export type AssistantPage =
  | { readonly kind: 'everything' }
  | { readonly kind: 'content-type'; readonly contentType: string; readonly label: string }
  | {
      readonly kind: 'entry';
      readonly entryId: string;
      readonly contentType: string;
      readonly label: string;
    };

/** Sent with every message and every page edit: the scope, and the page in front. */
export interface AssistantContext {
  readonly scope: AssistantScope;
  readonly page: AssistantPage;
}

export interface AssistantToolInfo {
  /** What the tool does, for a confirm card's heading: "Publish this entry". */
  readonly title: string;
  /** What it did, for its line in the conversation: "Published". */
  readonly done: string;
  /** Changes something. A write the model proposes always waits for the person's confirm. */
  readonly write: boolean;
  /**
   * An action: when a page makes it (`act`), it too stops at a confirm card in the panel. A write
   * without it, made from a page, runs at once and leaves a line.
   */
  readonly confirm: boolean;
}

const read = (title: string): AssistantToolInfo => ({
  title,
  done: title,
  write: false,
  confirm: false,
});
const edit = (title: string, done: string): AssistantToolInfo => ({
  title,
  done,
  write: true,
  confirm: false,
});
const action = (title: string, done: string): AssistantToolInfo => ({
  title,
  done,
  write: true,
  confirm: true,
});

/**
 * The MCP tools the assistant offers, by MCP name. Any other MCP tool stays MCP's alone. Order is
 * the order the model is shown them in.
 */
export const ASSISTANT_TOOLS = {
  docs_search: read('Search the documentation'),
  docs_read: read('Read the documentation'),
  model_list_content_types: read('List content types'),
  model_get_content_type: read('Read a content type'),
  entries_query: read('Find entries'),
  entries_get: read('Read an entry'),
  entries_suggest: read('Suggest entries'),
  content_search: read('Search content'),
  entries_list_versions: read('List an entry’s versions'),
  entries_diff_versions: read('Compare versions'),
  entries_list_trashed: read('List trashed entries'),
  releases_list: read('List releases'),
  releases_get: read('Read a release'),
  comments_list: read('Read comments'),
  tasks_list: read('List tasks'),
  taxonomy_list_tags: read('List tags'),
  assets_list: read('List assets'),
  workflow_task_list: read('List review tasks'),

  entries_create: edit('Create an entry', 'Created'),
  entries_update: edit('Save a draft', 'Saved a draft'),
  entries_duplicate: edit('Duplicate an entry', 'Duplicated'),
  entries_restore: edit('Restore from trash', 'Restored from trash'),
  entries_set_metadata: edit('Set entry details', 'Set details'),
  entry_apply_tags: edit('Tag an entry', 'Tagged'),
  comments_add: edit('Comment', 'Commented'),
  releases_add_entry: edit('Add to a release', 'Added to a release'),

  entries_publish: action('Publish this entry', 'Published'),
  entries_unpublish: action('Unpublish this entry', 'Unpublished'),
  entries_trash: action('Move this entry to the trash', 'Moved to the trash'),
  entries_purge: action('Delete this entry for good', 'Deleted for good'),
  entries_restore_version: action('Restore this version', 'Restored a version'),
  entries_bulk_action: action('Change these entries', 'Changed entries'),
  bulk_job_start: action('Run a job on these entries', 'Started a job'),
  schedule_action: action('Schedule this change', 'Scheduled'),
  releases_publish: action('Publish this release', 'Published a release'),

  // Offered only in `SETUP_SCOPE`, never in a space.
  space_starters_list: read('List space starters'),
  space_create: action('Create this space', 'Created a space'),
} as const satisfies Record<string, AssistantToolInfo>;

export type AssistantTool = keyof typeof ASSISTANT_TOOLS;

export const isAssistantTool = (name: string): name is AssistantTool =>
  Object.hasOwn(ASSISTANT_TOOLS, name);

/** The tools of a turn with no space (`SETUP_SCOPE`): finding the starters and creating a space. */
export const SETUP_TOOLS: ReadonlySet<AssistantTool> = new Set<AssistantTool>([
  'space_starters_list',
  'space_create',
]);

/**
 * Whether `name` may run in `scope`: in setup, the setup tools and nothing else; in a space,
 * everything but them. Every call the assistant makes (a model's, a page's) is held to this.
 */
export const offeredIn = (
  scope: Pick<AssistantScope, 'spaceId' | 'environmentId'>,
  name: AssistantTool,
) => isSetupScope(scope) === SETUP_TOOLS.has(name);

/**
 * The agent's name in the Agents SDK's routing (`/agents/<agent>/<instance>`): the kebab-case of
 * the `ASSISTANT_AGENT` binding. The instance is the person's id (`usr_…`, or `local` in open
 * local development); only that person reaches it.
 */
export const ASSISTANT_AGENT = 'assistant-agent';

/** The path the panel's socket takes through the web Worker and the api to the engine. */
export const assistantPath = (personId: string) =>
  `/agents/${ASSISTANT_AGENT}/${encodeURIComponent(personId)}`;

/** A tool call a page made (`act`), never one the model proposed: its id starts with this. */
export const DIRECT_CALL_PREFIX = 'direct_';
