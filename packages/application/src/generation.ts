import {
  assertEntryFieldsValid,
  type ContentType,
  type EntryFields,
  type FieldDefinition,
  NotFoundError,
  type Scope,
  ValidationError,
} from '@contentworker/domain';
import type { AIProvider, ModelTier } from '@contentworker/ports';
import { recordAgentRun } from './agent-audit';
import { generateWithBudget } from './ai-budget';
import type { AppContext } from './context';

/** Field types we ask the model to generate for a draft (scalars only). */
const DRAFTABLE = new Set(['Symbol', 'Text', 'Integer', 'Number', 'Boolean', 'Date']);

interface JsonSchema {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  additionalProperties: false;
}

/** Builds a strict JSON Schema for the draftable fields of a content type. */
function schemaForContentType(ct: ContentType): { schema: JsonSchema; fields: FieldDefinition[] } {
  const fields = ct.fields.filter((f) => DRAFTABLE.has(f.type));
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const f of fields) {
    properties[f.apiId] = jsonTypeFor(f);
    // Strict structured outputs require every property in `required`.
    required.push(f.apiId);
  }
  return {
    schema: { type: 'object', properties, required, additionalProperties: false },
    fields,
  };
}

function jsonTypeFor(field: FieldDefinition): Record<string, unknown> {
  const base: Record<string, unknown> = { description: field.name, ...constraintsFor(field) };
  switch (field.type) {
    case 'Integer':
      return { ...base, type: 'integer' };
    case 'Number':
      return { ...base, type: 'number' };
    case 'Boolean':
      return { ...base, type: 'boolean' };
    case 'Date':
      return { ...base, type: 'string', description: `${field.name} (ISO-8601 date)` };
    default:
      return { ...base, type: 'string' };
  }
}

/**
 * The field's validations as JSON Schema, so the model is told the rules the draft is then held
 * to (a range, allowed values, a length, a pattern) instead of learning them from a refusal.
 */
function constraintsFor(field: FieldDefinition): Record<string, unknown> {
  const v = field.validations;
  if (!v) return {};
  const numeric = field.type === 'Integer' || field.type === 'Number';
  const text = field.type === 'Symbol' || field.type === 'Text';
  return {
    ...(v.in?.length ? { enum: [...v.in] } : {}),
    ...(numeric && v.range?.min !== undefined ? { minimum: v.range.min } : {}),
    ...(numeric && v.range?.max !== undefined ? { maximum: v.range.max } : {}),
    ...(text && v.size?.min !== undefined ? { minLength: v.size.min } : {}),
    ...(text && v.size?.max !== undefined ? { maxLength: v.size.max } : {}),
    ...(text && v.regexp ? { pattern: v.regexp.pattern } : {}),
  };
}

export interface DraftEntryInput {
  readonly contentTypeApiId: string;
  /** Natural-language instructions describing what to generate. */
  readonly prompt: string;
  readonly tier?: ModelTier;
}

export interface DraftResult {
  readonly contentTypeApiId: string;
  readonly fields: EntryFields;
  readonly usage: { inputTokens: number; outputTokens: number };
}

/**
 * Generates draft field values for a content type using the AI provider, then
 * runs them through the SAME validators a human write uses. An agent therefore
 * can never produce an entry a person couldn't — the core rule made concrete.
 */
