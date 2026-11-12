import {
  getAppOperationJob,
  invokeAppOperation,
  listAppOperationJobs,
  listAppOperations,
} from '@contentworker/application';
import { Hono } from 'hono';
import type { AuthDeps, AuthVars } from '../../auth';
import { appOperationsOpenApi } from '../../docs/app-operations-openapi';
import { doc } from '../../docs/openapi';
import * as appDocs from '../../docs/schemas/apps';
import { appOperationInputBody, parseBody } from '../../validation';
import { BASE, scopeOf } from './shared';

/**
 * App operations: what installed plugins offer callers by name (manifest v2). No route-level
 * scope: each operation declares the scope it needs, and the use-case checks it, so the list
 * shows a caller only what it may invoke.
 */
export function appsRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  app.get(
    `${BASE}/apps/operations`,
    doc('Apps', 'List app operations', {
      ok: appDocs.appOperationList,
      description:
        'The operations enabled plugins offer, with their input and output schemas, less those ' +
        'whose `requires` scope the caller does not hold.',
    }),
    async (c) =>
      c.json({ items: await listAppOperations(ctx, c.get('principal'), c.req.param('space')) }),
  );

  app.post(
    `${BASE}/apps/:plugin/operations/:operation`,
    doc('Apps', 'Invoke an app operation', {
      body: appOperationInputBody,
      bodyDescription: 'The operation’s input, checked against its declared input schema (422)',
      ok: appDocs.appOperationResult,
      description:
        'Runs the operation in the plugin sandbox with the plugin’s grant narrowed to the ' +
        'caller’s scopes. A sync operation answers `{ output }`; 502 when the plugin throws, ' +
        'runs past 10 s or answers outside its output schema. An `async` one answers 202 ' +
        '`{ job }` at once and runs in the background for up to 5 minutes: follow it at ' +
        '`…/apps/jobs/{id}` (409 while ten are pending or running in the environment, or while it keeps 1,000 jobs). 403 ' +
        'without the scope it `requires`; 404 for an unknown or disabled operation. Each ' +
        'plugin’s own operations are described in the space’s `/spaces/{space}/apps/openapi.json`.',
    }),
    async (c) => {
      const input = await parseBody(c, appOperationInputBody);
      const result = await invokeAppOperation(
        ctx,
        c.get('principal'),
        scopeOf(c),
        c.req.param('plugin'),
        c.req.param('operation'),
        input,
      );
      return 'job' in result ? c.json(result, 202) : c.json(result);
    },
  );

  app.get(
    `${BASE}/apps/jobs`,
    doc('Apps', 'List async app operation jobs', {
      ok: appDocs.appOperationJobList,
      description:
        'The environment’s latest async operation jobs that the caller could have run ' +
        'itself: it holds the operation’s scope and every scope the job’s caller held.',
    }),
    async (c) => c.json({ items: await listAppOperationJobs(ctx, c.get('principal'), scopeOf(c)) }),
  );

  app.get(
    `${BASE}/apps/jobs/:id`,
    doc('Apps', 'Get an async app operation job', {
      ok: appDocs.appOperationJob,
      description:
        'Status, and once `completed` the output (`failed`: the error). 404 for a job the ' +
        'caller could not have run itself. Jobs are kept a day.',
    }),
    async (c) =>
      c.json(await getAppOperationJob(ctx, c.get('principal'), scopeOf(c), c.req.param('id'))),
  );

  app.get(
    '/spaces/:space/apps/openapi.json',
    doc('Apps', 'Describe a space’s app operations as OpenAPI', {
      description:
        'An OpenAPI 3.1 document with one path per operation the caller may invoke, generated ' +
        'from the installed manifests: the per-plugin view of the invoke route.',
    }),
    async (c) => {
      const space = c.req.param('space');
      return c.json(
        appOperationsOpenApi(space, await listAppOperations(ctx, c.get('principal'), space)),
      );
    },
  );

  return app;
}
