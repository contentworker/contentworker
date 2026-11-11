import {
  assignRolePreset,
  createRole,
  deleteRole,
  listRolePresets,
  listRoles,
  listTeam,
  spaceAccessFor,
  updateRole,
} from '@contentworker/application';
import { ROLE_PRESETS, SCOPES, ValidationError } from '@contentworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { grantShape, ok, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

export function registerRoleTools(server: McpServer, t: ToolContext): void {
  const { deps, ctx, guard, principal } = t;
  // --- the caller's own access ----------------------------------------------
  // The same answer as GET /spaces/:space/auth/me: open to any caller, about itself only.
  server.registerTool(
    'auth_me',
    {
      description:
        'Who you are in a space and what your role lets you do there: your scopes, the bulk ' +
        'jobs over entries you may start (`bulkJobs`), your content actions per content type ' +
        '(`contentActions`: `types` for each type a grant names, `others` for the rest), and ' +
        'the fields per content type you may not read (`deniedFields`) or not change ' +
        '(`readOnlyFields`) in `fieldRules`, shaped the same way. Read it before writing an ' +
        'entry: leave out a read-only field (an update keeps what it holds) rather than sending ' +
        'a new value, which is refused. Names only, never values. Refused for a space you have ' +
        'no standing in.',
      inputSchema: toolSchema('auth_me', () => z.object({ space: scopeArgs.space })),
      annotations: { readOnlyHint: true },
    },
    async (args) => ok(spaceAccessFor(principal, scopeOf(args).spaceId)),
  );

  // --- roles (granular RBAC, admin) ----------------------------------------

  server.registerTool(
    'roles_list',
    {
      description: 'List the custom roles (granular RBAC) defined in a space.',
      inputSchema: toolSchema('roles_list', () => z.object(scopeArgs)),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(await listRoles(ctx, scopeOf(args).spaceId));
    },
  );

  server.registerTool(
    'role_create',
    {
      description:
        'Create a custom role: a scope set plus per-content-type grants with ' +
        'optional per-field deny/read-only rules. Assign it via api_key roleId.',
      inputSchema: toolSchema('role_create', () =>
        z.object({
          name: z.string(),
          description: z.string().optional(),
          scopes: z.array(z.string()).describe('permission scopes, e.g. content:write'),
          contentGrants: z.array(grantShape).optional(),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(
        await createRole(ctx, scopeOf(args).spaceId, {
          name: args.name,
          description: args.description,
          scopes: args.scopes,
          contentGrants: args.contentGrants,
        }),
      );
    },
  );

  server.registerTool(
    'role_update',
    {
      description:
        'Replace a role definition; keys bound to it pick the change up live. Read it with ' +
        'roles_list first and send its version as expectedVersion: a save made since is refused ' +
        '(409, naming the version in force), so read it again and show the person what changed.',
      inputSchema: toolSchema('role_update', () =>
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string().optional(),
          scopes: z.array(z.string()),
          contentGrants: z.array(grantShape).optional(),
          expectedVersion: z
            .int()
            .min(1)
            .optional()
            .describe('The version the role was read at; another is a 409'),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(
        await updateRole(
          ctx,
          scopeOf(args).spaceId,
          args.id,
          {
            name: args.name,
            description: args.description,
            scopes: args.scopes,
            contentGrants: args.contentGrants,
            ...(args.expectedVersion !== undefined
              ? { expectedVersion: args.expectedVersion }
              : {}),
          },
          deps.accessPolicy ?? { sso: false },
          t.principal,
        ),
      );
    },
  );

  server.registerTool(
    'role_delete',
    {
      description: 'Delete a role (refused while any active API key still references it).',
      inputSchema: toolSchema('role_delete', () => z.object({ id: z.string(), ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      await deleteRole(ctx, scopeOf(args).spaceId, args.id);
      return ok({ deleted: args.id });
    },
  );

  // --- role presets + team (admin; same use-cases as /spaces/:space/{role-presets,team}) ------
  // First-run setup is deliberately not a tool: it is a person with a setup code, over HTTP.
  const accessPolicy = deps.accessPolicy ?? { sso: false };

  server.registerTool(
    'role_presets_list',
    {
      description:
        'List the built-in role presets (Viewer, Approver, Editor, Manager, Administrator) with ' +
        'the role id each is seeded as in the space and its live scopes. Each preset includes ' +
        'everything the one before it can do.',
      inputSchema: toolSchema('role_presets_list', () => z.object(scopeArgs)),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(await listRolePresets(ctx, scopeOf(args).spaceId));
    },
  );

  server.registerTool(
    'team_list',
    {
      description:
        'List the team: people (SSO sign-in) and long-lived API keys with their roles, which of ' +
        'them are administrators, and the admin count (the last admin cannot be demoted).',
      inputSchema: toolSchema('team_list', () => z.object(scopeArgs)),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      return ok(await listTeam(ctx, scopeOf(args).spaceId, accessPolicy));
    },
  );

  server.registerTool(
    'role_preset_assign',
    {
      description:
        'Give an API key (keyId) or a person (memberId) one of the role presets. Refused when it ' +
        'would leave the space with no administrator. With a personal access token or OAuth ' +
        "token, refused for a person's role, and for a key's when it would widen the key. For a " +
        'person, send the version team_list showed as expectedVersion: a change made to them ' +
        'since is refused (409, naming the version in force), so read the team again and show ' +
        'the person what changed.',
      inputSchema: toolSchema('role_preset_assign', () =>
        z.object({
          preset: z.enum(ROLE_PRESETS),
          keyId: z.string().optional(),
          memberId: z.string().optional(),
          expectedVersion: z
            .int()
            .min(1)
            .optional()
            .describe('With memberId: the version the person was read at; another is a 409'),
          ...scopeArgs,
        }),
      ),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      if (!args.keyId === !args.memberId) {
        throw new ValidationError([
          { field: 'keyId', message: 'Give exactly one of keyId or memberId' },
        ]);
      }
      if (args.keyId && args.expectedVersion !== undefined) {
        throw new ValidationError([
          { field: 'expectedVersion', message: 'Only a person (memberId) has a version' },
        ]);
      }
      const target = args.keyId
        ? { keyId: args.keyId }
        : {
            memberId: args.memberId as string,
            ...(args.expectedVersion !== undefined
              ? { expectedVersion: args.expectedVersion }
              : {}),
          };
      return ok(
        await assignRolePreset(
          ctx,
          scopeOf(args).spaceId,
          target,
          args.preset,
          accessPolicy,
          t.principal,
        ),
      );
    },
  );
}
