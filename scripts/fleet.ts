/**
 * The fleet: one contentworker deployment per customer, each listed in deployments/<id>.jsonc,
 * each with its own D1, KV, R2, Vectorize index, queues, Workflows, AI Gateway and Workers.
 *
 *   node scripts/fleet.ts render <id>          write apps/{web,api,engine,media,delivery}/wrangler.<id>.json
 *                                              (and apps/docs for the deployment that hosts docs)
 *   node scripts/fleet.ts matrix               the deployments of each ring, for CI
 *   node scripts/fleet.ts secrets <app> <out>  write this app's secrets from the environment
 *   node scripts/fleet.ts status               deep health of every deployment
 *   node scripts/fleet.ts doctor <id>          check a deployment's rendered configs are complete and
 *                                              agree, then whether its scheduler is ticking
 *                                              (--offline skips the fetch; --url <api base> overrides)
 *   node scripts/fleet.ts names <id>           resource names as shell variables (provisioning)
 *   node scripts/fleet.ts set-d1 <id> <uuid>   record the D1 database id in the registry
 *   node scripts/fleet.ts set-kv <id> <kv id>  record the shared KV namespace id
 *   node scripts/fleet.ts demos                the provisioned demo deployments
 *
 * A rendered config is the app's wrangler.jsonc with the deployment's names, ids and hosts put in,
 * written next to it so its relative paths still resolve. Deploy order (CI): engine first (it owns
 * the Durable Object and Workflow classes the others bind by script name), then media (so it
 * verifies the URLs the api and delivery hand out before they hand them out), api, delivery, web.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEdits, modify, type ParseError, parse, printParseErrorCode } from 'jsonc-parser';
import { deriveAssistantKey } from './derive-assistant-key.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RINGS = ['staging', 'internal', 'canary', 'general'] as const;
type Ring = (typeof RINGS)[number];

/** The Workers a deployment runs, in deploy order. */
export const APPS = ['engine', 'media', 'api', 'delivery', 'web'] as const;
export type App = (typeof APPS)[number];

/** Ids a customer can't have: `<id>.contentworker.app` would read as part of the product. */
const RESERVED = new Set([
  'admin',
  'api',
  'app',
  'auth',
  'billing',
  'blog',
  'cdn',
  'console',
  'dashboard',
  'dev',
  'docs',
  'help',
  'internal',
  'login',
  'mail',
  'mcp',
  'preview',
  'prod',
  'production',
  'sandbox',
  'staging',
  'status',
  'support',
  'test',
  'www',
]);

/** Each app's secrets, read from the deploy job's environment (the GitHub environment's secrets). */
export const SECRETS: Record<App, readonly string[]> = {
  web: [
    'PRINCIPAL_KEY',
    'PRINCIPAL_KEY_PREVIOUS',
    'DATA_KEY',
    'DATA_KEY_PREVIOUS',
    'SETUP_TOKEN',
    'PASSWORD_PEPPER',
    'OIDC_CLIENT_SECRET',
  ],
  api: [
    'PRINCIPAL_KEY',
    'PRINCIPAL_KEY_PREVIOUS',
    'DATA_KEY',
    'DATA_KEY_PREVIOUS',
    'TOKEN_PEPPER',
    'MEDIA_SIGNING_SECRET',
    'STREAM_WEBHOOK_SECRET',
    'MCP_TOKEN',
    'ADMIN_TOKEN',
  ],
  // The engine's AssistantAgent verifies its socket's signed principal itself, with the key
  // derived for it (DERIVED below); it never holds PRINCIPAL_KEY.
  engine: [
    'ASSISTANT_PRINCIPAL_KEY',
    'ASSISTANT_PRINCIPAL_KEY_PREVIOUS',
    'DATA_KEY',
    'DATA_KEY_PREVIOUS',
    'TOKEN_PEPPER',
    'MEDIA_SIGNING_SECRET',
  ],
  delivery: ['DATA_KEY', 'DATA_KEY_PREVIOUS', 'TOKEN_PEPPER', 'MEDIA_SIGNING_SECRET'],
  // Verifies Preview's short-lived signed draft reads; it signs nothing and reads no secret at rest.
  media: ['MEDIA_SIGNING_SECRET'],
};

/**
 * Secrets no environment holds: `secrets` derives each from the one named, so rotating that one
 * rotates it (the previous from the previous). The assistant's principal key is HKDF of
 * PRINCIPAL_KEY (`deriveAssistantPrincipalKey` in @contentworker/security).
 */
export const DERIVED: Record<string, { from: string; derive: (secret: string) => string }> = {
  ASSISTANT_PRINCIPAL_KEY: { from: 'PRINCIPAL_KEY', derive: deriveAssistantKey },
  ASSISTANT_PRINCIPAL_KEY_PREVIOUS: { from: 'PRINCIPAL_KEY_PREVIOUS', derive: deriveAssistantKey },
};

