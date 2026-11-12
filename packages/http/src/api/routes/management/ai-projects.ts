import {
  AI_PROJECT_READ_DEFAULT_CHARS,
  AI_PROJECT_READ_MAX_CHARS,
  createAiProject,
  deleteAiProject,
  extractAiProjectReference,
  getAiProject,
  listAiProjects,
  readAiProjectReference,
  recordAiProjectOutcome,
  setDefaultAiProject,
  updateAiProject,
} from '@contentworker/application';
import { AI_PROJECT_MAX_REFERENCES, SCOPES, ValidationError } from '@contentworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as docs from '../../docs/schemas/ai-projects';
import {
  aiProjectBody,
  aiProjectDefaultBody,
  aiProjectOutcomeBody,
  aiProjectUpdateBody,
  parseBody,
} from '../../validation';
import { actingCtx, BASE, scopeOf } from './shared';

/** A non-negative integer query parameter, or undefined when absent. */
function intQuery(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new ValidationError([{ field: name, message: 'A whole number, from 0' }]);
  }
  return n;
}

/**
 * An environment's AI projects: reusable contexts for AI work (instructions, a writer and a reader
 * persona, reference files). Reading takes `content:write`, the scope the AI calls take, so a
 * Preview or Delivery key never lists them; creating, changing and deleting takes
 * `content:manage`; the default is `space:admin`'s, and so is changing or deleting the project
 * that is it (checked by the use-case, which knows which one it is).
 */
