import { z } from 'zod';

// --- app operations (plugin manifest v2) -------------------------------------------------------

const operationSchema = z
  .record(z.string(), z.unknown())
  .describe(
    'A JSON Schema in the subset manifests declare: object, array, string, number, integer, boolean',
  );

export const appOperation = z.object({
  plugin: z.string().describe('The plugin id, as it appears in the invoke path'),
  pluginName: z.string(),
  pluginVersion: z.string(),
  name: z.string().describe('The operation name, as it appears in the invoke path'),
  title: z.string(),
  description: z.string(),
  requires: z.string().describe('The scope a caller holds to invoke it'),
  mode: z
    .enum(['sync', 'async'])
    .describe('`async`: invoking it returns a job; read the output from the job'),
  input: operationSchema,
  output: operationSchema.optional(),
});

export const appOperationList = z.object({
  items: z.array(appOperation).describe('Only the operations the caller may invoke'),
});

export const appOperationJob = z.object({
  id: z.string(),
  plugin: z.string(),
  pluginVersion: z.string().describe('The plugin version accepted to run it'),
  operation: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  input: z.unknown(),
  output: z
    .unknown()
    .optional()
    .describe('Once completed: what the operation returned, checked against its output schema'),
  error: z.string().optional().describe('Once failed: why'),
  createdBy: z.string(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  expiresAt: z
    .string()
    .describe('When the job and its output are deleted (a day after it was accepted)'),
});

export const appOperationJobList = z.object({
  items: z.array(appOperationJob).describe('The latest 50 jobs the caller may read'),
});

export const appOperationResult = z.union([
  z.object({
    output: z
      .unknown()
      .describe('A sync operation: what it returned, checked against its output schema'),
  }),
  z.object({ job: appOperationJob.describe('An async operation: the job it was accepted as') }),
]);
