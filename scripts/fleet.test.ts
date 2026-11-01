import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'jsonc-parser';
import { deriveAssistantKey } from './derive-assistant-key.ts';
import {
  APPS,
  hosts,
  keysProblem,
  loadDeployments,
  matrix,
  names,
  renderApi,
  renderDelivery,
  renderEngine,
  renderWeb,
  SECRETS,
  shellVars,
  toDeployment,
} from './fleet.ts';

const base = (app: string) =>
  parse(readFileSync(join(import.meta.dirname, '..', 'apps', app, 'wrangler.jsonc'), 'utf8'));

const acme = toDeployment({
  id: 'acme',
  ring: 'canary',
  slot: 2,
  d1Id: '11111111-2222-3333-4444-555555555555',
  kvId: 'a'.repeat(32),
  jurisdiction: 'eu',
});

test('a customer gets its own domain, names and environment by default', () => {
  assert.equal(acme.domain, 'acme.contentworker.app');
  assert.equal(acme.suffix, '-acme');
  assert.equal(acme.environment, 'deploy-acme');
  assert.deepEqual(hosts(acme), {
    web: 'acme.contentworker.app',
    api: 'api.acme.contentworker.app',
    delivery: 'cdn.acme.contentworker.app',
  });
});

test('every account-wide name in every app carries the deployment', () => {
  const n = names(acme);
  const engine = renderEngine(base('engine'), acme);
  assert.equal(engine.name, 'contentworker-engine-acme');
  assert.deepEqual(
    engine.workflows.map((w: { name: string }) => w.name),
    ['contentworker-agent-acme', 'contentworker-editorial-acme'],
  );
  assert.equal(engine.d1_databases[0].database_name, n.d1);
  assert.equal(engine.d1_databases[0].database_id, acme.d1Id);
  assert.equal(engine.kv_namespaces[0].id, acme.kvId);
  assert.equal(engine.r2_buckets[0].bucket_name, n.media);
  assert.equal(engine.r2_buckets[0].jurisdiction, 'eu');
  assert.equal(engine.vectorize[0].index_name, n.vectors);
  for (const q of engine.queues.consumers) {
    assert.match(q.queue, /-acme$/);
    if (q.dead_letter_queue) assert.match(q.dead_letter_queue, /-acme$/);
  }
  for (const p of engine.queues.producers) assert.match(p.queue, /-acme$/);
  assert.equal(engine.vars.DATA_JURISDICTION, 'eu');
  assert.equal(engine.vars.AI_GATEWAY_ID, n.aiGateway);
});

test('the api, delivery and web Workers bind the deployment’s own engine and api', () => {
  const api = renderApi(base('api'), acme);
  for (const b of api.durable_objects.bindings) assert.equal(b.script_name, names(acme).engine);
  for (const w of api.workflows) {
    assert.equal(w.script_name, names(acme).engine);
    assert.match(w.name, /-acme$/);
  }
  assert.deepEqual(api.routes, [{ pattern: 'api.acme.contentworker.app', custom_domain: true }]);
  assert.equal(api.vars.OAUTH_ISSUER, 'https://acme.contentworker.app');
  assert.equal(api.vars.MEDIA_BASE_URL, 'https://api.acme.contentworker.app');

  const delivery = renderDelivery(base('delivery'), acme);
  for (const b of delivery.durable_objects.bindings)
    assert.equal(b.script_name, names(acme).engine);
  assert.equal(delivery.queues.consumers[0].queue, 'contentworker-purge-acme');
  assert.deepEqual(delivery.routes, [
    { pattern: 'cdn.acme.contentworker.app', custom_domain: true },
  ]);

  const web = renderWeb(base('web'), acme);
  assert.equal(
    web.services.find((s: { binding: string }) => s.binding === 'API').service,
    names(acme).api,
  );
  assert.equal(
    web.services.find((s: { binding: string }) => s.binding === 'DELIVERY').service,
    names(acme).delivery,
  );
  assert.deepEqual(web.routes, [{ pattern: 'acme.contentworker.app', custom_domain: true }]);
});

test('rate-limit namespaces move with the slot and never collide across Workers', () => {
  const ids = [renderApi, renderDelivery, renderWeb].flatMap((fn, i) =>
    fn(base(['api', 'delivery', 'web'][i] as string), acme).ratelimits.map(
      (r: { namespace_id: string }) => r.namespace_id,
    ),
  );
  assert.ok(ids.every((id) => id.startsWith('2')));
  assert.equal(new Set(ids).size, ids.length);
});

