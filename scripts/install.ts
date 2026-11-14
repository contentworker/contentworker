/**
 * One ContentWorker install: its settings, resource names and the Workers' deploy configs.
 *
 * An install is one stack in your Cloudflare account: a D1 database, a KV namespace, an R2 bucket,
 * a Vectorize index, queues, an AI Gateway and five Workers (engine, media, api, delivery, web).
 * Its settings come from the environment, then from a dotenv file (`.env` by default; a variable
 * already set wins), so the same names work on a workstation and as CI variables. See
 * docs/deployment.md.
 *
 *   node scripts/install.ts render [--settings <path>]          write apps/<app>/wrangler.deploy.json
 *                                                               (wrangler.deploy-<instance>.json)
 *   node scripts/install.ts names [--settings <path>]           resource names as shell variables
 *   node scripts/install.ts secrets <app> <out> [--settings …]  write that app's secrets file (JSON)
 *
 * A rendered config is the app's wrangler.jsonc with the install's names, ids, hosts and vars put
 * in, written next to it so its relative paths still resolve. Deploy order: engine first (it owns
 * the Durable Object and Workflow classes the others bind by script name), then media (so it
 * verifies the URLs the api and delivery hand out before they hand them out), api, delivery, web.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { type ParseError, parse, printParseErrorCode } from 'jsonc-parser';
import { deriveAssistantKey } from './derive-assistant-key.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The Workers an install runs, in deploy order. */
export const APPS = ['engine', 'media', 'api', 'delivery', 'web'] as const;
export type App = (typeof APPS)[number];

type Env = Record<string, string | undefined>;

/** Each app's secrets, read from the environment or the install's secrets file. */
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

/** Every secret name any Worker reads, derived ones excluded. */
export const SECRET_NAMES = [...new Set(Object.values(SECRETS).flat())].filter(
  (k) => !k.startsWith('ASSISTANT_'),
);

/**
 * Secrets nobody sets: `secrets` derives each from the one named, so rotating that one rotates it
 * (the previous from the previous). The assistant's principal key is HKDF of PRINCIPAL_KEY
 * (`deriveAssistantPrincipalKey` in @contentworker/security).
 */
export const DERIVED: Record<string, { from: string; derive: (secret: string) => string }> = {
  ASSISTANT_PRINCIPAL_KEY: { from: 'PRINCIPAL_KEY', derive: deriveAssistantKey },
  ASSISTANT_PRINCIPAL_KEY_PREVIOUS: { from: 'PRINCIPAL_KEY_PREVIOUS', derive: deriveAssistantKey },
};

/** The environment with the derived secrets added (never echoed). */
export function withDerived(env: Env) {
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
 * engine checks too); DATA_KEY seals secrets at rest; TOKEN_PEPPER is in every API key hash;
 * MEDIA_SIGNING_SECRET signs media URLs.
 */
export const REQUIRED_SECRETS = [
  'PRINCIPAL_KEY',
  'DATA_KEY',
  'TOKEN_PEPPER',
  'MEDIA_SIGNING_SECRET',
];

/** The secrets `scripts/setup.sh` generates for a new install. */
export const GENERATED_SECRETS = [...REQUIRED_SECRETS, 'PASSWORD_PEPPER', 'SETUP_TOKEN'];

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

export function keysProblem(env: Env): string | null {
  const short = KEYS.filter((k) => env[k] && env[k]!.length < MIN_KEY_LENGTH);
  return short.length
    ? `${short.join(', ')} must be at least ${MIN_KEY_LENGTH} characters (openssl rand -hex 32)`
    : null;
}

export type Tier = 'flagship' | 'balanced' | 'fast';

