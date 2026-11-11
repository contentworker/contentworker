import type { AppOperationView } from '@contentworker/application';

/**
 * An OpenAPI 3.1 document for one space's app operations, generated from the installed manifests:
 * each operation becomes its own path, with the manifest's input schema as the request body and
 * its output schema inside the `{ output }` response. The main document describes the one generic
 * invoke route; this is the view of it per plugin and operation, as a client generator wants it.
 */
export function appOperationsOpenApi(space: string, operations: readonly AppOperationView[]) {
  const paths: Record<string, unknown> = {};
  for (const op of operations) {
    paths[`/spaces/${space}/environments/{env}/apps/${op.plugin}/operations/${op.name}`] = {
      post: {
        operationId: `${op.plugin}.${op.name}`,
        tags: [op.pluginName],
        summary: op.title,
        description: `${op.description}\n\nNeeds \`${op.requires}\`.`,
        parameters: [{ name: 'env', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: op.input } },
        },
        responses: {
          '200': {
            description: 'The operation’s output',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { output: op.output ?? {} },
                  required: ['output'],
                },
              },
            },
          },
          '403': { description: `The caller lacks \`${op.requires}\`` },
          '422': { description: 'The input does not match the schema' },
          '502': { description: 'The plugin failed, timed out or answered off-schema' },
        },
        security: [{ bearer: [] }],
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: `App operations in ${space}`, version: '1' },
    servers: [{ url: '/' }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    paths,
  };
}
