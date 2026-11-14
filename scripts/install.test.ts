import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseEnv } from 'node:util';
import { parse } from 'jsonc-parser';
import { deriveAssistantKey } from './derive-assistant-key.ts';
import {
  APPS,
  deployConfig,
  envFileArg,
  hosts,
  keysProblem,
  loadEnv,
  names,
  renderApi,
  renderDelivery,
  renderEngine,
  renderMedia,
  renderWeb,
  SECRET_NAMES,
  SECRETS,
  secretsFile,
  shellVars,
  toInstall,
} from './install.ts';

const ROOT = join(import.meta.dirname, '..');
const base = (app: string) =>
  parse(readFileSync(join(ROOT, 'apps', app, 'wrangler.jsonc'), 'utf8'));

const IDS = { D1_ID: '11111111-2222-3333-4444-555555555555', KV_ID: 'a'.repeat(32) };

/** A second install in the account: its own names, slot and jurisdiction. */
const acme = toInstall({
  DOMAIN: 'cms.acme.example',
  INSTANCE: 'acme',
  RATE_LIMIT_SLOT: '2',
  DATA_JURISDICTION: 'eu',
  ...IDS,
});

/** The usual install: the base names. */
const plain = toInstall({ DOMAIN: 'cms.example.com', ...IDS });

test('an install serves the admin on its domain and the rest under it', () => {
  assert.deepEqual(hosts(acme), {
    web: 'cms.acme.example',
    api: 'api.cms.acme.example',
    delivery: 'cdn.cms.acme.example',
    media: 'media.cms.acme.example',
  });
});

test('one install keeps the base names; a named instance carries its name everywhere', () => {
  const engine = renderEngine(base('engine'), plain);
  assert.equal(engine.name, 'contentworker-engine');
  assert.equal(engine.d1_databases[0].database_name, 'contentworker');
  assert.equal(engine.r2_buckets[0].bucket_name, 'contentworker-media');
  assert.equal(engine.vars.QUEUE_SUFFIX, '');
  assert.equal(deployConfig(plain), 'wrangler.deploy.json');

  const n = names(acme);
  const named = renderEngine(base('engine'), acme);
  assert.equal(named.name, 'contentworker-engine-acme');
  assert.deepEqual(
    named.workflows.map((w: { name: string }) => w.name),
    [
      'contentworker-agent-acme',
      'contentworker-editorial-acme',
      'contentworker-asset-ingest-acme',
      'contentworker-asset-zip-acme',
      'contentworker-app-operation-acme',
    ],
  );
  assert.equal(named.d1_databases[0].database_name, n.d1);
  assert.equal(named.d1_databases[0].database_id, IDS.D1_ID);
  assert.equal(named.kv_namespaces[0].id, IDS.KV_ID);
  assert.equal(named.r2_buckets[0].bucket_name, n.media);
  assert.equal(named.r2_buckets[0].jurisdiction, 'eu');
  assert.equal(named.vectorize[0].index_name, n.vectors);
  for (const q of named.queues.consumers) {
    assert.match(q.queue, /-acme$/);
    if (q.dead_letter_queue) assert.match(q.dead_letter_queue, /-acme$/);
  }
  for (const p of named.queues.producers) assert.match(p.queue, /-acme$/);
  assert.equal(named.vars.QUEUE_SUFFIX, '-acme');
  assert.equal(named.vars.DATA_JURISDICTION, 'eu');
  assert.equal(named.vars.AI_GATEWAY_ID, n.aiGateway);
  assert.equal(deployConfig(acme), 'wrangler.deploy-acme.json');
  assert.match(secretsFile('acme'), /\.secrets\/secrets-acme\.env$/);
  assert.match(secretsFile(''), /\.secrets\/secrets\.env$/);
});

