import { NotFoundError, type Scope, ValidationError } from '@contentworker/domain';
import type { AIProvider, ModelTier } from '@contentworker/ports';
import { recordAgentRun } from './agent-audit.js';
import { generateWithBudget } from './ai-budget.js';
import { getAsset, setAssetMetadata } from './assets.js';
import type { AppContext } from './context.js';
import { createTag, listTags } from './taxonomy.js';

function assertImage(contentType: string): void {
  if (!contentType.startsWith('image/')) {
    throw new ValidationError([{ field: 'asset', message: 'Asset is not an image' }]);
  }
}

export interface GenerateAltTextInput {
  /** Locale to write the alt text for; defaults to the space default. */
  readonly locale?: string;
  /** Optional extra context about where/how the image is used. */
  readonly context?: string;
  /** When true, persist the result onto the asset's metadata. */
  readonly apply?: boolean;
  readonly tier?: ModelTier;
}

export interface AltTextResult {
  readonly altText: string;
  readonly locale: string;
  readonly applied: boolean;
  readonly usage: { inputTokens: number; outputTokens: number };
}

/**
 * Suggests accessibility/SEO alt text for an image from its textual context
 * (filename, title, description, caller hint). With `apply`, writes it to the
 * asset metadata. Every run is recorded in the agent cost ledger.
 */
export async function generateAltText(
  ctx: AppContext,
  ai: AIProvider,
  scope: Scope,
  id: string,
  input: GenerateAltTextInput = {},
): Promise<AltTextResult> {
  const asset = await getAsset(ctx, scope, id);
  assertImage(asset.file.contentType);
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  const locale = input.locale ?? config.defaultLocale;

  const title = asset.title?.[locale] ?? asset.title?.[config.defaultLocale];
  const description = asset.description?.[locale] ?? asset.description?.[config.defaultLocale];
  const system =
    'You write concise, descriptive alt text for images, for accessibility and SEO. ' +
    'One sentence, under 125 characters, no "image of"/"picture of" prefix.';
  const prompt = [
    `File: ${asset.file.fileName} (${asset.file.contentType}).`,
    title ? `Title: ${String(title)}` : '',
    description ? `Description: ${String(description)}` : '',
    input.context ? `Context: ${input.context}` : '',
    'Write alt text.',
  ]
    .filter(Boolean)
    .join('\n');

  const result = await generateWithBudget(ctx, ai, scope, {
    system,
    prompt,
    tier: input.tier ?? 'fast',
    maxTokens: 256,
    outputSchema: {
      type: 'object',
      properties: { altText: { type: 'string' } },
      required: ['altText'],
      additionalProperties: false,
    },
  });

  const obj = result.object as { altText?: string } | undefined;
  const altText = (obj?.altText ?? result.text ?? '').trim();
  if (!altText) {
    throw new ValidationError([{ field: 'altText', message: 'Model returned no alt text' }]);
  }

  let applied = false;
  if (input.apply) {
    await setAssetMetadata(ctx, scope, id, {
      altText: { ...asset.metadata.altText, [locale]: altText },
    });
    applied = true;
  }

  await recordAgentRun(ctx, scope, {
    workflow: 'alt-text',
    entryId: id,
    status: 'completed',
    decisions: [`Generated alt text for ${asset.file.fileName}`],
    usage: result.usage,
  });

  return { altText, locale, applied, usage: result.usage };
}

export interface AutoTagInput {
  /** When true, create any suggested new tags and apply all tags to the asset. */
  readonly apply?: boolean;
  readonly tier?: ModelTier;
}

export interface AutoTagResult {
  /** Existing tag ids the model judged relevant. */
  readonly tagIds: readonly string[];
  /** Suggested new tag names not already in the vocabulary. */
  readonly newTags: readonly string[];
  readonly applied: boolean;
  readonly usage: { inputTokens: number; outputTokens: number };
}

/**
 * Suggests taxonomy tags for an image: matches against the space's existing tag
 * vocabulary and proposes new tag names. With `apply`, creates the new tags and
 * writes the full tag set onto the asset metadata.
 */
export async function autoTagAsset(
  ctx: AppContext,
  ai: AIProvider,
  scope: Scope,
  id: string,
  input: AutoTagInput = {},
): Promise<AutoTagResult> {
  const asset = await getAsset(ctx, scope, id);
  assertImage(asset.file.contentType);
  const config = await ctx.store.spaces.getConfig(scope);
  const defaultLocale = config?.defaultLocale;
  const existing = await listTags(ctx, scope);

  const title = defaultLocale ? asset.title?.[defaultLocale] : undefined;
  const description = defaultLocale ? asset.description?.[defaultLocale] : undefined;
  const system =
    'You tag media assets. Choose the most relevant tags from the existing vocabulary, ' +
    'and suggest a few new tag names only when nothing fits. Return tag NAMES, lowercase.';
  const prompt = [
    `File: ${asset.file.fileName} (${asset.file.contentType}).`,
    title ? `Title: ${String(title)}` : '',
    description ? `Description: ${String(description)}` : '',
    `Existing tags: ${existing.map((t) => t.name).join(', ') || '(none)'}`,
    'Pick relevant existing tags and optionally suggest new ones.',
  ]
    .filter(Boolean)
    .join('\n');

  const result = await generateWithBudget(ctx, ai, scope, {
    system,
    prompt,
    tier: input.tier ?? 'fast',
    maxTokens: 512,
    outputSchema: {
      type: 'object',
      properties: {
        existingTags: { type: 'array', items: { type: 'string' } },
        newTags: { type: 'array', items: { type: 'string' } },
      },
      required: ['existingTags', 'newTags'],
      additionalProperties: false,
    },
  });

  const obj = (result.object ?? {}) as { existingTags?: string[]; newTags?: string[] };
  const byName = new Map(existing.map((t) => [t.name.toLowerCase(), t]));
  const chosen = obj.existingTags ?? [];
  const tagIds = chosen
    .map((name) => byName.get(name.toLowerCase())?.id)
    .filter((v): v is string => Boolean(v));
  // New names the model proposed that genuinely aren't in the vocabulary.
  const newTags = (obj.newTags ?? [])
    .map((n) => n.trim())
    .filter((n) => n && !byName.has(n.toLowerCase()));

  let applied = false;
  if (input.apply) {
    const createdIds: string[] = [];
    for (const name of newTags) {
      const tag = await createTag(ctx, scope, { name });
      createdIds.push(tag.id);
    }
    const allTagIds = Array.from(new Set([...asset.metadata.tags, ...tagIds, ...createdIds]));
    await setAssetMetadata(ctx, scope, id, { tags: allTagIds });
    applied = true;
  }

  await recordAgentRun(ctx, scope, {
    workflow: 'auto-tag',
    entryId: id,
    status: 'completed',
    decisions: [`Tagged ${asset.file.fileName}: ${[...tagIds, ...newTags].join(', ') || 'none'}`],
    usage: result.usage,
  });

  return { tagIds, newTags, applied, usage: result.usage };
}