export async function draftEntry(
  ctx: AppContext,
  ai: AIProvider,
  scope: Scope,
  input: DraftEntryInput,
): Promise<DraftResult> {
  const ct = await ctx.store.contentTypes.get(scope, input.contentTypeApiId);
  if (!ct) throw new NotFoundError('ContentType', input.contentTypeApiId);
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);

  const { schema } = schemaForContentType(ct);
  const system =
    'You generate structured content entries. Return only values that satisfy the provided ' +
    "JSON schema. Respect each field's meaning and keep text concise and natural.";
  const prompt = `Content type: ${ct.name} (${ct.apiId}).\nInstructions: ${input.prompt}\nProduce values for every field in the schema.`;

  const result = await generateWithBudget(ctx, ai, scope, {
    system,
    prompt,
    tier: input.tier ?? 'balanced',
    maxTokens: 4096,
    outputSchema: schema as unknown as Record<string, unknown>,
  });

  if (!result.object || typeof result.object !== 'object') {
    throw new ValidationError([{ field: '', message: 'Model did not return structured output' }]);
  }

  // Wrap each generated scalar into the localized shape under the default locale.
  const generated = result.object as Record<string, unknown>;
  const fields: EntryFields = {};
  for (const [apiId, value] of Object.entries(generated)) {
    if (value !== null && value !== undefined) {
      fields[apiId] = { [config.defaultLocale]: value };
    }
  }

  // Validation gate — identical to the human write path.
  assertEntryFieldsValid(ct, fields, {
    defaultLocale: config.defaultLocale,
    locales: config.locales,
  });

  // Audit the generation so its token cost shows in the dashboard ledger. Both
  // the HTTP route and the MCP tool reach this, so all generations are logged.
  await recordAgentRun(ctx, scope, {
    workflow: 'generate',
    entryId: '',
    status: 'completed',
    decisions: [`Drafted ${ct.name} from a prompt`],
    usage: result.usage,
  });

  return { contentTypeApiId: ct.apiId, fields, usage: result.usage };
}

export interface CanvasInput {
  readonly contentTypeApiId: string;
  /** Free-form prose to map into the content type's structured fields. */
  readonly prose: string;
  readonly tier?: ModelTier;
}

/**
 * Maps free-form prose into a structured entry ("Canvas" authoring): the author
 * writes naturally and the model extracts/structures the text into the content
 * type's fields. Distinct from `draftEntry` (which generates from instructions) —
 * here the prose IS the source content. Same schema constraint, same validation
 * gate, and same audit ledger, so a mapped entry is one a human could have typed.
 */
export async function canvasToEntry(
  ctx: AppContext,
  ai: AIProvider,
  scope: Scope,
  input: CanvasInput,
): Promise<DraftResult> {
  if (!input.prose.trim()) {
    throw new ValidationError([{ field: 'prose', message: 'Prose is required' }]);
  }
  const ct = await ctx.store.contentTypes.get(scope, input.contentTypeApiId);
  if (!ct) throw new NotFoundError('ContentType', input.contentTypeApiId);
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);

  const { schema } = schemaForContentType(ct);
  const system =
    'You map free-form prose into a structured content entry. Extract the relevant ' +
    'information from the prose and place it into the fields defined by the JSON schema, ' +
    "preserving the author's wording where it maps directly to a field. Infer concise " +
    'values for fields the prose implies but does not state outright. Return only values ' +
    'that satisfy the schema.';
  const prompt = `Content type: ${ct.name} (${ct.apiId}).\nProse:\n${input.prose}\nProduce values for every field in the schema.`;

  const result = await generateWithBudget(ctx, ai, scope, {
    system,
    prompt,
    tier: input.tier ?? 'balanced',
    maxTokens: 4096,
    outputSchema: schema as unknown as Record<string, unknown>,
  });

  if (!result.object || typeof result.object !== 'object') {
    throw new ValidationError([{ field: '', message: 'Model did not return structured output' }]);
  }

  const mapped = result.object as Record<string, unknown>;
  const fields: EntryFields = {};
  for (const [apiId, value] of Object.entries(mapped)) {
    if (value !== null && value !== undefined) {
      fields[apiId] = { [config.defaultLocale]: value };
    }
  }

  assertEntryFieldsValid(ct, fields, {
    defaultLocale: config.defaultLocale,
    locales: config.locales,
  });

  await recordAgentRun(ctx, scope, {
    workflow: 'generate',
    entryId: '',
    status: 'completed',
    decisions: [`Mapped prose into ${ct.name} via Canvas`],
    usage: result.usage,
  });

  return { contentTypeApiId: ct.apiId, fields, usage: result.usage };
}
