import {
  type AssetRequestSite,
  assetRequestSites,
  blocksFieldSchema,
  blockVariants,
  type ContentType,
  draftableFieldSchema,
  type EntryFields,
  type FieldDefinition,
  type FieldIssue,
  NotFoundError,
  resolveAssetRequests,
  type Scope,
  type UnresolvedImage,
  ValidationError,
  validateEntryFields,
  withoutClosedFields,
} from '@contentworker/domain';
import type { AIProvider, ModelTier } from '@contentworker/ports';
import { recordAgentRun } from './agent-audit';
import { generateWithBudget } from './ai-budget';
import { conforms } from './ai-json';
import {
  describeFieldForModel,
  nameForModel,
  UNTRUSTED_CONTENT_GUARD,
  wrapUntrusted,
} from './ai-prompt';
import type { AssetSearchDeps } from './asset-search';
import { assertBlockConfigAllows } from './block-config';
import type { AppContext } from './context';
import { assertAssetMimeTypes } from './entries';
import {
  findRequestedImages,
  imageGaps,
  imageRequiredIssue,
  isImageGap,
  LAYOUT_MAX_TOKENS,
  type LayoutRules,
  layoutSchemaOptions,
  layoutTimeoutMs,
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
 * in force; a field whose top level the rules lock, or that offers no block the model can fill,
 * is left out). `drafted` names them all; every other field is left for an editor, and the draft
 * isn't judged required on it.
 */
function schemaForContentType(
  ct: ContentType,
  layout: LayoutRules | null,
  assets: AssetSearchDeps | undefined,
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
    const tree = blocksFieldSchema(ct, f.apiId, layoutSchemaOptions(layout, assets));
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
  /**
   * The library search a blocks field's images are found with (`imageSearchFor`); without it no
   * image is asked for, and a block whose image is required is not offered.
   */
  readonly assets?: AssetSearchDeps;
}

export interface DraftResult {
  readonly contentTypeApiId: string;
  readonly fields: EntryFields;
  /** Image requests in the drafted blocks the library had no answer for: left empty. */
  readonly unresolvedImages: readonly UnresolvedImage[];
  /** Required images left unresolved (`image_required`): choose one before creating the entry. */
  readonly issues: readonly FieldIssue[];
  readonly usage: { inputTokens: number; outputTokens: number };
}

/** What both drafting use-cases share: the system prompt and the prompt, and how it's logged. */
interface DraftCall {
  readonly system: string;
  readonly prompt: (ct: ContentType) => string;
  readonly decision: (ct: ContentType) => string;
}

