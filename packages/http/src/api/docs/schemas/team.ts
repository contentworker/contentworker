import { z } from 'zod';

/** A person on a space's team, as adding or changing them returns them. */
export const member = z.object({
  id: z.uuid(),
  spaceId: z.string(),
  email: z.string().describe('Lower-cased; unique within the space'),
  name: z.string().optional(),
  subject: z.string().optional().describe('The SSO subject, linked on their first sign-in'),
  roleId: z.uuid(),
  disabled: z.boolean().describe('Their SSO sign-in is refused'),
  version: z
    .int()
    .min(1)
    .describe('1 when added, one more at each save; send it back as `expectedVersion`'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