export type Install = {
  /** The admin's host. The api is `api.<domain>`, delivery `cdn.<domain>`, media `media.<domain>`. */
  domain: string;
  /** Set to run a second install in the same account: appended to every resource name as `-<name>`. */
  instance: string;
  /** Keeps two installs' rate-limit namespaces apart (`slot × 1000 + n`). Default 1. */
  slot: number;
  /** Data location for D1, R2 and Durable Objects, set when they're created. */
  jurisdiction?: 'eu' | 'fedramp';
  /** Whether the AI Gateway keeps request logs (never prompts or answers). */
  aiGatewayLogs: boolean;
  /** The most capable model tier the install runs, rendered as AI_MAX_TIER. Default: no cap. */
  aiMaxTier?: Tier;
  /** Models mocked, no AI Gateway and no Vectorize index: for evaluation without AI costs. */
  aiMock: boolean;
  /** Offers the enterprise sample starter when a space is created. */
  demoStarters: boolean;
  /** Your OIDC provider for admin single sign-on (secret: OIDC_CLIENT_SECRET). */
  sso?: { issuer: string; clientId: string; trustEmail?: boolean };
  /** Email Sending sender for notifications, invitations and password reset codes. */
  email?: { from: string; fromName?: string };
  /** Resolved at deploy time from the names (scripts/deploy.sh); required to render. */
  d1Id?: string;
  kvId?: string;
};

const HOST_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;
const INSTANCE_RE = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,30}$/;
const TRUE = (v: string | undefined) => v === 'true' || v === '1';

/** The install's settings, from the environment. */
export function toInstall(env: Env): Install {
  const fail = (msg: string): never => {
    throw new Error(msg);
  };
  const domain = env.DOMAIN?.trim().toLowerCase();
  if (!domain || !HOST_RE.test(domain))
    fail('DOMAIN must be the admin host name, on a zone in your Cloudflare account (cms.example.com)');
  const instance = env.INSTANCE?.trim() ?? '';
  if (instance && !INSTANCE_RE.test(instance))
    fail('INSTANCE must be lowercase letters, digits and dashes, starting with a letter');
  const slotText = env.RATE_LIMIT_SLOT?.trim() || '1';
  const slot = Number(slotText);
  if (!/^\d+$/.test(slotText) || slot < 1 || slot > 999)
    fail('RATE_LIMIT_SLOT must be an integer from 1 to 999');
  const jurisdiction = env.DATA_JURISDICTION?.trim() || undefined;
  if (jurisdiction && jurisdiction !== 'eu' && jurisdiction !== 'fedramp')
    fail('DATA_JURISDICTION must be "eu" or "fedramp"');
  const aiMaxTier = env.AI_MAX_TIER?.trim() || undefined;
  if (aiMaxTier && !['flagship', 'balanced', 'fast'].includes(aiMaxTier))
    fail('AI_MAX_TIER must be "flagship", "balanced" or "fast"');
  const aiMode = env.AI_MODE?.trim() || undefined;
  if (aiMode && aiMode !== 'mock') fail('AI_MODE must be "mock" or unset');
  const issuer = env.OIDC_ISSUER?.trim();
  const clientId = env.OIDC_CLIENT_ID?.trim();
  if ((issuer || clientId) && (!issuer || !/^https:\/\/\S+$/.test(issuer)))
    fail("OIDC_ISSUER must be the identity provider's https issuer URL");
  if (issuer && !clientId) fail('OIDC_CLIENT_ID must be the client id the provider issued');
  const from = env.EMAIL_FROM?.trim();
  if (from && !/^[^@\s]+@[^@\s]+$/.test(from))
    fail('EMAIL_FROM must be an address on a domain onboarded to Email Sending');
  const d1Id = env.D1_ID?.trim() || undefined;
  if (d1Id && !/^[0-9a-f-]{36}$/.test(d1Id)) fail("D1_ID must be the D1 database's id");
  const kvId = env.KV_ID?.trim() || undefined;
  if (kvId && !/^[0-9a-f]{32}$/.test(kvId)) fail("KV_ID must be the KV namespace's 32-character id");
  return {
    domain: domain as string,
    instance,
    slot,
    ...(jurisdiction ? { jurisdiction: jurisdiction as 'eu' | 'fedramp' } : {}),
    aiGatewayLogs: TRUE(env.AI_GATEWAY_LOGS),
    ...(aiMaxTier ? { aiMaxTier: aiMaxTier as Tier } : {}),
    aiMock: aiMode === 'mock',
    demoStarters: TRUE(env.DEMO_STARTERS),
    ...(issuer && clientId
      ? { sso: { issuer, clientId, ...(TRUE(env.OIDC_TRUST_EMAIL) ? { trustEmail: true } : {}) } }
      : {}),
    ...(from
      ? { email: { from, ...(env.EMAIL_FROM_NAME ? { fromName: env.EMAIL_FROM_NAME } : {}) } }
      : {}),
    ...(d1Id ? { d1Id } : {}),
    ...(kvId ? { kvId } : {}),
  };
}

