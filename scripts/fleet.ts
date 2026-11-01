/**
 * The fleet: one contentworker deployment per customer, each listed in deployments/<id>.jsonc,
 * each with its own D1, KV, R2, Vectorize index, queues, Workflows, AI Gateway and Workers.
 *
 *   node scripts/fleet.ts render <id>          write apps/{web,api,engine,delivery}/wrangler.<id>.json
 *                                              (and apps/docs for the deployment that hosts docs)
 *   node scripts/fleet.ts matrix               the deployments of each ring, for CI
 *   node scripts/fleet.ts secrets <app> <out>  write this app's secrets from the environment
 *   node scripts/fleet.ts status               deep health of every deployment
 *   node scripts/fleet.ts names <id>           resource names as shell variables (provisioning)
 *   node scripts/fleet.ts set-d1 <id> <uuid>   record the D1 database id in the registry
 *   node scripts/fleet.ts set-kv <id> <kv id>  record the shared KV namespace id
 *   node scripts/fleet.ts demos                the provisioned demo deployments
 *
 * A rendered config is the app's wrangler.jsonc with the deployment's names, ids and hosts put in,
 * written next to it so its relative paths still resolve. Deploy order (CI): engine first (it owns
 * the Durable Object and Workflow classes the others bind by script name), then api, delivery, web.
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
export const APPS = ['engine', 'api', 'delivery', 'web'] as const;
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
  // derived for it (DERIVED below). TODO(assistant-key phase 2): drop PRINCIPAL_KEY and
  // PRINCIPAL_KEY_PREVIOUS here once every deployment has run phase 1 (docs/deployment.md).
  engine: [
    'ASSISTANT_PRINCIPAL_KEY',
    'ASSISTANT_PRINCIPAL_KEY_PREVIOUS',
    'PRINCIPAL_KEY',
    'PRINCIPAL_KEY_PREVIOUS',
    'DATA_KEY',
    'DATA_KEY_PREVIOUS',
    'TOKEN_PEPPER',
    'MEDIA_SIGNING_SECRET',
  ],
  delivery: ['DATA_KEY', 'DATA_KEY_PREVIOUS', 'TOKEN_PEPPER', 'MEDIA_SIGNING_SECRET'],
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
  /** The admin's host. Defaults to `<id>.contentworker.app`; the api is `api.<domain>`, delivery `cdn.<domain>`. */
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
  /** Email Sending sender for workflow `content.notify` nodes; adds the engine's EMAIL binding. */
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
  const dup = (key: (d: Deployment) => string | number) => {
    const seen = new Set<string | number>();
    for (const d of list) {
      if (seen.has(key(d))) return key(d);
      seen.add(key(d));
    }
    return undefined;
  };
  for (const [what, key] of [
    ['id', (d: Deployment) => d.id],
    ['slot', (d: Deployment) => d.slot],
    ['domain', (d: Deployment) => d.domain],
    ['suffix', (d: Deployment) => d.suffix],
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
});

type Config = Record<string, any>;

/** Everything account-wide every app may bind, renamed for the deployment. */
function common(base: Config, d: Deployment, app: App): Config {
  if (!d.d1Id) throw new Error(`${d.id} has no d1Id: run scripts/provision.sh ${d.id}`);
  if (!d.kvId && app !== 'web')
    throw new Error(`${d.id} has no kvId: run scripts/provision.sh ${d.id}`);
  const n = names(d);
  const c = structuredClone(base);
  c.name = n[app];
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

export function renderEngine(base: Config, d: Deployment): Config {
  const c = common(base, d, 'engine');
  if (d.email) {
    c.send_email = [{ name: 'EMAIL' }];
    c.vars = { ...c.vars, EMAIL_FROM: d.email.from, EMAIL_FROM_NAME: d.email.fromName ?? '' };
  }
  return c;
}

export function renderApi(base: Config, d: Deployment): Config {
  const c = common(base, d, 'api');
  c.routes = [{ pattern: hosts(d).api, custom_domain: true }];
  // OAuth for MCP clients is served on the admin's origin: the consent screen needs the person's
  // web session (the gateway forwards /oauth/* and /mcp with the signed principal).
  c.vars = { ...c.vars, OAUTH_ISSUER: `https://${hosts(d).web}` };
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
  return c;
}

const RENDER: Record<App, (base: Config, d: Deployment) => Config> = {
  engine: renderEngine,
  api: renderApi,
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
    ]
      .map(n.queue)
      .join(' '),
    DOMAIN: h.web,
    API_DOMAIN: h.api,
    CDN_DOMAIN: h.delivery,
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (cmd === 'render') render(args[0]);
    else if (cmd === 'matrix') console.log(JSON.stringify(matrix(loadDeployments())));
    else if (cmd === 'secrets') secrets(args[0], args[1]);
    else if (cmd === 'status') await status();
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
    else throw new Error('usage: fleet.ts render|matrix|secrets|status|names|set-d1|set-kv|demos');
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