/** The deploy job's environment with the derived secrets added (never echoed). */
export function withDerived(env: Record<string, string | undefined>) {
  const out = { ...env };
  for (const [name, { from, derive }] of Object.entries(DERIVED)) {
    const source = env[from];
    out[name] = source ? derive(source) : undefined;
  }
  return out;
}

/**
 * Secrets a deploy can't go without; missing, the deploy stops before migrating anything.
 * PRINCIPAL_KEY signs what the web Worker forwards to the api (and the assistant's socket, which the
 * engine checks too); DATA_KEY seals secrets at rest;
 * TOKEN_PEPPER is in every API key hash; MEDIA_SIGNING_SECRET signs media URLs.
 */
export const REQUIRED_SECRETS = [
  'PRINCIPAL_KEY',
  'DATA_KEY',
  'TOKEN_PEPPER',
  'MEDIA_SIGNING_SECRET',
];

/** Keys that must be long enough not to be guessed offline from what they signed. */
const KEYS = [
  'PRINCIPAL_KEY',
  'PRINCIPAL_KEY_PREVIOUS',
  'DATA_KEY',
  'DATA_KEY_PREVIOUS',
  'TOKEN_PEPPER',
  'PASSWORD_PEPPER',
  'MEDIA_SIGNING_SECRET',
] as const;
export const MIN_KEY_LENGTH = 32;

export function keysProblem(env: Record<string, string | undefined>): string | null {
  const short = KEYS.filter((k) => env[k] && env[k]!.length < MIN_KEY_LENGTH);
  return short.length
    ? `${short.join(', ')} must be at least ${MIN_KEY_LENGTH} characters (openssl rand -hex 32)`
    : null;
}

export type Deployment = {
  id: string;
  ring: Ring;
  /** Unique per deployment: keeps each one's rate-limit namespaces apart (slot × 1000 + n). */
  slot: number;
  /** The admin's host. Defaults to `<id>.contentworker.app`; the api is `api.<domain>`, delivery `cdn.<domain>`, media `media.<domain>`. */
  domain: string;
  /** Appended to every account-wide name. Defaults to `-<id>`; contentworker's own is `""`. */
  suffix: string;
  /** The GitHub environment holding this deployment's secrets. Defaults to `deploy-<id>`. */
  environment: string;
  /** Set by scripts/provision.sh; required to render or deploy. */
  d1Id?: string;
  /** The KV namespace the api, engine and delivery share (delivery cache, principal cache). */
  kvId?: string;
  /** Data location for D1, R2 and Durable Objects (`eu`, `fedramp`), set when they're created. */
  jurisdiction?: 'eu' | 'fedramp';
  /** Skipped by CI: stays on what it runs now. */
  hold: boolean;
  /** Deploys the public docs site with it (contentworker's own deployment only). */
  docs: boolean;
  /** A public demo: seeded content and mocked models. Never a customer's. */
  demo: boolean;
  /** Whether the AI Gateway keeps request logs. Default false. */
  aiGatewayLogs: boolean;
  /** The customer's OIDC provider for admin single sign-on (secret: OIDC_CLIENT_SECRET). */
  sso?: { issuer: string; clientId: string; trustEmail?: boolean };
  /**
   * Email Sending sender for workflow `content.notify` nodes and invitations (the engine) and
   * password reset codes (web); adds both Workers' EMAIL binding.
   */
  email?: { from: string; fromName?: string };
};

function readJsonc(path: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value = parse(readFileSync(path, 'utf8'), errors, { allowTrailingComma: true });
  if (errors.length)
    throw new Error(`${path}: ${errors.map((e) => printParseErrorCode(e.error)).join(', ')}`);
  return value as Record<string, unknown>;
}

const HOST_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;

