import {
  createContentType,
  createEntry,
  getPreviewEntry,
  moderateEntry,
  publishContentType,
  publishEntry,
  unpublishEntry,
  updateEntry,
} from '@contentworker/application';
import {
  assertWritableFields,
  authorizeContent,
  type EntryFields,
  SCOPES,
  ValidationError,
} from '@contentworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  entryFields,
  fieldSchema,
  ok,
  scopeArgs,
  scopeOf,
  type ToolContext,
  toolSchema,
} from './shared';

export function registerWriteTools(server: McpServer, t: ToolContext): void {
  const { deps, ctx, agents, principal, guard, guardEntry } = t;
  // --- write -------------------------------------------------------------
  server.registerTool(
    'model_create_content_type',
    {
      description: 'Create or update a content type definition.',
      inputSchema: toolSchema('model_create_content_type', () =>
        z.object({
          apiId: z.string(),
          name: z.string(),
          displayField: z.string(),
          fields: z.array(fieldSchema),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(
        await createContentType(ctx, scopeOf(args), {
          apiId: args.apiId,
          name: args.name,
          displayField: args.displayField,
          // biome-ignore lint/suspicious/noExplicitAny: zod field shape → domain FieldDefinition
          fields: args.fields as any,
        }),
      );
    },
  );

  server.registerTool(
    'model_publish_content_type',
    {
      description: 'Publish a content type so entries can be delivered against it.',
      inputSchema: toolSchema('model_publish_content_type', () =>
        z.object({ apiId: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      return ok(await publishContentType(ctx, scopeOf(args), args.apiId));
    },
  );

  server.registerTool(
    'entries_create',
    {
      description: 'Create a draft entry. Fields are validated against the content model.',
      inputSchema: toolSchema('entries_create', () =>
        z.object({ contentType: z.string(), fields: entryFields, ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      authorizeContent(principal, 'write', args.contentType);
      assertWritableFields(principal, args.contentType, args.fields ?? {});
      return ok(
        await createEntry(ctx, scopeOf(args), {
          contentTypeApiId: args.contentType,
          fields: args.fields as EntryFields,
        }),
      );
    },
  );

  server.registerTool(
    'entries_update',
    {
      description: 'Save new field values as a new draft version of an entry.',
      inputSchema: toolSchema('entries_update', () =>
        z.object({ id: z.string(), fields: entryFields, ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      if (principal.contentGrants) {
        const entry = await getPreviewEntry(ctx, scopeOf(args), args.id);
        authorizeContent(principal, 'write', entry.contentType);
        assertWritableFields(principal, entry.contentType, args.fields ?? {});
      }
      return ok(await updateEntry(ctx, scopeOf(args), args.id, args.fields as EntryFields));
    },
  );

  server.registerTool(
    'entries_publish',
    {
      description:
        'Publish an entry (validates references; emits an entry.published event). Refused (publish_gated) when a workflow that gates publishing covers the entry: only a run of that workflow publishes it.',
      inputSchema: toolSchema('entries_publish', () =>
        z.object({
          id: z.string(),
          expectedVersion: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("The entry's currentVersion as you read it; refused if it has changed since"),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      await guardEntry(scopeOf(args), args.id, 'publish');
      if (deps.moderateBeforePublish) {
        const verdict = await moderateEntry(ctx, agents, scopeOf(args), args.id);
        if (verdict.flagged) {
          throw new ValidationError([
            {
              field: 'moderation',
              message: `Publish blocked by moderation: ${verdict.decisions.join('; ') || 'policy violation'}`,
            },
          ]);
        }
      }
      return ok(
        await publishEntry(ctx, scopeOf(args), args.id, { expectedVersion: args.expectedVersion }),
      );
    },
  );

  server.registerTool(
    'entries_unpublish',
    {
      description: 'Withdraw an entry from the Delivery API.',
      inputSchema: toolSchema('entries_unpublish', () =>
        z.object({
          id: z.string(),
          expectedVersion: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("The entry's currentVersion as you read it; refused if it has changed since"),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      await guardEntry(scopeOf(args), args.id, 'publish');
      return ok(
        await unpublishEntry(ctx, scopeOf(args), args.id, {
          expectedVersion: args.expectedVersion,
        }),
      );
    },
  );
}
