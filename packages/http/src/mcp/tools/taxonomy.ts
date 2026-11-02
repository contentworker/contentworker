import {
  createConcept,
  createScheme,
  createTag,
  listConcepts,
  listTags,
  scheduleAction,
  setEntryMetadata,
} from '@contentworker/application';
import { SCOPES } from '@contentworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ok, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

export function registerTaxonomyTools(server: McpServer, t: ToolContext): void {
  const { ctx, guard } = t;
  // --- taxonomy ----------------------------------------------------------
  server.registerTool(
    'taxonomy_list_tags',
    {
      description: 'List the flat tags defined in a space/environment.',
      inputSchema: toolSchema('taxonomy_list_tags', () => z.object(scopeArgs)),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listTags(ctx, scopeOf(args)));
    },
  );

  server.registerTool(
    'taxonomy_create_tag',
    {
      description: 'Create a flat tag.',
      inputSchema: toolSchema('taxonomy_create_tag', () =>
        z.object({ name: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(await createTag(ctx, scopeOf(args), { name: args.name }));
    },
  );

  server.registerTool(
    'taxonomy_create_scheme',
    {
      description: 'Create a concept scheme (a controlled vocabulary).',
      inputSchema: toolSchema('taxonomy_create_scheme', () =>
        z.object({ name: z.string(), ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(await createScheme(ctx, scopeOf(args), { name: args.name }));
    },
  );

  server.registerTool(
    'taxonomy_list_concepts',
    {
      description: 'List concepts, optionally limited to one scheme.',
      inputSchema: toolSchema('taxonomy_list_concepts', () =>
        z.object({ scheme: z.string().optional(), ...scopeArgs }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await listConcepts(ctx, scopeOf(args), args.scheme));
    },
  );

  server.registerTool(
    'taxonomy_create_concept',
    {
      description: 'Create a concept within a scheme, optionally nested under a broader concept.',
      inputSchema: toolSchema('taxonomy_create_concept', () =>
        z.object({
          schemeId: z.string(),
          prefLabel: z.string(),
          broaderId: z.string().optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentManage, scopeOf(args));
      return ok(
        await createConcept(ctx, scopeOf(args), {
          schemeId: args.schemeId,
          prefLabel: args.prefLabel,
          broaderId: args.broaderId,
        }),
      );
    },
  );

  server.registerTool(
    'entries_set_metadata',
    {
      description:
        "Set an entry's taxonomy associations (tag ids + concept ids). Takes effect " +
        'on the next publish.',
      inputSchema: toolSchema('entries_set_metadata', () =>
        z.object({
          entryId: z.string(),
          tags: z.array(z.string()).optional(),
          concepts: z.array(z.string()).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentWrite, scopeOf(args));
      return ok(
        await setEntryMetadata(ctx, scopeOf(args), args.entryId, {
          tags: args.tags,
          concepts: args.concepts,
        }),
      );
    },
  );

  server.registerTool(
    'schedule_action',
    {
      description:
        'Schedule a publish/unpublish of an entry or release for a future ISO-8601 instant. A publish a gated workflow covers is refused (publish_gated) now, and fails if gating is on when it fires.',
      inputSchema: toolSchema('schedule_action', () =>
        z.object({
          action: z.enum(['publish', 'unpublish']),
          entityType: z.enum(['Entry', 'Release']),
          entityId: z.string(),
          scheduledFor: z.string().describe('ISO-8601 instant'),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.contentPublish, scopeOf(args));
      return ok(
        await scheduleAction(ctx, scopeOf(args), {
          action: args.action,
          entityType: args.entityType,
          entityId: args.entityId,
          scheduledFor: args.scheduledFor,
        }),
      );
    },
  );
}