export function toDeployment(raw: Record<string, unknown>, file = 'deployment'): Deployment {
  const id = raw.id;
  if (typeof id !== 'string' || !/^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){1,30}$/.test(id))
    throw new Error(`${file}: id must be lowercase letters, digits and dashes`);
  if (RESERVED.has(id) && typeof raw.domain !== 'string')
    throw new Error(`${file}: "${id}" is reserved; choose another id or set domain`);
  const ring = raw.ring as Ring;
  if (!RINGS.includes(ring)) throw new Error(`${file}: ring must be one of ${RINGS.join(', ')}`);
  if (!Number.isInteger(raw.slot) || (raw.slot as number) < 1 || (raw.slot as number) > 999)
    throw new Error(`${file}: slot must be an integer from 1 to 999`);
  if (raw.domain !== undefined && (typeof raw.domain !== 'string' || !HOST_RE.test(raw.domain)))
    throw new Error(`${file}: domain must be a host name`);
  if (raw.d1Id !== undefined && raw.d1Id !== '' && typeof raw.d1Id !== 'string')
    throw new Error(`${file}: d1Id must be the D1 database's id`);
  if (raw.kvId !== undefined && raw.kvId !== '' && !/^[0-9a-f]{32}$/.test(String(raw.kvId)))
    throw new Error(`${file}: kvId must be the KV namespace's 32-character id`);
  if (raw.jurisdiction !== undefined && raw.jurisdiction !== 'eu' && raw.jurisdiction !== 'fedramp')
    throw new Error(`${file}: jurisdiction must be "eu" or "fedramp"`);
  if (raw.aiGatewayLogs !== undefined && typeof raw.aiGatewayLogs !== 'boolean')
    throw new Error(`${file}: aiGatewayLogs must be true or false`);
  const sso = raw.sso as Record<string, unknown> | undefined;
  if (sso !== undefined) {
    if (typeof sso.issuer !== 'string' || !/^https:\/\/\S+$/.test(sso.issuer))
      throw new Error(`${file}: sso.issuer must be the identity provider's https issuer URL`);
    if (typeof sso.clientId !== 'string' || !sso.clientId.trim())
      throw new Error(`${file}: sso.clientId must be the client id the provider issued`);
  }
  const email = raw.email as Record<string, unknown> | undefined;
  if (
    email !== undefined &&
    (typeof email.from !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(email.from))
  )
    throw new Error(
      `${file}: email.from must be an address on a domain onboarded to Email Sending`,
    );
  if (raw.demo === true && raw.ring === 'general')
    throw new Error(`${file}: a demo never rides the general ring`);
  const nonEmpty = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const d1Id = nonEmpty(raw.d1Id);
  const kvId = nonEmpty(raw.kvId);
  return {
    id,
    ring,
    slot: raw.slot as number,
    domain: (raw.domain as string | undefined) ?? `${id}.contentworker.app`,
    suffix: typeof raw.suffix === 'string' ? raw.suffix : `-${id}`,
    environment: typeof raw.environment === 'string' ? raw.environment : `deploy-${id}`,
    ...(d1Id ? { d1Id } : {}),
    ...(kvId ? { kvId } : {}),
    ...(raw.jurisdiction ? { jurisdiction: raw.jurisdiction as 'eu' | 'fedramp' } : {}),
    hold: raw.hold === true,
    docs: raw.docs === true,
    demo: raw.demo === true,
    aiGatewayLogs: raw.aiGatewayLogs === true,
    ...(sso
      ? {
          sso: {
            issuer: sso.issuer as string,
            clientId: sso.clientId as string,
            ...(sso.trustEmail === true ? { trustEmail: true } : {}),
          },
        }
      : {}),
    ...(email
      ? {
          email: {
            from: email.from as string,
            ...(typeof email.fromName === 'string' ? { fromName: email.fromName } : {}),
          },
        }
      : {}),
  };
}

export function loadDeployments(dir = join(ROOT, 'deployments')): Deployment[] {
  const list = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonc'))
    .map((f) => toDeployment(readJsonc(join(dir, f)), f));
  const dup = (key: (d: Deployment) => string | number | undefined) => {
    const seen = new Set<string | number>();
    for (const d of list) {
      const v = key(d);
      if (v === undefined) continue;
      if (seen.has(v)) return v;
      seen.add(v);
    }
    return undefined;
  };
  for (const [what, key] of [
    ['id', (d: Deployment) => d.id],
    ['slot', (d: Deployment) => d.slot],
    ['domain', (d: Deployment) => d.domain],
    ['suffix', (d: Deployment) => d.suffix],
    // A copied id would run one customer's Workers and migrations on another's data.
    ['d1Id', (d: Deployment) => d.d1Id],
    ['kvId', (d: Deployment) => d.kvId],
  ] as const) {
    const v = dup(key);
    if (v !== undefined) throw new Error(`two deployments share ${what} ${JSON.stringify(v)}`);
  }
  return list;
}

/** Account-wide names: the base name plus the deployment's suffix. */
export const names = (d: Deployment) => ({
  web: `contentworker-web${d.suffix}`,
  api: `contentworker-api${d.suffix}`,
  engine: `contentworker-engine${d.suffix}`,
  delivery: `contentworker-delivery${d.suffix}`,
  // The media Worker shares its base name with the bucket (Workers and buckets are named apart).
  mediaWorker: `contentworker-media${d.suffix}`,
  d1: `contentworker${d.suffix}`,
  kv: `contentworker-cache${d.suffix}`,
  media: `contentworker-media${d.suffix}`,
  vectors: `contentworker-vectors${d.suffix}`,
  aiGateway: `contentworker${d.suffix}`,
  queue: (q: string) => `${q}${d.suffix}`,
  // Analytics Engine dataset names allow letters, digits and underscores.
  dataset: `contentworker_metrics${d.suffix.replaceAll('-', '_')}`,
});

export const hosts = (d: Deployment) => ({
  web: d.domain,
  api: `api.${d.domain}`,
  delivery: `cdn.${d.domain}`,
  media: `media.${d.domain}`,
});

type Config = Record<string, any>;

