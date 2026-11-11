import {
  addComment,
  commentEntryId,
  createTask,
  deleteComment,
  deleteTask,
  listComments,
  listTasks,
  reassignTask,
  reopenTask,
  resolveTask,
  taskEntryId,
} from '@contentworker/application';
import { SCOPES } from '@contentworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { commentBody, createTaskBody, parseBody, updateTaskBody } from '../../validation';
import { BASE, entryAccess, scopeOf } from './shared';

export function collaborationRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const { authorizeEntryRead } = entryAccess(ctx);
  const app = new Hono<AuthVars>();

  // --- comments (on entries) ---------------------------------------------
  app.get(`${BASE}/entries/:id/comments`, requireScope(SCOPES.previewRead), async (c) => {
    await authorizeEntryRead(c, c.req.param('id'));
    return c.json({ items: await listComments(ctx, scopeOf(c), c.req.param('id')) });
  });
  // Every comment and task operation is held to read on the entry's type, as listing them is:
  // they are talk about content, so a role that can see the entry may take part, and one that
  // can't may neither read nor write about it (nor learn it exists).
  app.post(`${BASE}/entries/:id/comments`, requireScope(SCOPES.contentWrite), async (c) => {
    await authorizeEntryRead(c, c.req.param('id'));
    const body = await parseBody(c, commentBody);
    const created = await addComment(ctx, scopeOf(c), {
      entryId: c.req.param('id'),
      body: body.body,
      author: body.author ?? c.get('principal').kind,
      parentId: body.parentId,
    });
    return c.json(created, 201);
  });
  app.delete(`${BASE}/comments/:id`, requireScope(SCOPES.contentWrite), async (c) => {
    await authorizeEntryRead(c, await commentEntryId(ctx, scopeOf(c), c.req.param('id')));
    await deleteComment(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  // --- tasks (on entries) ------------------------------------------------
  app.get(`${BASE}/entries/:id/tasks`, requireScope(SCOPES.previewRead), async (c) => {
    await authorizeEntryRead(c, c.req.param('id'));
    return c.json({ items: await listTasks(ctx, scopeOf(c), c.req.param('id')) });
  });
  app.post(`${BASE}/entries/:id/tasks`, requireScope(SCOPES.contentWrite), async (c) => {
    await authorizeEntryRead(c, c.req.param('id'));
    const body = await parseBody(c, createTaskBody);
    const created = await createTask(ctx, scopeOf(c), {
      entryId: c.req.param('id'),
      body: body.body,
      assignee: body.assignee,
    });
    return c.json(created, 201);
  });
  // PUT applies one change: resolve/reopen (status) or reassign (assignee).
  app.put(`${BASE}/tasks/:id`, requireScope(SCOPES.contentWrite), async (c) => {
    const body = await parseBody(c, updateTaskBody);
    const id = c.req.param('id');
    const scope = scopeOf(c);
    await authorizeEntryRead(c, await taskEntryId(ctx, scope, id));
    if (body.status === 'resolved') return c.json(await resolveTask(ctx, scope, id));
    if (body.status === 'open') return c.json(await reopenTask(ctx, scope, id));
    if ('assignee' in body)
      return c.json(await reassignTask(ctx, scope, id, body.assignee ?? null));
    return c.json({ error: 'Provide status or assignee' }, 400);
  });
  app.delete(`${BASE}/tasks/:id`, requireScope(SCOPES.contentWrite), async (c) => {
    await authorizeEntryRead(c, await taskEntryId(ctx, scopeOf(c), c.req.param('id')));
    await deleteTask(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  return app;
}
