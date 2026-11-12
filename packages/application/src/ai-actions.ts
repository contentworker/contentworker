import {
  type AiProjectUse,
  type EntryFields,
  isValidApiId,
  NotFoundError,
  type Scope,
  ValidationError,
} from '@contentworker/domain';
import type { AIActionDefinition, AIProvider, ModelTier } from '@contentworker/ports';
import { recordAgentRun } from './agent-audit';
import { generateWithBudget } from './ai-budget';
import { assertStoredProjectId, projectDecisions, resolveAiProject } from './ai-projects';
import { UNTRUSTED_CONTENT_GUARD } from './ai-prompt';
import { requireAiCapability } from './ai-settings';
import { assertAiTargetField, type EntryAiOptions, readEntryForAi } from './content-ai';
import type { AppContext } from './context';
import { updateEntry } from './entries';

const VAR_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Extracts the distinct `{{variable}}` names referenced by a template. */
export function templateVariables(template: string): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(VAR_RE)) if (m[1]) out.add(m[1]);
  return [...out];
}

/** Substitutes `{{var}}` tokens from `values`; unknown tokens become empty. */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(VAR_RE, (_, name: string) => values[name] ?? '');
}

export interface CreateAIActionInput {
  readonly name: string;
  readonly description?: string;
  readonly promptTemplate: string;
  readonly targetField?: string;
  readonly tier?: ModelTier;
  /**
   * The AI project its runs take, in this environment (checked: 422 otherwise); absent: the
   * environment's default at run time.
   */
  readonly projectId?: string | null;
}

/** Creates a reusable AI Action. Variables are derived from the template. */
export async function createAIAction(
  ctx: AppContext,
  scope: Scope,
  input: CreateAIActionInput,
): Promise<AIActionDefinition> {
  if (!input.name.trim()) {
    throw new ValidationError([{ field: 'name', message: 'Name is required' }]);
  }
  if (input.targetField && !isValidApiId(input.targetField)) {
    throw new ValidationError([{ field: 'targetField', message: 'Invalid field apiId' }]);
  }
  await assertStoredProjectId(ctx, scope, input.projectId);
  const action: AIActionDefinition = {
    id: ctx.ids.newId(),
    name: input.name.trim(),
    description: input.description,
    promptTemplate: input.promptTemplate,
    variables: templateVariables(input.promptTemplate),
    targetField: input.targetField,
    tier: input.tier ?? 'balanced',
    ...(input.projectId ? { projectId: input.projectId } : {}),
    createdAt: ctx.clock.now().toISOString(),
  };
  await ctx.store.aiActions.create(scope, action);
  return action;
}

export async function listAIActions(ctx: AppContext, scope: Scope): Promise<AIActionDefinition[]> {
  return ctx.store.aiActions.list(scope);
}

