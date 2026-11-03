import {
  createContentType,
  createEntry,
  getPreviewEntry,
  moderateEntry,
  publishContentType,
  publishEntry,
  unpublishEntry,
  updateEntry,
  validateEntry,
} from '@contentworker/application';
import {
  assertWritableFields,
  authorizeContent,
  type EntryFields,
  MAX_URL_PATTERN_LENGTH,
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
      description:
        'Create or update a content type definition. A field can carry guidance for whoever ' +
        'fills it: `description` (what it means), `help` (how to fill it, shown under the ' +
        'input), `placeholder` (an example), and `validations.messages` to replace a rule’s ' +
        'default error text.',
      inputSchema: toolSchema('model_create_content_type', () =>
        z.object({
          apiId: z.string(),
          name: z.string(),
          displayField: z.string(),
          fields: z.array(fieldSchema),
          urlPattern: z
            .string()
            .max(MAX_URL_PATTERN_LENGTH)
            .nullable()
            .optional()
            .describe(
              'where its entries live on the site, e.g. /blog/{slug} ({id}, {locale} or a Slug ' +
                'field); a publish that changes the slug redirects the old path. null clears it',
            ),
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
          ...(args.urlPattern !== undefined ? { urlPattern: args.urlPattern } : {}),
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
    'entries_validate',
    {
      description:
        'Validate entry fields without saving: exactly the checks entries_create (with ' +
        'contentType) or entries_update (with id) would make, failing with the same errors. ' +
        'Writes nothing. Answers the fields as they would be stored, and skippedHooks: plugins ' +
        'that hold capabilities and so did not run (a real save may still rewrite or refuse).',
      inputSchema: toolSchema('entries_validate', () =>
        z
          .object({
            contentType: z.string().optional().describe('Validate as a new entry of this type'),
            id: z.string().optional().describe('Validate as a new version of this entry'),
            fields: entryFields,
            ...scopeArgs,
          })
          .refine((a) => (a.contentType === undefined) !== (a.id === undefined), {
            message: 'Give contentType (a new entry) or id (a new version), not both',
          }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      const fields = (args.fields ?? {}) as EntryFields;
      if (args.id !== undefined) {
        if (principal.contentGrants) {
          const entry = await getPreviewEntry(ctx, scopeOf(args), args.id);
          authorizeContent(principal, 'write', entry.contentType);
          assertWritableFields(principal, entry.contentType, fields);
        }
        return ok(await validateEntry(ctx, scopeOf(args), { entryId: args.id, fields }));
      }
      const contentTypeApiId = args.contentType ?? '';
      authorizeContent(principal, 'write', contentTypeApiId);
      assertWritableFields(principal, contentTypeApiId, fields);
      return ok(await validateEntry(ctx, scopeOf(args), { contentTypeApiId, fields }));
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
      description:
        'Withdraw an entry from the Delivery API. A role needs unpublish on the type, which ' +
        'comes with publish unless its grant withholds it.',
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
      await guardEntry(scopeOf(args), args.id, 'unpublish');
      return ok(
        await unpublishEntry(ctx, scopeOf(args), args.id, {
          expectedVersion: args.expectedVersion,
        }),
      );
    },
  );
}
