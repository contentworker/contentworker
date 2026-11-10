import {
  assertEntryFieldsValid,
  blocksFieldSchema,
  blockVariants,
  type ContentType,
  draftableFieldSchema,
  type EntryFields,
  NotFoundError,
  resolveAssetRequests,
  type Scope,
  type UnresolvedImage,
  ValidationError,
  withoutClosedFields,
} from '@contentworker/domain';
import type { AIProvider, ModelTier } from '@contentworker/ports';
import { recordAgentRun } from './agent-audit';
import { generateWithBudget } from './ai-budget';
import { describeFieldForModel, UNTRUSTED_CONTENT_GUARD, wrapUntrusted } from './ai-prompt';
import type { AssetSearchDeps } from './asset-search';
import { assertBlockConfigAllows } from './block-config';
import type { AppContext } from './context';
import {
  findRequestedImages,
  LAYOUT_MAX_TOKENS,
  type LayoutRules,
  layoutSchemaOptions,
  loadLayoutRules,
} from './layout-generation';

/** Output tokens a draft of scalars takes; one with a blocks field takes a layout's. */
const DRAFT_MAX_TOKENS = 4096;

interface JsonSchema {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  additionalProperties: false;
}

/**
 * Builds a strict JSON Schema for the fields of a content type a model fills: its scalars
 * (`draftableFieldSchema`) and its top-level blocks fields (`blocksFieldSchema`, under the rules
 * in force; a field whose top level the rules lock is left out). `drafted` names them all; every
 * other field is left for an editor, and the draft isn't judged required on it.
 */
function schemaForContentType(
  ct: ContentType,
  layout: LayoutRules | null,
): { schema: JsonSchema; drafted: ReadonlySet<string>; blocks: ReadonlySet<string> } {
  const properties: Record<string, Record<string, unknown>> = {};
  const blocks = new Set<string>();
  for (const f of ct.fields) {
    // The field's guidance rides in the description, so a draft is written to the same brief an
    // editor reads under the input.
    const scalar = draftableFieldSchema(f, describeFieldForModel);
    if (scalar) {
      properties[f.apiId] = scalar;
      continue;
    }
    if (!blockVariants(f)) continue;
    const tree = blocksFieldSchema(ct, f.apiId, layoutSchemaOptions(layout));
    if (!tree) continue;
    properties[f.apiId] = tree;
    blocks.add(f.apiId);
  }
  // Strict structured outputs require every property in `required`.
  const required = Object.keys(properties);
  return {
    schema: { type: 'object', properties, required, additionalProperties: false },
    drafted: new Set(required),
    blocks,
  };
}

/**
 * A model's values as entry fields under the default locale, without a value for any field the
 * type's rules hide or disable given the rest of the draft: the schema asks for every field (strict
 * structured output requires it), so the rules are applied to the answer.
 */
function draftedFields(
  ct: ContentType,
  generated: Record<string, unknown>,
  defaultLocale: string,
): EntryFields {
  const fields: EntryFields = {};
  for (const [apiId, value] of Object.entries(generated)) {
    if (value !== null && value !== undefined) fields[apiId] = { [defaultLocale]: value };
  }
  return withoutClosedFields(ct.fields, fields, defaultLocale);
}

export interface DraftEntryInput {
  readonly contentTypeApiId: string;
  /** Natural-language instructions describing what to generate. */
  readonly prompt: string;
  readonly tier?: ModelTier;
}

export interface DraftOptions {
  /** The library search a blocks field's images are found with; without it none is found. */
  readonly assets?: AssetSearchDeps;
}

export interface DraftResult {
  readonly contentTypeApiId: string;
  readonly fields: EntryFields;
  /** Image requests in the drafted blocks the library had no answer for: left empty. */
  readonly unresolvedImages: readonly UnresolvedImage[];
  readonly usage: { inputTokens: number; outputTokens: number };
}

/** What both drafting use-cases share: the system prompt and the prompt, and how it's logged. */
interface DraftCall {
  readonly system: string;
  readonly prompt: (ct: ContentType) => string;
  readonly decision: (ct: ContentType) => string;
}

/**
 * Asks the model for a content type's fields and judges the answer as a create would: the same
 * validators a human write uses (`assertEntryFieldsValid`, not judged required on the fields a
 * draft leaves for an editor) and, for its blocks, the block config. Images the blocks ask for are
 * found in the library first. Nothing is saved; the run is recorded so its cost shows.
 */
