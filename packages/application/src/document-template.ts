import { ConflictError, type Scope, ValidationError } from '@contentworker/domain';
import type { DocumentIngestOptions } from '@contentworker/ports';
import type { AppContext } from './context';

const defaults: DocumentIngestOptions = {
  createMediaDrafts: true,
  suggestTags: true,
  describeDocument: true,
};
const settingKey = (scope: Scope) =>
  'document-template/' + JSON.stringify([scope.spaceId, scope.environmentId]);

export async function getDocumentTemplate(ctx: AppContext, scope: Scope) {
  const saved = await ctx.store.settings.get(settingKey(scope));
  return {
    version: saved?.version ?? 0,
    ...defaults,
    ...(saved?.value as DocumentIngestOptions | undefined),
  };
}

/** Every write names the revision the editor read. Revision zero is the built-in template. */
export async function setDocumentTemplate(
  ctx: AppContext,
  scope: Scope,
  input: DocumentIngestOptions & { version: number },
) {
  const { version, createMediaDrafts, suggestTags, describeDocument } = input;
  if (
    !Number.isSafeInteger(version) ||
    version < 0 ||
    [createMediaDrafts, suggestTags, describeDocument].some((v) => typeof v !== 'boolean')
  )
    throw new ValidationError([
      { field: 'template', message: 'Expected a revision and boolean workflow options' },
    ]);
  const options = { createMediaDrafts, suggestTags, describeDocument };
  if (!(await ctx.store.settings.put(settingKey(scope), options, version || null)))
    throw new ConflictError(
      'The document template has changed. Read its current revision before saving.',
    );
  return { version: version + 1, ...options };
}