/** A dotenv file's values, or nothing when it doesn't exist. */
export function readEnvFile(path: string): Env {
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
}

/** Where the install's generated secrets live (gitignored): one file per instance. */
export const secretsFile = (instance: string, root = ROOT) =>
  join(root, '.secrets', instance ? `secrets-${instance}.env` : 'secrets.env');

/** Only the variables with a value: an empty one (an unset CI variable) counts as unset. */
const set = (env: Env): Env => Object.fromEntries(Object.entries(env).filter(([, v]) => v));

/**
 * The settings file's values under the process environment (a variable already set wins), then
 * the install's secrets file under both.
 */
export function loadEnv(envFile: string, env: Env = process.env, root = ROOT): Env {
  const settings = { ...set(readEnvFile(resolve(root, envFile))), ...set(env) };
  const instance = settings.INSTANCE?.trim() ?? '';
  return { ...set(readEnvFile(secretsFile(instance, root))), ...settings };
}

const suffix = (i: Install) => (i.instance ? `-${i.instance}` : '');

/** Account-wide names: the base name plus the instance's suffix. */
export const names = (i: Install) => {
  const s = suffix(i);
  return {
    web: `contentworker-web${s}`,
    api: `contentworker-api${s}`,
    engine: `contentworker-engine${s}`,
    delivery: `contentworker-delivery${s}`,
    // The media Worker shares its base name with the bucket (Workers and buckets are named apart).
    mediaWorker: `contentworker-media${s}`,
    d1: `contentworker${s}`,
    kv: `contentworker-cache${s}`,
    media: `contentworker-media${s}`,
    vectors: `contentworker-vectors${s}`,
    aiGateway: `contentworker${s}`,
    queue: (q: string) => `${q}${s}`,
    // Analytics Engine dataset names allow letters, digits and underscores.
    dataset: `contentworker_metrics${s.replaceAll('-', '_')}`,
  };
};

export const hosts = (i: Install) => ({
  web: i.domain,
  api: `api.${i.domain}`,
  delivery: `cdn.${i.domain}`,
  media: `media.${i.domain}`,
});

// biome-ignore lint/suspicious/noExplicitAny: wrangler config is open-ended JSON
type Config = Record<string, any>;