async function draft(
  ctx: AppContext,
  ai: AIProvider,
  scope: Scope,
  input: { readonly contentTypeApiId: string; readonly tier?: ModelTier },
  call: DraftCall,
  options: DraftOptions,
): Promise<DraftResult> {
  const ct = await ctx.store.contentTypes.get(scope, input.contentTypeApiId);
  if (!ct) throw new NotFoundError('ContentType', input.contentTypeApiId);
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  const layout = await loadLayoutRules(ctx, scope, ct);

  const { schema, drafted, blocks } = schemaForContentType(ct, layout);
  const result = await generateWithBudget(ctx, ai, scope, {
    system: call.system,
    prompt: call.prompt(ct),
    tier: input.tier ?? 'balanced',
    maxTokens: blocks.size > 0 ? LAYOUT_MAX_TOKENS : DRAFT_MAX_TOKENS,
    outputSchema: schema as unknown as Record<string, unknown>,
  });

  if (!result.object || typeof result.object !== 'object') {
    throw new ValidationError([{ field: '', message: 'Model did not return structured output' }]);
  }

  // A blocks field's image requests become links to the library's best match, or are left out.
  const answer = { ...(result.object as Record<string, unknown>) };
  const unresolvedImages: UnresolvedImage[] = [];
  for (const apiId of blocks) {
    if (!Array.isArray(answer[apiId])) continue;
    const found = await findRequestedImages(ctx, options.assets, scope, answer[apiId]);
    const resolved = resolveAssetRequests(answer[apiId], found, apiId);
    answer[apiId] = resolved.value;
    unresolvedImages.push(...resolved.unresolved);
  }

  // Wrap each generated value into the localized shape under the default locale.
  const fields = draftedFields(ct, answer, config.defaultLocale);

  // Validation gate — identical to the human write path, but for the fields a draft can't fill.
  const unfilled = new Set(ct.fields.map((f) => f.apiId).filter((id) => !drafted.has(id)));
  assertEntryFieldsValid(ct, fields, {
    defaultLocale: config.defaultLocale,
    locales: config.locales,
    unfilled,
  });
  // Blocks are placed as a create places them: under the block config's narrowing.
  if (blocks.size > 0) {
    await assertBlockConfigAllows(ctx, scope, ct, undefined, fields, config.locales);
  }

  // Audit the generation so its token cost shows in the dashboard ledger. Both
  // the HTTP route and the MCP tool reach this, so all generations are logged.
  await recordAgentRun(ctx, scope, {
    workflow: 'generate',
    entryId: '',
    status: 'completed',
    decisions: [call.decision(ct)],
    usage: result.usage,
  });

  return { contentTypeApiId: ct.apiId, fields, unresolvedImages, usage: result.usage };
}

/** How the system prompt asks for blocks and images, when the schema has a blocks field. */
const BLOCKS_GUIDANCE =
  'A blocks field is a list of blocks, each naming its kind in _type and filling its fields and ' +
  'slots; use as few as the request needs. For an image, describe the picture wanted in ' +
  '$asset.query (a few plain words); never invent ids or URLs.';

/**
 * Generates draft field values for a content type using the AI provider, then
 * runs them through the SAME validators a human write uses. An agent therefore
 * can never produce an entry a person couldn't — the core rule made concrete.
 * Scalars and top-level blocks fields are drafted; the rest is left for an editor.
 */
export async function draftEntry(
  ctx: AppContext,
  ai: AIProvider,
  scope: Scope,
  input: DraftEntryInput,
  options: DraftOptions = {},
): Promise<DraftResult> {
  return draft(
    ctx,
    ai,
    scope,
    input,
    {
      system:
        'You generate structured content entries. Return only values that satisfy the provided ' +
        "JSON schema. Respect each field's meaning and keep text concise and natural. " +
        `${BLOCKS_GUIDANCE} ` +
        // Field guidance in the schema descriptions is author text, delimited as data.
        UNTRUSTED_CONTENT_GUARD,
      prompt: (ct) =>
        `Content type: ${ct.name} (${ct.apiId}).\nInstructions: ${input.prompt}\nProduce values for every field in the schema.`,
      decision: (ct) => `Drafted ${ct.name} from a prompt`,
    },
    options,
  );
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
 * here the prose IS the source content, so it is delimited as data. Same schema
 * constraint, same validation gate, and same audit ledger, so a mapped entry is
 * one a human could have typed.
 */
export async function canvasToEntry(
  ctx: AppContext,
  ai: AIProvider,
  scope: Scope,
  input: CanvasInput,
  options: DraftOptions = {},
): Promise<DraftResult> {
  if (!input.prose.trim()) {
    throw new ValidationError([{ field: 'prose', message: 'Prose is required' }]);
  }
  return draft(
    ctx,
    ai,
    scope,
    input,
    {
      system:
        'You map free-form prose into a structured content entry. Extract the relevant ' +
        'information from the prose and place it into the fields defined by the JSON schema, ' +
        "preserving the author's wording where it maps directly to a field. Infer concise " +
        'values for fields the prose implies but does not state outright. Return only values ' +
        `that satisfy the schema. ${BLOCKS_GUIDANCE} ${UNTRUSTED_CONTENT_GUARD}`,
      prompt: (ct) =>
        `Content type: ${ct.name} (${ct.apiId}).\nProse:\n${wrapUntrusted(input.prose)}\nProduce values for every field in the schema.`,
      decision: (ct) => `Mapped prose into ${ct.name} via Canvas`,
    },
    options,
  );
}