test('the api, delivery and web Workers bind the install’s own engine and api', () => {
  const api = renderApi(base('api'), acme);
  for (const b of api.durable_objects.bindings) assert.equal(b.script_name, names(acme).engine);
  for (const w of api.workflows) {
    assert.equal(w.script_name, names(acme).engine);
    assert.match(w.name, /-acme$/);
  }
  assert.deepEqual(api.routes, [{ pattern: 'api.cms.acme.example', custom_domain: true }]);
  assert.equal(api.vars.OAUTH_ISSUER, 'https://cms.acme.example');
  assert.equal(api.vars.MEDIA_BASE_URL, 'https://api.cms.acme.example');

  const delivery = renderDelivery(base('delivery'), acme);
  for (const b of delivery.durable_objects.bindings)
    assert.equal(b.script_name, names(acme).engine);
  assert.equal(delivery.queues.consumers[0].queue, 'contentworker-purge-acme');
  assert.deepEqual(delivery.routes, [{ pattern: 'cdn.cms.acme.example', custom_domain: true }]);

  const web = renderWeb(base('web'), acme);
  const service = (b: string) =>
    web.services.find((s: { binding: string }) => s.binding === b).service;
  assert.equal(service('API'), names(acme).api);
  assert.equal(service('DELIVERY'), names(acme).delivery);
  assert.deepEqual(web.routes, [{ pattern: 'cms.acme.example', custom_domain: true }]);
});

test('the media Worker gets its own route, purge queue and the install’s media origin', () => {
  const media = renderMedia(base('media'), acme);
  assert.equal(media.name, 'contentworker-media-acme');
  assert.deepEqual(media.routes, [{ pattern: 'media.cms.acme.example', custom_domain: true }]);
  assert.equal(media.r2_buckets[0].bucket_name, names(acme).media);
  assert.equal(media.r2_buckets[0].jurisdiction, 'eu');
  assert.equal(media.kv_namespaces[0].id, IDS.KV_ID);
  assert.deepEqual(
    media.queues.consumers.map((q: { queue: string }) => q.queue),
    ['contentworker-media-purge-acme', 'contentworker-media-purge-dlq-acme'],
  );
  // Its cached entrypoint is never routable: only the gateway is the default export.
  assert.equal(media.exports.default.cache.enabled, false);
  assert.equal(media.exports.Media.cache.enabled, true);
  assert.deepEqual(SECRETS.media, ['MEDIA_SIGNING_SECRET']);
  for (const [app, render] of [
    ['api', renderApi],
    ['delivery', renderDelivery],
    ['engine', renderEngine],
  ] as const)
    assert.equal(render(base(app), acme).vars.MEDIA_PUBLIC_URL, 'https://media.cms.acme.example');
  assert.equal(shellVars(acme).MEDIA_DOMAIN, 'media.cms.acme.example');
});

test('asset ingest: the engine consumes the asset-events queue, and setup creates it', () => {
  const engine = renderEngine(base('engine'), acme);
  const consumer = engine.queues.consumers.find(
    (q: { queue: string }) => q.queue === 'contentworker-asset-events-acme',
  );
  assert.equal(consumer.dead_letter_queue, 'contentworker-asset-events-dlq-acme');
  const vars = shellVars(acme);
  assert.match(vars.QUEUES, /contentworker-asset-events-acme contentworker-asset-events-dlq-acme/);
  assert.match(vars.QUEUES, /contentworker-media-purge-acme contentworker-media-purge-dlq-acme/);
  assert.equal(vars.ASSET_EVENTS, 'contentworker-asset-events-acme');
});

test('Workers deploy engine first, then media, api, delivery and web', () => {
  assert.deepEqual([...APPS], ['engine', 'media', 'api', 'delivery', 'web']);
});

test('rate-limit namespaces move with the slot and never collide across Workers', () => {
  const ids = (i: typeof acme) =>
    (
      [
        [renderApi, 'api'],
        [renderDelivery, 'delivery'],
        [renderWeb, 'web'],
        [renderMedia, 'media'],
      ] as const
    ).flatMap(([fn, app]) =>
      fn(base(app), i).ratelimits.map((r: { namespace_id: string }) => r.namespace_id),
    );
  assert.ok(ids(plain).every((id) => id.startsWith('1')));
  assert.ok(ids(acme).every((id) => id.startsWith('2')));
  assert.equal(new Set(ids(acme)).size, ids(acme).length);
});

test('email sending is bound on the engine and web only when a sender is set', () => {
  assert.equal(renderEngine(base('engine'), plain).send_email, undefined);
  assert.equal(renderWeb(base('web'), plain).send_email, undefined);
  const mailing = toInstall({
    DOMAIN: 'cms.example.com',
    EMAIL_FROM: 'cms@example.com',
    EMAIL_FROM_NAME: 'Example',
    ...IDS,
  });
  for (const c of [renderEngine(base('engine'), mailing), renderWeb(base('web'), mailing)]) {
    assert.deepEqual(c.send_email, [{ name: 'EMAIL' }]);
    assert.equal(c.vars.EMAIL_FROM, 'cms@example.com');
    assert.equal(c.vars.EMAIL_FROM_NAME, 'Example');
  }
});