test('email sending is bound only when a deployment names a sender', () => {
  assert.equal(renderEngine(base('engine'), acme).send_email, undefined);
  const mailing = toDeployment({ ...acme, slot: 3, email: { from: 'cms@acme.com' } });
  const c = renderEngine(base('engine'), mailing);
  assert.deepEqual(c.send_email, [{ name: 'EMAIL' }]);
  assert.equal(c.vars.EMAIL_FROM, 'cms@acme.com');
});

test('a demo mocks its models and has no vector index', () => {
  const demo = toDeployment({ ...acme, id: 'demo-x', slot: 4, demo: true });
  const engine = renderEngine(base('engine'), demo);
  assert.equal(engine.vars.AI_MODE, 'mock');
  assert.equal(engine.vectorize, undefined);
  assert.equal(shellVars(demo).VECTORS, '');
});

test('the registry is validated', () => {
  assert.throws(() => toDeployment({ id: 'Bad_Id', ring: 'canary', slot: 1 }), /id must be/);
  assert.throws(() => toDeployment({ id: 'api', ring: 'canary', slot: 1 }), /reserved/);
  assert.throws(() => toDeployment({ id: 'acme', ring: 'nightly', slot: 1 }), /ring/);
  assert.throws(() => toDeployment({ id: 'acme', ring: 'canary', slot: 0 }), /slot/);
  assert.throws(() => toDeployment({ id: 'acme', ring: 'canary', slot: 1, kvId: 'x' }), /kvId/);
  assert.throws(
    () => toDeployment({ id: 'acme', ring: 'canary', slot: 1, email: { from: 'nope' } }),
    /email\.from/,
  );
});

test('rendering refuses an unprovisioned deployment, and so does the CI matrix', () => {
  const bare = toDeployment({ id: 'bare', ring: 'canary', slot: 9 });
  assert.throws(() => renderEngine(base('engine'), bare), /no d1Id/);
  assert.throws(() => matrix([bare]), /not provisioned/);
  assert.deepEqual(matrix([{ ...bare, hold: true }]).canary, []);
});

test('the checked-in registry loads, with distinct slots, domains and suffixes', () => {
  const list = loadDeployments();
  assert.ok(list.some((d) => d.id === 'contentworker'));
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
  // Nobody else holds the assistant's key.
  for (const app of ['web', 'api', 'delivery'] as const)
    assert.ok(!SECRETS[app].some((k) => k.startsWith('ASSISTANT_')), app);
});

test('`secrets` derives the assistant’s pair from PRINCIPAL_KEY and its previous, without printing it', () => {
  const env = {
    PATH: process.env.PATH ?? '',
    PRINCIPAL_KEY: 'p'.repeat(40),
    PRINCIPAL_KEY_PREVIOUS: 'q'.repeat(40),
    DATA_KEY: 'd'.repeat(40),
    TOKEN_PEPPER: 't'.repeat(40),
    MEDIA_SIGNING_SECRET: 'm'.repeat(40),
  };
  const out = join(mkdtempSync(join(tmpdir(), 'fleet-secrets-')), 'engine.json');
  const said = execFileSync(process.execPath, ['scripts/fleet.ts', 'secrets', 'engine', out], {
    env,
    encoding: 'utf8',
  });
  const written = JSON.parse(readFileSync(out, 'utf8')) as Record<string, string>;
  assert.equal(written.ASSISTANT_PRINCIPAL_KEY, deriveAssistantKey(env.PRINCIPAL_KEY));
  assert.equal(
    written.ASSISTANT_PRINCIPAL_KEY_PREVIOUS,
    deriveAssistantKey(env.PRINCIPAL_KEY_PREVIOUS),
  );
  for (const value of Object.values(written)) assert.ok(!said.includes(value));
  // The web Worker signs with the main key and is never given the derived one.
  const webOut = join(mkdtempSync(join(tmpdir(), 'fleet-secrets-')), 'web.json');
  execFileSync(process.execPath, ['scripts/fleet.ts', 'secrets', 'web', webOut], { env });
  assert.ok(!('ASSISTANT_PRINCIPAL_KEY' in JSON.parse(readFileSync(webOut, 'utf8'))));
});
