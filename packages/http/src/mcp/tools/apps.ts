import { invokeAppOperation, listAppOperations } from '@contentworker/application';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ok, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

/**
 * App operations over MCP: two generic tools rather than one per operation per install, so the
 * tool list stays fixed per deploy (cached, filtered by scope) however many plugins a space runs.
 * An agent lists what it may call, with each operation's input schema, then invokes by name. Both
 * call the same use-cases as `GET …/apps/operations` and `POST …/apps/:plugin/operations/:op`;
 * each operation's own `requires` scope is checked there, so neither tool has a scope of its own.
 */
export function registerAppTools(server: McpServer, t: ToolContext): void {
  const { ctx, principal } = t;

  server.registerTool(
    'app_operations_list',
    {
      description:
        'List the operations installed plugins offer that you may invoke, each with its plugin, ' +
        'name, description, the scope it requires and the JSON Schema of its input and output. ' +
        'Call one with app_operation_invoke.',
      inputSchema: toolSchema('app_operations_list', () => z.object(scopeArgs)),
      annotations: { readOnlyHint: true },
    },
    async (args) => ok({ items: await listAppOperations(ctx, principal, scopeOf(args).spaceId) }),
  );

  server.registerTool(
    'app_operation_invoke',
    {
      description:
        'Invoke an installed plugin’s operation by plugin id and operation name (from ' +
        'app_operations_list), with `input` matching its input schema. Returns `{ output }`. The ' +
        'plugin runs sandboxed with no more access than you hold. Fails on a schema mismatch, a ' +
        'missing scope, or when the plugin errors or runs past 10 seconds.',
      inputSchema: toolSchema('app_operation_invoke', () =>
        z.object({
          plugin: z.string().describe('The plugin id, e.g. com.example.seo'),
          operation: z.string().describe('The operation name'),
          input: z
            .record(z.string(), z.unknown())
            .optional()
            .describe('The operation input, per its input schema'),
          ...scopeArgs,
        }),
      ),
    },
    async (args) =>
      ok(
        await invokeAppOperation(
          ctx,
          principal,
          scopeOf(args),
          args.plugin,
          args.operation,
          args.input ?? {},
        ),
      ),
  );
}