/** Everything account-wide every app may bind, renamed for the install. */
function common(base: Config, i: Install, app: App): Config {
  if (!i.d1Id) throw new Error('no D1_ID: run scripts/setup.sh, then deploy with scripts/deploy.sh');
  if (!i.kvId && app !== 'web')
    throw new Error('no KV_ID: run scripts/setup.sh, then deploy with scripts/deploy.sh');
  const n = names(i);
  const s = suffix(i);
  const c = structuredClone(base);
  c.name = app === 'media' ? n.mediaWorker : n[app];
  c.workers_dev = false;
  c.preview_urls = false;
  c.d1_databases = (c.d1_databases ?? []).map((db: Config) => ({
    ...db,
    database_name: n.d1,
    database_id: i.d1Id,
  }));
  if (c.kv_namespaces)
    c.kv_namespaces = c.kv_namespaces.map((k: Config) =>
      k.binding === 'KV_CACHE' ? { ...k, id: i.kvId } : k,
    );
  if (c.r2_buckets)
    c.r2_buckets = c.r2_buckets.map((b: Config) => ({
      ...b,
      bucket_name: n.media,
      ...(i.jurisdiction ? { jurisdiction: i.jurisdiction } : {}),
    }));
  if (c.vectorize) {
    if (i.aiMock) delete c.vectorize;
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
      name: `${w.name}${s}`,
      ...(w.script_name ? { script_name: n.engine } : {}),
    }));
  if (c.durable_objects?.bindings)
    c.durable_objects.bindings = c.durable_objects.bindings.map((b: Config) =>
      b.script_name ? { ...b, script_name: n.engine } : b,
    );
  if (c.services)
    c.services = c.services.map((sv: Config) =>
      sv.binding === 'API'
        ? { ...sv, service: n.api }
        : sv.binding === 'DELIVERY'
          ? { ...sv, service: n.delivery }
          : sv,
    );
  // Rate-limit namespaces are account-wide: slot 1 keeps the base ids (1001…), slot 2 2001…
  if (c.ratelimits)
    c.ratelimits = c.ratelimits.map((r: Config) => ({
      ...r,
      namespace_id: String(i.slot * 1000 + (Number(r.namespace_id) % 1000)),
    }));
  if (c.vars) {
    if ('AI_GATEWAY_ID' in c.vars) {
      c.vars.AI_GATEWAY_ID = n.aiGateway;
      c.vars.AI_GATEWAY_LOGS = String(i.aiGatewayLogs);
    }
    // The tier cap goes wherever models are called (the api and the engine); unset, none.
    if ('AI_MAX_TIER' in c.vars) c.vars.AI_MAX_TIER = i.aiMaxTier ?? '';
    if ('MEDIA_BASE_URL' in c.vars) c.vars.MEDIA_BASE_URL = `https://${hosts(i).api}`;
    if ('MEDIA_PUBLIC_URL' in c.vars) c.vars.MEDIA_PUBLIC_URL = `https://${hosts(i).media}`;
    if ('QUEUE_SUFFIX' in c.vars) c.vars.QUEUE_SUFFIX = s;
    if ('DEMO_STARTERS' in c.vars) c.vars.DEMO_STARTERS = String(i.demoStarters);
    // Only Workers that bind Durable Objects need the jurisdiction (web binds none).
    if (i.jurisdiction && app !== 'web') c.vars.DATA_JURISDICTION = i.jurisdiction;
    // Mocked models and no vector index: the fakes are the point, so they're allowed (a
    // persistent install refuses fakes it doesn't allow).
    if (i.aiMock && app !== 'web') {
      c.vars.AI_MODE = 'mock';
      c.vars.AI_GATEWAY_ID = '';
      c.vars.ALLOW_FAKE_ADAPTERS = 'ai,vectors';
    }
  }
  return c;
}

/** The install's Email Sending sender, on a Worker that sends mail. */
function withEmail(c: Config, i: Install): Config {
  if (i.email) {
    c.send_email = [{ name: 'EMAIL' }];
    c.vars = { ...c.vars, EMAIL_FROM: i.email.from, EMAIL_FROM_NAME: i.email.fromName ?? '' };
  }
  return c;
}

export function renderEngine(base: Config, i: Install): Config {
  return withEmail(common(base, i, 'engine'), i);
}

export function renderApi(base: Config, i: Install): Config {
  const c = common(base, i, 'api');
  c.routes = [{ pattern: hosts(i).api, custom_domain: true }];
  // OAuth for MCP clients is served on the admin's origin: the consent screen needs the person's
  // web session (the gateway forwards /oauth/* and /mcp with the signed principal).
  c.vars = { ...c.vars, OAUTH_ISSUER: `https://${hosts(i).web}` };
  return c;
}

export function renderMedia(base: Config, i: Install): Config {
  const c = common(base, i, 'media');
  c.routes = [{ pattern: hosts(i).media, custom_domain: true }];
  return c;
}

export function renderDelivery(base: Config, i: Install): Config {
  const c = common(base, i, 'delivery');
  c.routes = [{ pattern: hosts(i).delivery, custom_domain: true }];
  return c;
}