/** Everything account-wide every app may bind, renamed for the deployment. */
function common(base: Config, d: Deployment, app: App): Config {
  if (!d.d1Id) throw new Error(`${d.id} has no d1Id: run scripts/provision.sh ${d.id}`);
  if (!d.kvId && app !== 'web')
    throw new Error(`${d.id} has no kvId: run scripts/provision.sh ${d.id}`);
  const n = names(d);
  const c = structuredClone(base);
  c.name = app === 'media' ? n.mediaWorker : n[app];
  c.workers_dev = false;
  c.preview_urls = false;
  c.d1_databases = (c.d1_databases ?? []).map((db: Config) => ({
    ...db,
    database_name: n.d1,
    database_id: d.d1Id,
  }));
  if (c.kv_namespaces)
    c.kv_namespaces = c.kv_namespaces.map((k: Config) =>
      k.binding === 'KV_CACHE' ? { ...k, id: d.kvId } : k,
    );
  if (c.r2_buckets)
    c.r2_buckets = c.r2_buckets.map((b: Config) => ({
      ...b,
      bucket_name: n.media,
      ...(d.jurisdiction ? { jurisdiction: d.jurisdiction } : {}),
    }));
  if (c.vectorize) {
    if (d.demo) delete c.vectorize;
    else c.vectorize = c.vectorize.map((v: Config) => ({ ...v, index_name: n.vectors }));
  }
  if (c.analytics_engine_datasets)
    c.analytics_engine_datasets = c.analytics_engine_datasets.map((a: Config) => ({
      ...a,
      dataset: n.dataset,
    }));
  if (c.queues?.producers)
    c.queues.producers = c.queues.producers.map((p: Config) => ({ ...p, queue: n.queue(p.queue) }));
  if (c.queues?.consumers)
    c.queues.consumers = c.queues.consumers.map((q: Config) => ({
      ...q,
      queue: n.queue(q.queue),
      ...(q.dead_letter_queue ? { dead_letter_queue: n.queue(q.dead_letter_queue) } : {}),
    }));
  // Workflow names are account-wide; bindings to another script follow its rendered name.
  if (c.workflows)
    c.workflows = c.workflows.map((w: Config) => ({
      ...w,
      name: `${w.name}${d.suffix}`,
      ...(w.script_name ? { script_name: n.engine } : {}),
    }));
  if (c.durable_objects?.bindings)
    c.durable_objects.bindings = c.durable_objects.bindings.map((b: Config) =>
      b.script_name ? { ...b, script_name: n.engine } : b,
    );
  if (c.services)
    c.services = c.services.map((s: Config) =>
      s.binding === 'API'
        ? { ...s, service: n.api }
        : s.binding === 'DELIVERY'
          ? { ...s, service: n.delivery }
          : s,
    );
  // Rate-limit namespaces are account-wide: slot 1 keeps the base ids (1001…), slot 2 2001…
  if (c.ratelimits)
    c.ratelimits = c.ratelimits.map((r: Config) => ({
      ...r,
      namespace_id: String(d.slot * 1000 + (Number(r.namespace_id) % 1000)),
    }));
  if (c.vars) {
    if ('AI_GATEWAY_ID' in c.vars) {
      c.vars.AI_GATEWAY_ID = n.aiGateway;
      c.vars.AI_GATEWAY_LOGS = String(d.aiGatewayLogs);
    }
    if ('MEDIA_BASE_URL' in c.vars) c.vars.MEDIA_BASE_URL = `https://${hosts(d).api}`;
    if ('MEDIA_PUBLIC_URL' in c.vars) c.vars.MEDIA_PUBLIC_URL = `https://${hosts(d).media}`;
    if ('QUEUE_SUFFIX' in c.vars) c.vars.QUEUE_SUFFIX = d.suffix;
    // Only Workers that bind Durable Objects need the jurisdiction (web binds none).
    if (d.jurisdiction && app !== 'web') c.vars.DATA_JURISDICTION = d.jurisdiction;
    // A demo mocks every model and has no vector index: those fakes are its point, so it allows
    // them (a persistent deployment refuses fakes it doesn't allow).
    if (d.demo && app !== 'web') {
      c.vars.AI_MODE = 'mock';
      c.vars.AI_GATEWAY_ID = '';
      c.vars.ALLOW_FAKE_ADAPTERS = 'ai,vectors';
    }
  }
  return c;
}

/** The deployment's Email Sending sender, on a Worker that sends mail. */
function withEmail(c: Config, d: Deployment): Config {
  if (d.email) {
    c.send_email = [{ name: 'EMAIL' }];
    c.vars = { ...c.vars, EMAIL_FROM: d.email.from, EMAIL_FROM_NAME: d.email.fromName ?? '' };
  }
  return c;
}

export function renderEngine(base: Config, d: Deployment): Config {
  return withEmail(common(base, d, 'engine'), d);
}

export function renderApi(base: Config, d: Deployment): Config {
  const c = common(base, d, 'api');
  c.routes = [{ pattern: hosts(d).api, custom_domain: true }];
  // OAuth for MCP clients is served on the admin's origin: the consent screen needs the person's
  // web session (the gateway forwards /oauth/* and /mcp with the signed principal).
  c.vars = { ...c.vars, OAUTH_ISSUER: `https://${hosts(d).web}` };
  return c;
}

