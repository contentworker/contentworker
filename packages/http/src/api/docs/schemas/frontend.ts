import { z } from 'zod';

const frontendKey = z.object({
  id: z.uuid().describe('The API key, to revoke it under Settings → API keys'),
  token: z.string().describe('Shown once — only its SHA-256 hash is stored'),
});

export const frontendConnection = z.object({
  space: z.string(),
  environment: z.string().describe('As requested: an alias stays an alias'),
  deliveryKey: frontendKey.describe('A Content Delivery API key (`delivery:read`, `search:read`)'),
  previewKey: frontendKey
    .optional()
    .describe('A Content Preview API key, when `preview` was asked for: keep it server-side'),
  endpoints: z
    .object({
      admin: z.string().describe('The admin origin: `connectPreview`’s `adminOrigin`'),
      delivery: z.string().describe('Delivery’s origin: the SDK’s `baseUrl`, `CONTENTWORKER`'),
      preview: z.string().describe('The api’s origin: Preview, and the draft-mode route'),
    })
    .optional()
    .describe('Absent when the deployment has no OAUTH_ISSUER to derive them from'),
  previewUrls: z
    .array(
      z.object({
        contentType: z.string(),
        name: z.string(),
        urlTemplate: z.string().nullable(),
      }),
    )
    .describe('Each content type the caller reads, with its preview URL template (null: unset)'),
});