export function renderWeb(base: Config, i: Install): Config {
  const c = common(base, i, 'web');
  c.routes = [{ pattern: hosts(i).web, custom_domain: true }];
  if (i.sso)
    c.vars = {
      ...c.vars,
      OIDC_ISSUER: i.sso.issuer,
      OIDC_CLIENT_ID: i.sso.clientId,
      OIDC_TRUST_EMAIL: i.sso.trustEmail ? 'true' : '',
    };
  // Password reset codes (apps/web/app/lib/password-reset.server.ts).
  return withEmail(c, i);
}

export const RENDER: Record<App, (base: Config, i: Install) => Config> = {
  engine: renderEngine,
  api: renderApi,
  media: renderMedia,
  delivery: renderDelivery,
  web: renderWeb,
};

export function readJsonc(path: string): Config {
  const errors: ParseError[] = [];
  const value = parse(readFileSync(path, 'utf8'), errors, { allowTrailingComma: true });
  if (errors.length)
    throw new Error(`${path}: ${errors.map((e) => printParseErrorCode(e.error)).join(', ')}`);
  return value as Config;
}

/** The rendered config each Worker deploys from (gitignored), one per instance. */
export const deployConfig = (i: Install) =>
  i.instance ? `wrangler.deploy-${i.instance}.json` : 'wrangler.deploy.json';

function render(i: Install) {
  for (const app of APPS) {
    const out = join(ROOT, 'apps', app, deployConfig(i));
    const config = RENDER[app](readJsonc(join(ROOT, 'apps', app, 'wrangler.jsonc')), i);
    writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
    console.log(out);
  }
}

/** Resource names and hosts for scripts/setup.sh and scripts/deploy.sh. */
export function shellVars(i: Install): Record<string, string> {
  const n = names(i);
  const h = hosts(i);
  return {
    WEB: n.web,
    API: n.api,
    D1: n.d1,
    KV: n.kv,
    MEDIA: n.media,
    VECTORS: i.aiMock ? '' : n.vectors,
    AI_GATEWAY: i.aiMock ? '' : n.aiGateway,
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
    JURISDICTION: i.jurisdiction ?? '',
    AI_GATEWAY_LOGS: String(i.aiGatewayLogs),
    SECRETS_FILE: secretsFile(i.instance),
    DEPLOY_CONFIG: deployConfig(i),
  };
}

function secrets(app: string | undefined, out: string | undefined, env: Env) {
  if (!app || !(APPS as readonly string[]).includes(app) || !out)
    throw new Error(`secrets <${APPS.join('|')}> <out>`);
  const missing = REQUIRED_SECRETS.filter((k) => !env[k]);
  if (missing.length)
    throw new Error(
      `${missing.join(', ')} not set: run scripts/setup.sh, which generates them, or set them in the environment`,
    );
  const short = keysProblem(env);
  if (short) throw new Error(short);
  const all = withDerived(env);
  // Only the ones set: `--secrets-file` adds to a Worker's secrets and never removes one.
  const values = Object.fromEntries(
    SECRETS[app as App].flatMap((k) => (all[k] ? [[k, all[k]]] : [])),
  );
  writeFileSync(out, JSON.stringify(values), { mode: 0o600 });
  console.log(`${app}: ${Object.keys(values).join(', ') || 'no secrets set'}`);
}

/** `--settings <path>` (a dotenv file; node itself claims `--env-file`) from the arguments, and the rest. */
export function envFileArg(args: string[]): { envFile: string; rest: string[] } {
  const at = args.indexOf('--settings');
  if (at < 0) return { envFile: '.env', rest: args };
  const envFile = args[at + 1];
  if (!envFile) throw new Error('--settings needs a path');
  return { envFile, rest: args.filter((_, k) => k !== at && k !== at + 1) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    const { envFile, rest } = envFileArg(args);
    const env = loadEnv(envFile);
    if (cmd === 'render') render(toInstall(env));
    else if (cmd === 'secrets') secrets(rest[0], rest[1], env);
    else if (cmd === 'names')
      for (const [k, v] of Object.entries(shellVars(toInstall(env)))) console.log(`${k}='${v}'`);
    else throw new Error('usage: install.ts render|names|secrets [--settings <path>]');
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