export async function getAIAction(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<AIActionDefinition> {
  const action = await ctx.store.aiActions.get(scope, id);
  if (!action) throw new NotFoundError('AIAction', id);
  return action;
}

export async function deleteAIAction(ctx: AppContext, scope: Scope, id: string): Promise<void> {
  await ctx.store.aiActions.delete(scope, id);
}

export interface RunAIActionInput {
  /** Values for the template's `{{variables}}`. */
  readonly variables?: Record<string, string>;
  /** Entry to target: its text fields become `{{field.<apiId>}}` variables, and
   *  with `apply` the output is written into the action's `targetField`. */
  readonly entryId?: string;
  readonly locale?: string;
  readonly apply?: boolean;
  /**
   * The AI project for this run: `null` for none, an id for that one; absent, the action's own
   * (or, when it names none, the environment's default).
   */
  readonly projectId?: string | null;
}

export interface RunAIActionResult {
  readonly actionId: string;
  readonly output: string;
  readonly applied: boolean;
  readonly usage: { inputTokens: number; outputTokens: number };
  /** The AI project the run took, and what of its references it used; null for none. */
  readonly project: AiProjectUse | null;
}

/**
 * Runs a stored AI Action: renders its prompt template from the supplied
 * variables (plus the target entry's fields as `{{field.<apiId>}}`), calls the
 * AI provider, and — with `apply` and a `targetField` — writes the result back
 * through the same validators a human edit uses. Every run hits the cost ledger.
 * The entry is read as `opts.principal` may read it (`readEntryForAi`): a field its role denies
 * is never a variable, so the model can't echo it back.
 */
export async function runAIAction(
  ctx: AppContext,
  ai: AIProvider,
  scope: Scope,
  id: string,
  input: RunAIActionInput,
  opts: EntryAiOptions,
): Promise<RunAIActionResult> {
  const policy = await requireAiCapability(ctx, scope, 'field-assist');
  const action = await getAIAction(ctx, scope, id);

  const values: Record<string, string> = { ...input.variables };
  let entryFields: EntryFields | undefined;
  let unwritable: readonly string[] = [];
  let unreadable: readonly string[] = [];
  let locale = input.locale;
  if (input.entryId) {
    const apply = Boolean(input.apply && action.targetField);
    const read = await readEntryForAi(ctx, scope, input.entryId, { ...opts, apply });
    if (apply && action.targetField) {
      assertAiTargetField(opts.principal, read.contentTypeApiId, action.targetField, true);
    }
    const fields = read.fields;
    entryFields = fields;
    unwritable = read.unwritable;
    unreadable = read.unreadable;
    const config = await ctx.store.spaces.getConfig(scope);
    locale = locale ?? config?.defaultLocale;
    if (locale) {
      for (const [apiId, localized] of Object.entries(fields)) {
        const value = localized[locale];
        if (typeof value === 'string') values[`field.${apiId}`] = value;
      }
    }
  }

  const prompt = renderTemplate(action.promptTemplate, values);
  // The run's own choice, else the action's; a stored project that is gone refuses the run (404,
  // recorded), never falls back to the default.
  const projectId = input.projectId !== undefined ? input.projectId : action.projectId;
  let project: Awaited<ReturnType<typeof resolveAiProject>>;
  try {
    project = await resolveAiProject(ctx, scope, opts.principal, {
      capability: 'field-assist',
      ...(projectId !== undefined ? { projectId } : {}),
      task: { terms: `${action.name} ${prompt.slice(0, 2_000)}` },
    });
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
    await recordAgentRun(ctx, scope, {
      workflow: `ai-action:${action.name}`,
      entryId: input.entryId ?? '',
      status: 'refused',
      decisions: [`Refused AI Action "${action.name}": its AI project ${projectId} is gone`],
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    throw err;
  }
  const system = policy.system(
    project.system(
      `You are running the AI Action "${action.name}". Follow the instructions and return only the requested output. ${UNTRUSTED_CONTENT_GUARD}`,
    ),
  );
  // An action names its own tier when it is created: that choice stands over the space's.
  const tier = policy.tier('balanced', action.tier);
  const placed = project.call({ system, prompt, maxTokens: 2048, tier }, ai);
  const result = await generateWithBudget(ctx, ai, scope, {
    system,
    prompt: placed.prompt,
    tier,
    maxTokens: 2048,
    ...placed.request,
  });
  const output = (result.text ?? '').trim();

  let applied = false;
  if (input.apply && action.targetField && input.entryId && entryFields && locale) {
    const merged: EntryFields = { ...entryFields };
    merged[action.targetField] = { ...merged[action.targetField], [locale]: output };
    await updateEntry(ctx, scope, input.entryId, merged, { unwritable, unreadable });
    applied = true;
  }

  await recordAgentRun(ctx, scope, {
    workflow: `ai-action:${action.name}`,
    entryId: input.entryId ?? '',
    status: 'completed',
    decisions: [`Ran AI Action "${action.name}"`, ...projectDecisions(placed.use)],
    usage: result.usage,
  });

  return { actionId: action.id, output, applied, usage: result.usage, project: placed.use };
}