test('single sign-on reaches the web Worker', () => {
  const sso = toInstall({
    DOMAIN: 'cms.example.com',
    OIDC_ISSUER: 'https://id.example.com',
    OIDC_CLIENT_ID: 'cms',
    OIDC_TRUST_EMAIL: 'true',
    ...IDS,
  });
  const web = renderWeb(base('web'), sso);
  assert.equal(web.vars.OIDC_ISSUER, 'https://id.example.com');
  assert.equal(web.vars.OIDC_CLIENT_ID, 'cms');
  assert.equal(web.vars.OIDC_TRUST_EMAIL, 'true');
  assert.throws(
    () => toInstall({ DOMAIN: 'cms.example.com', OIDC_ISSUER: 'https://id.example.com' }),
    /OIDC_CLIENT_ID/,
  );
});

test('AI_MODE=mock mocks every model and has no vector index or gateway', () => {
  const mock = toInstall({ DOMAIN: 'cms.example.com', AI_MODE: 'mock', ...IDS });
  const engine = renderEngine(base('engine'), mock);
  assert.equal(engine.vars.AI_MODE, 'mock');
  assert.equal(engine.vars.AI_GATEWAY_ID, '');
  assert.equal(engine.vars.ALLOW_FAKE_ADAPTERS, 'ai,vectors');
  assert.equal(engine.vectorize, undefined);
  assert.equal(shellVars(mock).VECTORS, '');
  assert.equal(shellVars(mock).AI_GATEWAY, '');
  assert.equal(renderEngine(base('engine'), plain).vars.AI_MODE, 'live');
});

test('the enterprise sample starter is offered only when DEMO_STARTERS is on', () => {
  const on = toInstall({ DOMAIN: 'cms.example.com', DEMO_STARTERS: 'true', ...IDS });
  assert.equal(renderApi(base('api'), on).vars.DEMO_STARTERS, 'true');
  assert.equal(renderApi(base('api'), plain).vars.DEMO_STARTERS, 'false');
  assert.equal(renderEngine(base('engine'), on).vars.DEMO_STARTERS, undefined);
});

test('the AI tier cap reaches the api and the engine, and no cap renders empty', () => {
  const capped = toInstall({ DOMAIN: 'cms.example.com', AI_MAX_TIER: 'balanced', ...IDS });
  assert.equal(renderApi(base('api'), capped).vars.AI_MAX_TIER, 'balanced');
  assert.equal(renderEngine(base('engine'), capped).vars.AI_MAX_TIER, 'balanced');
  assert.equal(renderApi(base('api'), plain).vars.AI_MAX_TIER, '');
  assert.equal(renderDelivery(base('delivery'), capped).vars?.AI_MAX_TIER, undefined);
  assert.equal(renderWeb(base('web'), capped).vars?.AI_MAX_TIER, undefined);
});

test('settings are validated', () => {
  const ok = { DOMAIN: 'cms.example.com' };
  assert.throws(() => toInstall({}), /DOMAIN must be/);
  assert.throws(() => toInstall({ DOMAIN: 'not a host' }), /DOMAIN must be/);
  assert.throws(() => toInstall({ ...ok, INSTANCE: 'Bad_Name' }), /INSTANCE must be/);
  assert.throws(() => toInstall({ ...ok, RATE_LIMIT_SLOT: '0' }), /RATE_LIMIT_SLOT/);
  assert.throws(() => toInstall({ ...ok, DATA_JURISDICTION: 'mars' }), /DATA_JURISDICTION/);
  assert.throws(() => toInstall({ ...ok, AI_MAX_TIER: 'huge' }), /AI_MAX_TIER must be/);
  assert.throws(() => toInstall({ ...ok, AI_MODE: 'live' }), /AI_MODE/);
  assert.throws(() => toInstall({ ...ok, EMAIL_FROM: 'nope' }), /EMAIL_FROM/);
  assert.throws(() => toInstall({ ...ok, KV_ID: 'x' }), /KV_ID/);
  assert.equal(toInstall({ ...ok, RATE_LIMIT_SLOT: '' }).slot, 1);
});

test('rendering refuses an install whose resources were never looked up', () => {
  const bare = toInstall({ DOMAIN: 'cms.example.com' });
  assert.throws(() => renderEngine(base('engine'), bare), /no D1_ID/);
});