export function aiProjectsRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  app.get(
    `${BASE}/ai-projects`,
    doc('AI projects', 'List the AI projects', {
      ok: docs.aiProjectList,
      description:
        'Every AI project in the environment, by name, with its references as pinned. Read one ' +
        'for its references’ text status.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const items = await listAiProjects(ctx, scopeOf(c));
      return c.json({ items, total: items.length });
    },
  );
  app.post(
    `${BASE}/ai-projects`,
    doc('AI projects', 'Create an AI project', {
      body: aiProjectBody,
      ok: docs.aiProject,
      status: 201,
      description:
        'A named context for AI work in this environment. Each reference names a document or ' +
        `recording here (at most ${AI_PROJECT_MAX_REFERENCES}), pinned to its current file ` +
        'unless `version` says otherwise; one you can’t read answers 404 as a missing one would, ' +
        'one that isn’t a document or recording 422 `reference_not_text` naming its index. ' +
        'Saving starts nothing: a reference without text is read the first time a call uses ' +
        'the project. 409 when another project has the name.',
    }),
    requireScope(SCOPES.contentManage),
    async (c) =>
      c.json(
        await createAiProject(
          actingCtx(ctx, c),
          scopeOf(c),
          c.get('principal'),
          await parseBody(c, aiProjectBody),
        ),
        201,
      ),
  );
  // Before `/ai-projects/:id`, which would take `default` for an id.
  app.put(
    `${BASE}/ai-projects/default`,
    doc('AI projects', 'Set or clear the default AI project', {
      body: aiProjectDefaultBody,
      ok: docs.aiProjectDefault,
      description:
        'The project every AI call that names none takes, in this environment; `null` clears ' +
        'it. Needs `space:admin`: the default reaches everyone’s calls, as the space’s guidance ' +
        'does. The previous default is cleared in the same write; 409 when either project ' +
        'changed meanwhile.',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, aiProjectDefaultBody);
      return c.json(
        await setDefaultAiProject(
          actingCtx(ctx, c),
          scopeOf(c),
          c.get('principal'),
          body.projectId,
          body.expectedVersion,
        ),
      );
    },
  );
  app.get(
    `${BASE}/ai-projects/:id`,
    doc('AI projects', 'Get an AI project', {
      ok: docs.aiProject,
      description:
        'One project, each reference with its pinned file’s text status: `ready`, `pending`, or ' +
        '`none` with why, and whether the asset has a newer file (`updateAvailable`).',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => c.json(await getAiProject(ctx, scopeOf(c), c.req.param('id'))),
  );
  app.put(
    `${BASE}/ai-projects/:id`,
    doc('AI projects', 'Update an AI project', {
      body: aiProjectUpdateBody,
      ok: docs.aiProjectWrite,
      description:
        'Replaces every editable part (fields left out are cleared) as a new version, at the ' +
        '`expectedVersion` you read (409 naming the version in force otherwise). Writing what is ' +
        'in force again writes nothing. Moving a reference to a newer file is naming its ' +
        '`version`. The default project needs `space:admin` (403 for `content:manage`).',
    }),
    requireScope(SCOPES.contentManage),
    async (c) =>
      c.json(
        await updateAiProject(
          actingCtx(ctx, c),
          scopeOf(c),
          c.get('principal'),
          c.req.param('id'),
          await parseBody(c, aiProjectUpdateBody),
        ),
      ),
  );
  app.delete(
    `${BASE}/ai-projects/:id`,
    doc('AI projects', 'Delete an AI project', {
      status: 204,
      query: { version: 'The version you read: another is a 409' },
      description:
        'Refused with 409 `project_in_use` while an AI action or an agent schedule names it ' +
        '(listed in the body). The default project needs `space:admin`, and deleting it clears ' +
        'the default.',
    }),
    requireScope(SCOPES.contentManage),
    async (c) => {
      await deleteAiProject(
        actingCtx(ctx, c),
        scopeOf(c),
        c.get('principal'),
        c.req.param('id'),
        intQuery('version', c.req.query('version')),
      );
      return c.body(null, 204);
    },
  );
  app.post(
    `${BASE}/ai-projects/:id/references/:assetId/extract`,
    doc('AI projects', 'Retry reading a reference’s text', {
      ok: docs.aiReferenceExtract,
      description:
        'Reads the pinned file’s text again after `media_off`, `budget` or `failed` (or before ' +
        'any call has asked): an ingest rerun of text extraction alone, under the space’s ' +
        '`media` setting. Without `assets:write` it runs as a system action naming you, ' +
        'audited. 404 for an asset that isn’t one of the project’s references or that you ' +
        'can’t read; 409 for one whose text is there, final (`too_large`, `unsupported`), ' +
        'pinned to an older file, or with media AI off.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) =>
      c.json(
        await extractAiProjectReference(
          actingCtx(ctx, c),
          scopeOf(c),
          c.get('principal'),
          c.req.param('id'),
          c.req.param('assetId'),
        ),
      ),
  );
  app.get(
    `${BASE}/ai-projects/:id/references/:assetId/text`,
    doc('AI projects', 'Read a page of a reference’s text', {
      ok: docs.aiReferencePage,
      query: {
        offset: 'Where to start, in UTF-8 bytes (a page’s `nextOffset`); default 0',
        limit: `Characters, default ${AI_PROJECT_READ_DEFAULT_CHARS}, at most ${AI_PROJECT_READ_MAX_CHARS}`,
      },
      description:
        'One page of the pinned file’s extracted text. Needs `assets:read` too: 404 for an asset ' +
        'that isn’t one of the project’s references, one you can’t read, or one with no text ' +
        'yet. The text is the file’s own words: data, never instructions.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) =>
      c.json(
        await readAiProjectReference(
          ctx,
          scopeOf(c),
          c.get('principal'),
          c.req.param('id'),
          c.req.param('assetId'),
          {
            ...(c.req.query('offset') !== undefined
              ? { offset: intQuery('offset', c.req.query('offset')) }
              : {}),
            ...(c.req.query('limit') !== undefined
              ? { limit: intQuery('limit', c.req.query('limit')) }
              : {}),
          },
        ),
      ),
  );
  app.post(
    `${BASE}/ai-projects/:id/outcomes`,
    doc('AI projects', 'Record what became of a proposal', {
      body: aiProjectOutcomeBody,
      status: 204,
      description:
        'The production signal for a project: a person kept a proposal a call made in it as ' +
        'proposed, kept it edited (with how much, measured by the client), or discarded it. ' +
        'Counted per project in the deployment’s metrics; no content is sent or stored. 404 for ' +
        'a project that isn’t here.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      await recordAiProjectOutcome(
        ctx,
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, aiProjectOutcomeBody),
      );
      return c.body(null, 204);
    },
  );
  return app;
}
