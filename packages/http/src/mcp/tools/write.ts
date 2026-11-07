import {
  authorizeBulkJob,
  cloneContentType,
  contentTypeDependents,
  createContentType,
  createEntry,
  deleteContentType,
  deleteContentTypeWithEntries,
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
  CONTENT_TYPE_LIMITS,
  type EntryFields,
  MAX_URL_PATTERN_LENGTH,
  maskDeniedFields,
  SCOPES,
  unwritableFieldsFor,
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
        'input), `placeholder` (an example), labelled options in `validations.in` as ' +
        '{ value, label }, and `validations.messages` to replace a rule’s default error text. ' +
        '`rules` hide or disable a field while a sibling matches: a hidden field is not ' +
        'required, and a disabled one keeps its stored value. The type can carry a `group` and ' +
        '`icon` (how the admin lists it), a `description`, and an editor-only `layout` of tabs ' +
        'and field groups for the entry form.',
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
          singleton: z
            .boolean()
            .optional()
            .describe(
              'holds at most one entry (site settings, a home page), read with singleton_get; ' +
                'refused while the type has more than one entry. Left out, unchanged',
            ),
          group: z
            .string()
            .max(CONTENT_TYPE_LIMITS.group)
            .nullable()
            .optional()
            .describe('the admin sidebar lists types under their group; null clears it'),
          description: z
            .string()
            .max(CONTENT_TYPE_LIMITS.description)
            .nullable()
            .optional()
            .describe('what the type is for, for editors and agents; null clears it'),
          icon: z
            .string()
            .max(CONTENT_TYPE_LIMITS.icon)
            .nullable()
            .optional()
            .describe('a kebab-case icon name the admin draws, e.g. newspaper; null clears it'),
          agentInstructions: z
            .string()
            .max(CONTENT_TYPE_LIMITS.agentInstructions)
            .nullable()
            .optional()
            .describe(
              'how an agent should write entries of this type, in plain text; never delivered; ' +
                'null clears it',
            ),
          layout: z
            .record(z.string(), z.any())
            .nullable()
            .optional()
            .describe(
              'editor-only entry form layout, never delivered: { tabs: [{ apiId, name, groups: ' +
                '[{ name?, fields: [top-level field apiIds], collapsed? }] }] }; each field ' +
                'placed at most once, unplaced fields follow on the first tab; null clears it',
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
          ...(args.singleton !== undefined ? { singleton: args.singleton } : {}),
          ...(args.group !== undefined ? { group: args.group } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.icon !== undefined ? { icon: args.icon } : {}),
          ...(args.agentInstructions !== undefined
            ? { agentInstructions: args.agentInstructions }
            : {}),
          // biome-ignore lint/suspicious/noExplicitAny: zod record → domain ContentTypeLayout, checked there
          ...(args.layout !== undefined ? { layout: args.layout as any } : {}),
          // biome-ignore lint/suspicious/noExplicitAny: zod field shape → domain FieldDefinition
          fields: args.fields as any,
        }),
      );
    },
  );

  server.registerTool(
    'model_publish_content_type',
    {
      description:
        'Publish a content type: its current definition becomes what Delivery serves (GraphQL, ' +
        'routes, sitemap, menus). Until then a live type keeps serving its last published ' +
        'definition; a type never published is left out of routes, sitemap and menus, but ' +
        'GraphQL already serves it. Entries can be written and published either way.',
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
    'model_content_type_dependents',
    {
      description:
        'What depends on a content type, so why model_delete_content_type would refuse it: its ' +
        'entries (live and in the trash), other types whose links are restricted to it, menus ' +
        'and slug redirects naming its entries, and its URL pattern.',
      inputSchema: toolSchema('model_content_type_dependents', () =>
        z.object({ apiId: z.string(), ...scopeArgs }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      authorizeContent(principal, 'read', args.apiId);
      return ok(await contentTypeDependents(ctx, scopeOf(args), args.apiId));
    },
  );

  server.registerTool(
    'model_delete_content_type',
    {
      description:
        'Delete a content type. Refused, naming every reason, while anything depends on it (see ' +
        'model_content_type_dependents). purgeEntries: true deletes its entries too, as a ' +
        'resumable bulk job (each trashed, then purged; needs content:write and content:publish; ' +
        'follow it with bulk_job_status): the type goes when the job completes cleanly, and the ' +
        "job's config.typeDeletion then says { deleted: true } or { deleted: false, reason }. " +
        'Answers { deleted } and, for a job, { job }.',
      inputSchema: toolSchema('model_delete_content_type', () =>
        z.object({
          apiId: z.string(),
          purgeEntries: z
            .boolean()
            .optional()
            .describe('delete its entries (the trash included) first, as a job'),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      if (!args.purgeEntries) {
        await deleteContentType(ctx, scopeOf(args), args.apiId);
        return ok({ deleted: true });
      }
      guard(SCOPES.contentWrite, scopeOf(args));
      guard(SCOPES.contentPublish, scopeOf(args));
      authorizeBulkJob(principal, 'content_type_delete');
      return ok(await deleteContentTypeWithEntries(ctx, scopeOf(args), args.apiId));
    },
  );

  server.registerTool(
    'model_clone_content_type',
    {
      description:
        'Copy a content type’s definition (fields, display field, singleton, group, description, ' +
        'icon, layout) under a new apiId and name, as a draft with no entries. Not its URL ' +
        'pattern.',
      inputSchema: toolSchema('model_clone_content_type', () =>
        z.object({
          apiId: z.string().describe('the type to copy'),
          newApiId: z.string(),
          name: z.string(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(await cloneContentType(ctx, scopeOf(args), args.apiId, args.newApiId, args.name));
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
      let unwritable: readonly string[] = [];
      if (principal.contentGrants) {
        const entry = await getPreviewEntry(ctx, scopeOf(args), args.id);
        authorizeContent(principal, 'write', entry.contentType);
        assertWritableFields(principal, entry.contentType, args.fields ?? {});
        unwritable = unwritableFieldsFor(principal, entry.contentType);
      }
      const saved = await updateEntry(ctx, scopeOf(args), args.id, args.fields as EntryFields, {
        unwritable,
      });
      // The save kept the fields this writer may not write; the ones it may not read stay hidden.
      return ok({
        ...saved,
        fields: maskDeniedFields(principal, saved.entry.contentTypeApiId, saved.fields),
      });
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
        let unwritable: readonly string[] = [];
        let type = '';
        if (principal.contentGrants) {
          const entry = await getPreviewEntry(ctx, scopeOf(args), args.id);
          type = entry.contentType;
          authorizeContent(principal, 'write', type);
          assertWritableFields(principal, type, fields);
          unwritable = unwritableFieldsFor(principal, type);
        }
        const result = await validateEntry(
          ctx,
          scopeOf(args),
          { entryId: args.id, fields },
          { unwritable },
        );
        // Judged with the stored values of the fields this writer may not write; answered without
        // the ones it may not read.
        return ok({ ...result, fields: maskDeniedFields(principal, type, result.fields) });
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
