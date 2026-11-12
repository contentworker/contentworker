import type { AppOperationView } from '@contentworker/application';

/**
 * An OpenAPI 3.1 document for one space's app operations, generated from the installed manifests:
 * each operation becomes its own path, with the manifest's input schema as the request body and
 * its output schema inside the `{ output }` response (an async operation answers 202 with the job
 * it was accepted as, and the job's `output` follows that schema). The main document describes the one generic
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
          ...(op.mode === 'async' ? acceptedResponse(space, op) : okResponse(op)),
          '403': { description: `The caller lacks \`${op.requires}\`` },
          '422': { description: 'The input does not match the schema' },
          ...(op.mode === 'async'
            ? { '409': { description: 'Ten operations are already running in the environment' } }
            : { '502': { description: 'The plugin failed, timed out or answered off-schema' } }),
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

function okResponse(op: AppOperationView) {
  return {
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
  };
}

function acceptedResponse(space: string, op: AppOperationView) {
  return {
    '202': {
      description:
        `Accepted as a job that runs in the background; follow it at ` +
        `/spaces/${space}/environments/{env}/apps/jobs/{id} until it is completed (its \`output\`) ` +
        'or failed (its `error`).',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              job: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed'] },
                  output: op.output ?? {},
                  error: { type: 'string' },
                },
                required: ['id', 'status'],
              },
            },
            required: ['job'],
          },
        },
      },
    },
  };
}
