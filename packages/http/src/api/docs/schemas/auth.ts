import { z } from 'zod';

const contentAction = z.enum(['read', 'write', 'publish', 'lock', 'delete', 'unpublish']);

const fieldRules = z.object({
  deniedFields: z
    .array(z.string())
    .describe('Top-level fields masked on read and refused on write: not shown'),
  readOnlyFields: z
    .array(z.string())
    .describe('Top-level fields readable but refused on write: an update keeps what they hold'),
});

export const principal = z.object({
  spaceId: z.string().describe('Space id, or `*` for the admin token'),
  kind: z.enum(['cma', 'cda', 'cpa', 'admin', 'user']),
  scopes: z.array(z.string()),
  restricted: z.boolean().optional().describe('The role carries per-content-type grants'),
});

export const spacePrincipal = principal.extend({
  bulkJobs: z
    .array(z.enum(['publish', 'unpublish', 'trash', 'restore', 'purge']))
    .describe('The bulk jobs over entries this role may start in the space'),
  contentActions: z
    .object({
      types: z
        .record(z.string(), z.array(contentAction))
        .describe('Per content type a grant names: the actions it holds there'),
      others: z
        .array(contentAction)
        .describe('On every type no grant names: the `*` grant’s actions, or none'),
    })
    .describe(
      'The content actions this role holds per content type; with no grants, every action ' +
        'on every type (the scopes still gate them)',
    ),
  fieldRules: z
    .object({
      types: z
        .record(z.string(), fieldRules)
        .describe('Per content type a grant names: the fields it restricts there'),
      others: fieldRules.describe('On every type no grant names: the `*` grant’s field rules'),
    })
    .describe(
      'The fields this role may not read or change, per content type, by name only; with no ' +
        'grants, none',
    ),
});

export const apiKeyCreated = z.object({
  id: z.uuid(),
  kind: z.enum(['cma', 'cda', 'cpa']),
  token: z.string().describe('Shown once — only its SHA-256 hash is stored'),
});
