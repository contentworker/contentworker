/**
 * The config the Connect a frontend screen prints, for each way a site reads ContentWorker: the
 * frontend runtime (`@contentworker/frontend`, one `CONTENTWORKER` setting), the SDK, a Next.js
 * site's draft mode (`@contentworker/sdk/next`) and live preview (`connectPreview`). Text only:
 * the keys and endpoints come from `connectFrontend`, and until keys are minted each token is a
 * placeholder. A token goes only where a secret goes (an env file, `wrangler secret put` at its
 * prompt), never on a command line, into `wrangler.jsonc` or a URL.
 */
import type { FrontendEndpoints } from '@contentworker/domain';

export interface FrontendConfigInput {
  readonly space: string;
  readonly environment: string;
  /** The locale a site reads by default: the space's default locale. */
  readonly locale: string;
  readonly endpoints: FrontendEndpoints;
  /** The minted tokens, while this screen holds them; placeholders otherwise. */
  readonly deliveryToken?: string;
  readonly previewToken?: string;
}

export const DELIVERY_KEY_PLACEHOLDER = '<your Delivery key>';
export const PREVIEW_KEY_PLACEHOLDER = '<your Preview key>';

/** Where a Next.js site's draft route lives, as its preview URL template names it. */
export const NEXT_DRAFT_TEMPLATE =
  'https://your-site.example/api/draft?entry={id}&token={token}&locale={locale}';

const json = (value: string) => JSON.stringify(value);

/**
 * `wrangler.jsonc` vars for the frontend runtime. Over HTTP the runtime finds Preview from
 * Delivery's host (`cdn.` → `api.`); where it can't (a local stack, one origin), the snippet names
 * it with `CONTENTWORKER_PREVIEW`.
 */
export function runtimeVars(i: FrontendConfigInput): string {
  const { delivery, preview } = i.endpoints;
  const derived = delivery.includes('//cdn.') && delivery.replace('//cdn.', '//api.') === preview;
  const lines = [
    '"vars": {',
    `  "CONTENTWORKER": ${json(`${delivery}/${i.space}/${i.environment}`)},`,
    `  "CONTENTWORKER_LOCALE": ${json(i.locale)}${derived ? '' : ','}`,
  ];
  if (!derived) {
    lines.push(`  "CONTENTWORKER_PREVIEW": ${json(i.endpoints.preview)}`);
  }
  lines.push('}');
  return lines.join('\n');
}

/** The runtime's key, as a Worker secret: pasted at wrangler's prompt, so no shell history holds it. */
export const RUNTIME_SECRET_COMMAND = 'npx wrangler secret put CONTENTWORKER_KEY';

/** Server-side env for the SDK (and the Next.js helper): the keys, never in client code. */
export function sdkEnv(i: FrontendConfigInput, withPreview: boolean): string {
  const lines = [`CONTENTWORKER_DELIVERY_KEY=${i.deliveryToken ?? DELIVERY_KEY_PLACEHOLDER}`];
  if (withPreview) {
    lines.push(`CONTENTWORKER_PREVIEW_KEY=${i.previewToken ?? PREVIEW_KEY_PLACEHOLDER}`);
  }
  return lines.join('\n');
}

/** A Delivery client for this space and environment. */
export function sdkClient(i: FrontendConfigInput): string {
  return [
    "import { createDeliveryClient } from '@contentworker/sdk';",
    '',
    'export const client = createDeliveryClient({',
    `  baseUrl: ${quote(i.endpoints.delivery)},`,
    `  space: ${quote(i.space)},`,
    `  environment: ${quote(i.environment)},`,
    '  token: process.env.CONTENTWORKER_DELIVERY_KEY!,',
    '});',
  ].join('\n');
}

/** Next.js: the route a preview link opens, which checks its token and turns draft mode on. */
export function nextDraftRoute(i: FrontendConfigInput): string {
  return [
    '// app/api/draft/route.ts',
    "import { draftMode } from 'next/headers';",
    "import { createDraftRoute } from '@contentworker/sdk/next';",
    '',
    'export const GET = createDraftRoute({',
    `  baseUrl: ${quote(i.endpoints.preview)},`,
    `  space: ${quote(i.space)},`,
    `  environment: ${quote(i.environment)},`,
    '  draftMode,',
    '});',
  ].join('\n');
}

/** Next.js: a client that reads Preview while draft mode is on, and Delivery otherwise. */
export function nextClient(i: FrontendConfigInput): string {
  return [
    '// lib/contentworker.ts',
    "import { draftMode } from 'next/headers';",
    "import { createDraftClient } from '@contentworker/sdk/next';",
    '',
    'export const getClient = createDraftClient({',
    '  draftMode,',
    '  delivery: {',
    `    baseUrl: ${quote(i.endpoints.delivery)},`,
    `    space: ${quote(i.space)},`,
    `    environment: ${quote(i.environment)},`,
    '    token: process.env.CONTENTWORKER_DELIVERY_KEY!,',
    '  },',
    `  preview: { baseUrl: ${quote(i.endpoints.preview)}, token: process.env.CONTENTWORKER_PREVIEW_KEY! },`,
    '});',
  ].join('\n');
}

/** Live preview: the page connects to this admin when it frames the page. */
export function livePreview(i: FrontendConfigInput): string {
  return [
    "import { connectPreview } from '@contentworker/sdk/live-preview';",
    '',
    'connectPreview({',
    `  adminOrigin: ${quote(i.endpoints.admin)},`,
    '  onState(entryId, locale, fields) {',
    '    // Render the unsaved values in place of the delivered ones.',
    '  },',
    '});',
  ].join('\n');
}

/** A single-quoted TypeScript string literal. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
