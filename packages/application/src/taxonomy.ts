import {
  type Concept,
  type ConceptScheme,
  type EntryMetadata,
  InvalidStateError,
  isAcyclicBroader,
  NotFoundError,
  type Scope,
  type Tag,
} from '@contentworker/domain';
import type { AppContext } from './context.js';

// --- concept schemes ------------------------------------------------------

export async function createScheme(
  ctx: AppContext,
  scope: Scope,
  input: { name: string },
): Promise<ConceptScheme> {
  const scheme: ConceptScheme = { id: ctx.ids.newId(), name: input.name };
  await ctx.store.taxonomy.createScheme(scope, scheme);
  return scheme;
}

export const listSchemes = (ctx: AppContext, scope: Scope): Promise<ConceptScheme[]> =>
  ctx.store.taxonomy.listSchemes(scope);

export async function deleteScheme(ctx: AppContext, scope: Scope, id: string): Promise<void> {
  if (!(await ctx.store.taxonomy.getScheme(scope, id)))
    throw new NotFoundError('ConceptScheme', id);
  await ctx.store.taxonomy.deleteScheme(scope, id);
}

// --- concepts -------------------------------------------------------------

export async function createConcept(
  ctx: AppContext,
  scope: Scope,
  input: { schemeId: string; prefLabel: string; broaderId?: string | null },
): Promise<Concept> {
  if (!(await ctx.store.taxonomy.getScheme(scope, input.schemeId))) {
    throw new NotFoundError('ConceptScheme', input.schemeId);
  }
  const broaderId = input.broaderId ?? null;
  if (broaderId && !(await ctx.store.taxonomy.getConcept(scope, broaderId))) {
    throw new NotFoundError('Concept', broaderId);
  }
  const concept: Concept = {
    id: ctx.ids.newId(),
    schemeId: input.schemeId,
    prefLabel: input.prefLabel,
    broaderId,
  };
  await ctx.store.taxonomy.createConcept(scope, concept);
  return concept;
}

export const listConcepts = (
  ctx: AppContext,
  scope: Scope,
  schemeId?: string,
): Promise<Concept[]> => ctx.store.taxonomy.listConcepts(scope, schemeId);

/** Re-parents a concept, rejecting a change that would create a cycle. */
export async function setConceptBroader(
  ctx: AppContext,
  scope: Scope,
  id: string,
  broaderId: string | null,
): Promise<Concept> {
  const concept = await ctx.store.taxonomy.getConcept(scope, id);
  if (!concept) throw new NotFoundError('Concept', id);
  if (broaderId && !(await ctx.store.taxonomy.getConcept(scope, broaderId))) {
    throw new NotFoundError('Concept', broaderId);
  }
  const all = await ctx.store.taxonomy.listConcepts(scope);
  const parentOf = (cid: string) => all.find((c) => c.id === cid)?.broaderId ?? null;
  if (!isAcyclicBroader(id, broaderId, parentOf)) {
    throw new InvalidStateError('That parent would create a cycle in the concept hierarchy');
  }
  const updated: Concept = { ...concept, broaderId };
  await ctx.store.taxonomy.createConcept(scope, updated);
  return updated;
}

export async function deleteConcept(ctx: AppContext, scope: Scope, id: string): Promise<void> {
  if (!(await ctx.store.taxonomy.getConcept(scope, id))) throw new NotFoundError('Concept', id);
  await ctx.store.taxonomy.deleteConcept(scope, id);
}

// --- tags -----------------------------------------------------------------

export async function createTag(
  ctx: AppContext,
  scope: Scope,
  input: { name: string },
): Promise<Tag> {
  const tag: Tag = { id: ctx.ids.newId(), name: input.name };
  await ctx.store.taxonomy.createTag(scope, tag);
  return tag;
}

export const listTags = (ctx: AppContext, scope: Scope): Promise<Tag[]> =>
  ctx.store.taxonomy.listTags(scope);

export async function deleteTag(ctx: AppContext, scope: Scope, id: string): Promise<void> {
  if (!(await ctx.store.taxonomy.getTag(scope, id))) throw new NotFoundError('Tag', id);
  await ctx.store.taxonomy.deleteTag(scope, id);
}

// --- entry associations ---------------------------------------------------

export const getEntryMetadata = (
  ctx: AppContext,
  scope: Scope,
  entryId: string,
): Promise<EntryMetadata | null> => ctx.store.taxonomy.getEntryMetadata(scope, entryId);

/**
 * Sets an entry's tag/concept associations, validating that every referenced
 * tag and concept exists. Takes effect on the next publish (the snapshot copies
 * the current metadata).
 */
export async function setEntryMetadata(
  ctx: AppContext,
  scope: Scope,
  entryId: string,
  input: { tags?: readonly string[]; concepts?: readonly string[] },
): Promise<EntryMetadata> {
  if (!(await ctx.store.entries.get(scope, entryId))) throw new NotFoundError('Entry', entryId);
  const tags = input.tags ?? [];
  const concepts = input.concepts ?? [];
  for (const tagId of tags) {
    if (!(await ctx.store.taxonomy.getTag(scope, tagId))) throw new NotFoundError('Tag', tagId);
  }
  for (const conceptId of concepts) {
    if (!(await ctx.store.taxonomy.getConcept(scope, conceptId))) {
      throw new NotFoundError('Concept', conceptId);
    }
  }
  const metadata: EntryMetadata = { tags: [...tags], concepts: [...concepts] };
  await ctx.store.taxonomy.setEntryMetadata(scope, entryId, metadata);
  return metadata;
}