test('the environment wins over the settings file, which wins over nothing; secrets come last', () => {
  const root = mkdtempSync(join(tmpdir(), 'install-env-'));
  writeFileSync(join(root, '.env'), 'DOMAIN=file.example.com\nAI_MAX_TIER=fast\nINSTANCE=\n');
  mkdirSync(join(root, '.secrets'));
  writeFileSync(join(root, '.secrets', 'secrets.env'), 'DATA_KEY=from-file\nDOMAIN=nope.example\n');
  const env = loadEnv('.env', { DOMAIN: 'env.example.com', AI_MAX_TIER: '' }, root);
  assert.equal(env.DOMAIN, 'env.example.com');
  // An empty variable (an unset CI variable) doesn't hide the file's value.
  assert.equal(env.AI_MAX_TIER, 'fast');
  assert.equal(env.DATA_KEY, 'from-file');
  // A named instance reads its own secrets file.
  writeFileSync(join(root, '.secrets', 'secrets-stage.env'), 'DATA_KEY=stage\n');
  assert.equal(loadEnv('.env', { INSTANCE: 'stage' }, root).DATA_KEY, 'stage');
  assert.deepEqual(envFileArg(['render', '--settings', '.env.staging']), {
    envFile: '.env.staging',
    rest: ['render'],
  });
});

test('.env.example is a valid install, and the deploy workflow passes every setting in it', () => {
  const example = parseEnv(readFileSync(join(ROOT, '.env.example'), 'utf8'));
  assert.equal(toInstall(example).domain, 'cms.example.com');
  for (const k of Object.keys(example)) assert.ok(!SECRET_NAMES.includes(k), `${k} is a secret`);
  const workflow = readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
  for (const k of Object.keys(example))
    assert.ok(workflow.includes(`${k}: \${{ vars.${k} }}`), `deploy.yml doesn't pass ${k}`);
});

test('every app has a secrets list and the shared keys must be long', () => {
  for (const app of APPS) assert.ok(SECRETS[app].length > 0);
  assert.match(keysProblem({ DATA_KEY: 'short' }) ?? '', /DATA_KEY/);
  assert.equal(keysProblem({ DATA_KEY: 'x'.repeat(32) }), null);
});

test('the engine gets the assistant’s derived principal key pair, never the main one', () => {
  assert.deepEqual(SECRETS.engine, [
    'ASSISTANT_PRINCIPAL_KEY',
    'ASSISTANT_PRINCIPAL_KEY_PREVIOUS',
    'DATA_KEY',
    'DATA_KEY_PREVIOUS',
    'TOKEN_PEPPER',
    'MEDIA_SIGNING_SECRET',
  ]);
  for (const app of ['web', 'api', 'media', 'delivery'] as const)
    assert.ok(!SECRETS[app].some((k) => k.startsWith('ASSISTANT_')), app);
});

test('`secrets` derives the assistant’s pair from PRINCIPAL_KEY and its previous, without printing it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'install-secrets-'));
  const env = {
    PATH: process.env.PATH ?? '',
    DOMAIN: 'cms.example.com',
    INSTANCE: 'secretstest',
    PRINCIPAL_KEY: 'p'.repeat(40),
    PRINCIPAL_KEY_PREVIOUS: 'q'.repeat(40),
    DATA_KEY: 'd'.repeat(40),
    TOKEN_PEPPER: 't'.repeat(40),
    MEDIA_SIGNING_SECRET: 'm'.repeat(40),
  };
  const run = (app: string, out: string) =>
    execFileSync(
      process.execPath,
      ['scripts/install.ts', 'secrets', app, out, '--settings', join(dir, 'none.env')],
      { cwd: ROOT, env, encoding: 'utf8' },
    );
  const out = join(dir, 'engine.json');
  const said = run('engine', out);
  const written = JSON.parse(readFileSync(out, 'utf8')) as Record<string, string>;
  assert.equal(written.ASSISTANT_PRINCIPAL_KEY, deriveAssistantKey(env.PRINCIPAL_KEY));
  assert.equal(
    written.ASSISTANT_PRINCIPAL_KEY_PREVIOUS,
    deriveAssistantKey(env.PRINCIPAL_KEY_PREVIOUS),
  );
  for (const value of Object.values(written)) assert.ok(!said.includes(value));
  const webOut = join(dir, 'web.json');
  run('web', webOut);
  assert.ok(!('ASSISTANT_PRINCIPAL_KEY' in JSON.parse(readFileSync(webOut, 'utf8'))));
});