export function renderMedia(base: Config, d: Deployment): Config {
  const c = common(base, d, 'media');
  c.routes = [{ pattern: hosts(d).media, custom_domain: true }];
  return c;
}

export function renderDelivery(base: Config, d: Deployment): Config {
  const c = common(base, d, 'delivery');
  c.routes = [{ pattern: hosts(d).delivery, custom_domain: true }];
  return c;
}

export function renderWeb(base: Config, d: Deployment): Config {
  const c = common(base, d, 'web');
  c.routes = [{ pattern: hosts(d).web, custom_domain: true }];
  if (d.sso)
    c.vars = {
      ...c.vars,
      OIDC_ISSUER: d.sso.issuer,
      OIDC_CLIENT_ID: d.sso.clientId,
      OIDC_TRUST_EMAIL: d.sso.trustEmail ? 'true' : '',
    };
  // Password reset codes (apps/web/app/lib/password-reset.server.ts).
  return withEmail(c, d);
}

const RENDER: Record<App, (base: Config, d: Deployment) => Config> = {
  engine: renderEngine,
  api: renderApi,
  media: renderMedia,
  delivery: renderDelivery,
  web: renderWeb,
};

function byId(id: string | undefined): Deployment {
  const d = loadDeployments().find((x) => x.id === id);
  if (!d) throw new Error(`no deployment ${JSON.stringify(id)} in deployments/`);
  return d;
}

function render(id: string | undefined) {
  const d = byId(id);
  for (const app of APPS) {
    const out = join(ROOT, 'apps', app, `wrangler.${d.id}.json`);
    const config = RENDER[app](readJsonc(join(ROOT, 'apps', app, 'wrangler.jsonc')), d);
    writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
    console.log(out);
  }
}

/** `{ staging: [...], internal: [...], ... }`, held deployments left out. */
export function matrix(list: Deployment[]): Record<Ring, Deployment[]> {
  const unprovisioned = list.filter((d) => !d.hold && (!d.d1Id || !d.kvId)).map((d) => d.id);
  if (unprovisioned.length)
    throw new Error(
      `not provisioned (no d1Id or kvId): ${unprovisioned.join(', ')}; provision or hold them`,
    );
  return Object.fromEntries(
    RINGS.map((ring) => [ring, list.filter((d) => d.ring === ring && !d.hold)]),
  ) as Record<Ring, Deployment[]>;
}

function secrets(app: string | undefined, out: string | undefined) {
  if (!app || !(APPS as readonly string[]).includes(app) || !out)
    throw new Error(`secrets <${APPS.join('|')}> <out>`);
  const missing = REQUIRED_SECRETS.filter((k) => !process.env[k]);
  if (missing.length)
    throw new Error(
      `${missing.join(', ')} not set: add it to the deployment's GitHub environment (scripts/provision.sh generates them)`,
    );
  const short = keysProblem(process.env);
  if (short) throw new Error(short);
  const env = withDerived(process.env);
  // Only the ones set: `--secrets-file` adds to a Worker's secrets and never removes one.
  const values = Object.fromEntries(
    SECRETS[app as App].flatMap((k) => (env[k] ? [[k, env[k]]] : [])),
  );
  writeFileSync(out, JSON.stringify(values), { mode: 0o600 });
  console.log(`${app}: ${Object.keys(values).join(', ') || 'no secrets set'}`);
}

/** Resource names for scripts/provision.sh. */
export function shellVars(d: Deployment): Record<string, string> {
  const n = names(d);
  const h = hosts(d);
  return {
    D1: n.d1,
    KV: n.kv,
    MEDIA: n.media,
    VECTORS: d.demo ? '' : n.vectors,
    AI_GATEWAY: n.aiGateway,
    QUEUES: [
      'contentworker-events',
      'contentworker-events-dlq',
      'contentworker-bulk',
      'contentworker-agents',
      'contentworker-purge',
      'contentworker-purge-dlq',
      'contentworker-media-purge',
      'contentworker-media-purge-dlq',
      'contentworker-asset-events',
      'contentworker-asset-events-dlq',
    ]
      .map(n.queue)
      .join(' '),
    // The queue the media bucket's object-create notifications go to (asset ingest).
    ASSET_EVENTS: n.queue('contentworker-asset-events'),
    DOMAIN: h.web,
    API_DOMAIN: h.api,
    CDN_DOMAIN: h.delivery,
    MEDIA_DOMAIN: h.media,
    ENVIRONMENT: d.environment,
    JURISDICTION: d.jurisdiction ?? '',
    AI_GATEWAY_LOGS: String(d.aiGatewayLogs),
    SUFFIX: d.suffix,
  };
}

