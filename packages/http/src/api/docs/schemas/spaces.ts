import { z } from 'zod';

export const spaceRef = z.object({ id: z.string(), name: z.string() });

export const createdSpace = spaceRef.extend({
  starter: z.enum(['empty', 'sample']),
  installed: z
    .object({
      contentTypes: z.number().int(),
      entries: z.number().int(),
      assets: z.number().int(),
      tags: z.number().int(),
      concepts: z.number().int(),
      releases: z.number().int(),
    })
    .optional()
    .describe('What the sample starter holds once installed (absent for `empty`)'),
});