/**
 * Asks the model for a content type's fields and judges the answer as a create would: each
 * answered field against the schema it was sent (anything else is dropped, a field that doesn't
 * fit refuses the draft), then the same validators a human write uses (`validateEntryFields`, not
 * judged required on the fields a draft leaves for an editor) and, for its blocks, the block
 * config and the asset MIME rules. Images the blocks ask for are found in the library first.
 * Nothing is saved; the run is recorded so its cost shows, as failed when the draft is refused.
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

  const { schema, drafted, blocks } = schemaForContentType(ct, layout, options.assets);
  // A draft with a blocks field is a layout's answer: its room, and its time.
  const timeoutMs = blocks.size > 0 ? layoutTimeoutMs(ctx) : undefined;
  const result = await generateWithBudget(
    ctx,
    ai,
    scope,
    {
      system: call.system,
      prompt: call.prompt(ct),
      tier: input.tier ?? 'balanced',
      maxTokens: blocks.size > 0 ? LAYOUT_MAX_TOKENS : DRAFT_MAX_TOKENS,
      outputSchema: schema as unknown as Record<string, unknown>,
    },
    timeoutMs !== undefined ? { timeoutMs } : {},
  );
  const failed = async (err: Error, why: string): Promise<never> => {
    await recordAgentRun(ctx, scope, {
      workflow: 'generate',
      entryId: '',
      status: 'failed',
      decisions: [`Refused a draft of ${nameForModel(ct.name)}: ${why}`],
      usage: result.usage,
    });
    throw err;
  };

  if (!result.object || typeof result.object !== 'object' || Array.isArray(result.object)) {
    await failed(
      new ValidationError([{ field: '', message: 'Model did not return structured output' }]),
      'no structured output',
    );
  }

  // Only the fields the schema asked for, each as it asked: a key it didn't name (a link, a
  // field the draft leaves for an editor) is dropped, and a value outside its schema (a block
  // naming an asset id instead of asking for an image) refuses the draft.
  const raw = result.object as Record<string, unknown>;
  const answer: Record<string, unknown> = {};
  const misfits: FieldIssue[] = [];
  for (const apiId of drafted) {
    const value = raw[apiId];
    if (value === undefined || value === null) continue;
    if (conforms(value, schema.properties[apiId] ?? {})) answer[apiId] = value;
    else {
      misfits.push({
        field: apiId,
        code: 'bad_generation',
        message: 'The model’s answer for this field doesn’t fit what it takes; try again',
      } as FieldIssue);
    }
  }
  if (misfits.length > 0) await failed(new ValidationError(misfits), 'a field did not fit');

  // A blocks field's image requests become links to the library's best match, or are left out:
  // every field's requests together, under one cap.
  const sites: AssetRequestSite[] = [];
  const fieldOf = (apiId: string) => ct.fields.find((f) => f.apiId === apiId) as FieldDefinition;
  for (const apiId of blocks) {
    if (Array.isArray(answer[apiId])) {
      sites.push(...assetRequestSites(fieldOf(apiId), answer[apiId] as unknown[], apiId));
    }
  }
  const found = await findRequestedImages(
    ctx,
    options.assets,
    scope,
    sites,
    timeoutMs ?? layoutTimeoutMs(ctx),
  );
  const unresolved: UnresolvedImage[] = [];
  for (const apiId of blocks) {
    if (!Array.isArray(answer[apiId])) continue;
    const resolved = resolveAssetRequests(answer[apiId], found, apiId);
    answer[apiId] = resolved.value;
    unresolved.push(...resolved.unresolved);
  }
  const gaps = imageGaps(unresolved, sites);

  // Wrap each generated value into the localized shape under the default locale.
  const fields = draftedFields(ct, answer, config.defaultLocale);

  // Validation gate — identical to the human write path, but for the fields a draft can't fill
  // and the required images the library had no match for (reported, for an editor to choose).
  const unfilled = new Set(ct.fields.map((f) => f.apiId).filter((id) => !drafted.has(id)));
  const refused = validateEntryFields(ct, fields, {
    defaultLocale: config.defaultLocale,
    locales: config.locales,
    unfilled,
  }).filter((i) => !isImageGap(i, gaps.required));
  if (refused.length > 0) await failed(new ValidationError(refused), 'it broke a rule');
  // Blocks are placed as a create places them: under the block config, and the MIME rules.
  if (blocks.size > 0) {
    await assertBlockConfigAllows(ctx, scope, ct, undefined, fields, config.locales).catch(
      (err: unknown) => failed(err as Error, 'the block rules refused it'),
    );
  }
  await assertAssetMimeTypes(ctx, scope, ct, fields).catch((err: unknown) =>
    failed(err as Error, 'a file type was refused'),
  );

  // Audit the generation so its token cost shows in the dashboard ledger. Both
  // the HTTP route and the MCP tool reach this, so all generations are logged.
  await recordAgentRun(ctx, scope, {
    workflow: 'generate',
    entryId: '',
    status: 'completed',
    decisions: [call.decision(ct)],
    usage: result.usage,
  });

  return {
    contentTypeApiId: ct.apiId,
    fields,
    unresolvedImages: gaps.unresolved,
    issues: [...gaps.required].map((p) => imageRequiredIssue(p, config.defaultLocale)),
    usage: result.usage,
  };
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
        `Content type: ${nameForModel(ct.name)} (${ct.apiId}).\nInstructions: ${input.prompt}\nProduce values for every field in the schema.`,
      decision: (ct) => `Drafted ${nameForModel(ct.name)} from a prompt`,
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
        `Content type: ${nameForModel(ct.name)} (${ct.apiId}).\nProse:\n${wrapUntrusted(input.prose)}\nProduce values for every field in the schema.`,
      decision: (ct) => `Mapped prose into ${nameForModel(ct.name)} via Canvas`,
    },
    options,
  );
}