function setField(id: string | undefined, field: 'd1Id' | 'kvId', value: string) {
  const d = byId(id);
  const file = join(ROOT, 'deployments', `${d.id}.jsonc`);
  const text = readFileSync(file, 'utf8');
  const edits = modify(text, [field], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  writeFileSync(file, applyEdits(text, edits));
}

async function status() {
  for (const d of loadDeployments()) {
    let health = 'unreachable';
    try {
      const r = await fetch(`https://${d.domain}/health/deep`, {
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await r.json()) as { ok: boolean; checks: Record<string, string> };
      const failed = Object.entries(body.checks)
        .filter(([, s]) => s !== 'ok')
        .map(([k]) => k);
      health = body.ok ? 'ok' : `fail (${failed.join(', ')})`;
    } catch {}
    const flags = [d.hold && 'hold', d.jurisdiction].filter(Boolean).join(' ');
    console.log([d.id.padEnd(16), d.ring.padEnd(9), d.domain.padEnd(32), health, flags].join(' '));
  }
}

// --- doctor ------------------------------------------------------------------------------------

/** One thing `doctor` found: an `error` fails it, a `warn` is worth a look, `ok` is a pass. */
export type Finding = { level: 'ok' | 'warn' | 'error'; app: App | 'fleet'; message: string };

/**
 * The bindings each app's code reads and can't run without, by binding name. The base configs
 * hold them today; this catches a template edit (or a render) that drops one before a deploy
 * finds out. Vectorize is left out for a demo, and EMAIL is added for a deployment with a sender.
 */
export const REQUIRED_BINDINGS: Record<App, readonly string[]> = {
  engine: [
    'DB',
    'KV_CACHE',
    'MEDIA_BUCKET',
    'METRICS',
    'AI',
    'VECTORIZE',
    'EVENTS_QUEUE',
    'BULK_QUEUE',
    'AGENTS_QUEUE',
    'PURGE_QUEUE',
    'MEDIA_PURGE_QUEUE',
    'ASSET_EVENTS_QUEUE',
    'LIVE_HUB',
    'AI_BUDGET',
    'SEARCH',
    'ASSISTANT_AGENT',
    'AGENT_WF',
    'EDITORIAL_WF',
    'ASSET_INGEST_WF',
    'ASSET_ZIP_WF',
  ],
  media: ['DB', 'KV_CACHE', 'MEDIA_BUCKET'],
  api: [
    'DB',
    'KV_CACHE',
    'MEDIA_BUCKET',
    'METRICS',
    'AI',
    'VECTORIZE',
    'EVENTS_QUEUE',
    'BULK_QUEUE',
    'AGENTS_QUEUE',
    'ASSET_EVENTS_QUEUE',
    'LIVE_HUB',
    'AUTH_LIMITER',
    'AI_BUDGET',
    'SEARCH',
    'ASSISTANT_AGENT',
    'AGENT_WF',
    'EDITORIAL_WF',
    'RATE_LIMIT_READ',
    'RATE_LIMIT_WRITE',
    'RATE_LIMIT_AI',
  ],
  delivery: [
    'DB',
    'KV_CACHE',
    'MEDIA_BUCKET',
    'VECTORIZE',
    'LIVE_HUB',
    'SEARCH',
    'RATE_LIMIT_READ',
  ],
  web: ['DB', 'API', 'DELIVERY', 'API_LIMIT'],
};

/** The queues the engine must consume (base names): without one, its producers fill it forever. */
const ENGINE_CONSUMES = [
  'contentworker-events',
  'contentworker-bulk',
  'contentworker-agents',
  'contentworker-asset-events',
];

/** The cron the scheduler heartbeat expects: every minute (stale after five missed ticks). */
export const ENGINE_CRON = '* * * * *';

/** Every binding name a rendered config declares. */
export function bindingNames(c: Config): Set<string> {
  const out = new Set<string>();
  const add = (list: unknown, key = 'binding') => {
    if (Array.isArray(list)) for (const b of list) if (b?.[key]) out.add(b[key]);
  };
  add(c.d1_databases);
  add(c.kv_namespaces);
  add(c.r2_buckets);
  add(c.vectorize);
  add(c.analytics_engine_datasets);
  add(c.worker_loaders);
  add(c.services);
  add(c.workflows);
  add(c.queues?.producers);
  add(c.durable_objects?.bindings, 'name');
  add(c.ratelimits, 'name');
  add(c.send_email, 'name');
  for (const single of ['ai', 'images', 'stream'] as const)
    if (c[single]?.binding) out.add(c[single].binding);
  return out;
}

/** The Durable Object classes a config's migrations leave defined. */
function definedClasses(c: Config): Set<string> {
  const out = new Set<string>();
  for (const m of (c.migrations ?? []) as Config[]) {
    for (const k of ['new_classes', 'new_sqlite_classes'])
      for (const name of m[k] ?? []) out.add(name);
    for (const r of m.renamed_classes ?? []) {
      out.delete(r.from);
      out.add(r.to);
    }
    for (const name of m.deleted_classes ?? []) out.delete(name);
  }
  return out;
}

/**
 * Read-only checks that a deployment's rendered configs are complete and agree with each other:
 * provisioned ids, the bindings each app needs, the engine's cron and queue consumers, every
 * cross-script Durable Object and Workflow binding naming this deployment's engine and a class it
 * defines, routes on the deployment's hosts, and which secrets its GitHub environment must hold.
 * `bases` are the apps' wrangler.jsonc, parsed. No network: `doctorHealth` is the part that asks.
 */
export function doctor(d: Deployment, bases: Record<App, Config>): Finding[] {
  const findings: Finding[] = [];
  const error = (app: Finding['app'], message: string) =>
    findings.push({ level: 'error', app, message });
  const warn = (app: Finding['app'], message: string) =>
    findings.push({ level: 'warn', app, message });
  const ok = (app: Finding['app'], message: string) => findings.push({ level: 'ok', app, message });
  const n = names(d);

  if (d.hold) warn('fleet', 'held: CI skips this deployment');
  const rendered: Partial<Record<App, Config>> = {};
  for (const app of APPS) {
    try {
      rendered[app] = RENDER[app](bases[app], d);
    } catch (err) {
      error(app, `does not render: ${(err as Error).message}`);
    }
  }

  for (const app of APPS) {
    const c = rendered[app];
    if (!c) continue;
    const have = bindingNames(c);
    const need = REQUIRED_BINDINGS[app].filter((b) => !(d.demo && b === 'VECTORIZE'));
    if ((app === 'engine' || app === 'web') && d.email) need.push('EMAIL');
    const missing = need.filter((b) => !have.has(b));
    if (missing.length) error(app, `missing bindings: ${missing.join(', ')}`);
    else ok(app, `${need.length} required bindings present`);

    for (const db of c.d1_databases ?? [])
      if (db.database_id !== d.d1Id || db.database_name !== n.d1)
        error(app, `D1 ${db.binding} is not this deployment's database (${n.d1})`);
    for (const kv of c.kv_namespaces ?? [])
      if (kv.binding === 'KV_CACHE' && kv.id !== d.kvId)
        error(app, `KV_CACHE is not this deployment's namespace`);

    // Routes: each public Worker answers on its own host, as a custom domain.
    const host = {
      api: hosts(d).api,
      delivery: hosts(d).delivery,
      media: hosts(d).media,
      web: hosts(d).web,
    }[app as Exclude<App, 'engine'>];
    if (app === 'engine') {
      if (c.routes?.length) error(app, 'the engine has no route, yet one is set');
    } else if (!c.routes?.some((r: Config) => r.pattern === host && r.custom_domain)) {
      error(app, `no custom-domain route on ${host}`);
    }

    // Cross-script bindings: this deployment's engine, and a class or Workflow it defines.
    if (app !== 'engine' && rendered.engine) {
      const engine = rendered.engine;
      const classes = definedClasses(engine);
      for (const b of c.durable_objects?.bindings ?? []) {
        if (b.script_name !== n.engine)
          error(
            app,
            `Durable Object ${b.name} binds ${b.script_name ?? 'itself'}, not ${n.engine}`,
          );
        else if (!classes.has(b.class_name))
          error(app, `Durable Object ${b.name}: ${n.engine} defines no class ${b.class_name}`);
      }
      for (const w of c.workflows ?? []) {
        const owned = (engine.workflows ?? []).find((e: Config) => e.name === w.name);
        if (w.script_name !== n.engine)
          error(app, `Workflow ${w.binding} binds ${w.script_name ?? 'itself'}, not ${n.engine}`);
        else if (!owned || owned.class_name !== w.class_name)
          error(app, `Workflow ${w.binding}: ${n.engine} runs no ${w.name} (${w.class_name})`);
      }
    }
    if (app === 'engine') {
      const classes = definedClasses(c);
      for (const b of c.durable_objects?.bindings ?? [])
        if (b.script_name) error(app, `Durable Object ${b.name} points at ${b.script_name}`);
        else if (!classes.has(b.class_name))
          error(app, `Durable Object ${b.name}: no migration defines ${b.class_name}`);
      const crons: string[] = c.triggers?.crons ?? [];
      if (!crons.includes(ENGINE_CRON))
        error(
          app,
          `no "${ENGINE_CRON}" cron: the scheduler would never tick (and /health reads it stale)`,
        );
      else ok(app, `cron "${ENGINE_CRON}" (scheduler heartbeat)`);
      const consumed = new Set((c.queues?.consumers ?? []).map((q: Config) => q.queue));
      const unconsumed = ENGINE_CONSUMES.map(n.queue).filter((q) => !consumed.has(q));
      if (unconsumed.length) error(app, `consumes no ${unconsumed.join(', ')}`);
    }
    if (app === 'web') {
      for (const s of c.services ?? []) {
        const want =
          s.binding === 'API' ? n.api : s.binding === 'DELIVERY' ? n.delivery : undefined;
        if (want && s.service !== want)
          error(app, `service ${s.binding} binds ${s.service}, not ${want}`);
      }
    }

    // A secret declared as a plain var would ship in the config, or shadow the real one.
    const asVars = SECRETS[app].filter((k) => c.vars && k in c.vars);
    if (asVars.length) error(app, `secrets declared as plain vars: ${asVars.join(', ')}`);
  }

  // Secrets: what the deployment's GitHub environment must hold (derived ones come from another).
  const sources = new Set(Object.values(DERIVED).map((x) => x.from));
  const used = new Set(
    APPS.flatMap((a) => SECRETS[a]).flatMap((k) => (DERIVED[k] ? [DERIVED[k].from] : [k])),
  );
  const unused = REQUIRED_SECRETS.filter((k) => !used.has(k) && !sources.has(k));
  if (unused.length) error('fleet', `required secrets no Worker receives: ${unused.join(', ')}`);
  ok('fleet', `GitHub environment ${d.environment} must hold ${REQUIRED_SECRETS.join(', ')}`);
  if (d.sso) warn('fleet', `SSO is on: ${d.environment} must also hold OIDC_CLIENT_SECRET`);
  return findings;
}

/** What the api's `/health` says about the engine cron, as a finding. */
export function healthFinding(status: number | undefined, body: unknown, url: string): Finding {
  if (status === undefined) return { level: 'error', app: 'api', message: `${url} unreachable` };
  const scheduler = (body as { scheduler?: unknown } | null)?.scheduler;
  if (status !== 200) return { level: 'error', app: 'api', message: `${url} answered ${status}` };
  if (scheduler === 'ok') return { level: 'ok', app: 'engine', message: 'scheduler ticking' };
  if (scheduler === 'stale')
    return {
      level: 'error',
      app: 'engine',
      message:
        'scheduler stale: no cron tick in 5 minutes (GET /deployment/scheduler has each sweep)',
    };
  if (scheduler === 'unknown')
    return {
      level: 'warn',
      app: 'engine',
      message: 'scheduler unknown: the api could not read its heartbeat',
    };
  return { level: 'warn', app: 'api', message: `${url} reports no scheduler (an older api?)` };
}

/** Asks the deployment's api whether its cron is ticking. `fetchImpl` is the test's seam. */
export async function doctorHealth(
  d: Deployment,
  fetchImpl: typeof fetch = fetch,
  base = `https://${hosts(d).api}`,
): Promise<Finding> {
  const url = `${base.replace(/\/$/, '')}/health`;
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    return healthFinding(r.status, await r.json().catch(() => null), url);
  } catch {
    return healthFinding(undefined, null, url);
  }
}

function readBases(): Record<App, Config> {
  return Object.fromEntries(
    APPS.map((app) => [app, readJsonc(join(ROOT, 'apps', app, 'wrangler.jsonc'))]),
  ) as Record<App, Config>;
}

/**
 * `doctor <id> [--offline] [--url <api base>]`: the config checks, then (unless offline, and
 * only for a provisioned deployment CI deploys, or the URL given) the api's health. Exits 1 on
 * any error.
 */
async function runDoctor(args: string[]) {
  const urlAt = args.indexOf('--url');
  const url = urlAt >= 0 ? args[urlAt + 1] : undefined;
  const id = args.filter((a, i) => !a.startsWith('--') && !(urlAt >= 0 && i === urlAt + 1))[0];
  const d = byId(id);
  const findings = doctor(d, readBases());
  if (!args.includes('--offline') && (url || (d.d1Id && !d.hold)))
    findings.push(await doctorHealth(d, fetch, url));
  const mark = { ok: 'ok   ', warn: 'warn ', error: 'ERROR' } as const;
  for (const f of findings) console.log(`${mark[f.level]} ${f.app.padEnd(8)} ${f.message}`);
  if (findings.some((f) => f.level === 'error')) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (cmd === 'render') render(args[0]);
    else if (cmd === 'matrix') console.log(JSON.stringify(matrix(loadDeployments())));
    else if (cmd === 'secrets') secrets(args[0], args[1]);
    else if (cmd === 'status') await status();
    else if (cmd === 'doctor') await runDoctor(args);
    else if (cmd === 'names')
      for (const [k, v] of Object.entries(shellVars(byId(args[0])))) console.log(`${k}='${v}'`);
    else if (cmd === 'set-d1') {
      if (!args[1] || !/^[0-9a-f-]{36}$/.test(args[1])) throw new Error('set-d1 <id> <uuid>');
      setField(args[0], 'd1Id', args[1]);
    } else if (cmd === 'set-kv') {
      if (!args[1] || !/^[0-9a-f]{32}$/.test(args[1])) throw new Error('set-kv <id> <kv id>');
      setField(args[0], 'kvId', args[1]);
    } else if (cmd === 'demos')
      console.log(JSON.stringify(loadDeployments().filter((d) => d.demo && d.d1Id)));
    else
      throw new Error(
        'usage: fleet.ts render|matrix|secrets|status|doctor|names|set-d1|set-kv|demos',
      );
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
