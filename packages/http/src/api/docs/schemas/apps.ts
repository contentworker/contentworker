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
  mode: z.enum(['sync']),
  input: operationSchema,
  output: operationSchema.optional(),
});

export const appOperationList = z.object({
  items: z.array(appOperation).describe('Only the operations the caller may invoke'),
});

export const appOperationResult = z.object({
  output: z.unknown().describe('What the operation returned, checked against its output schema'),
});
