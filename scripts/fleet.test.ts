import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'jsonc-parser';
import { deriveAssistantKey } from './derive-assistant-key.ts';
import {
  APPS,
  bindingNames,
  doctor,
  doctorHealth,
  ENGINE_CRON,
  healthFinding,
  hosts,
  keysProblem,
  loadDeployments,
  matrix,
  names,
  REQUIRED_BINDINGS,
  registryDir,
  renderApi,
  renderDelivery,
  renderEngine,
  renderMedia,
  renderWeb,
  SECRETS,
  shellVars,
  toDeployment,
} from './fleet.ts';

/** A fake registry (fake ids, example.test domains): the public repo ships no real one. */
const FIXTURES = join(import.meta.dirname, 'fixtures', 'fleet');
const EXAMPLE = join(import.meta.dirname, '..', 'examples', 'fleet');

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
    media: 'media.acme.contentworker.app',
  });
});

test('every account-wide name in every app carries the deployment', () => {
  const n = names(acme);
  const engine = renderEngine(base('engine'), acme);
  assert.equal(engine.name, 'contentworker-engine-acme');
  assert.deepEqual(
    engine.workflows.map((w: { name: string }) => w.name),
    [
      'contentworker-agent-acme',
      'contentworker-editorial-acme',
      'contentworker-asset-ingest-acme',
      'contentworker-asset-zip-acme',
      'contentworker-app-operation-acme',
    ],
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

test('the media Worker gets its own route, purge queue and the deployment’s media origin', () => {
  const media = renderMedia(base('media'), acme);
  assert.equal(media.name, 'contentworker-media-acme');
  assert.deepEqual(media.routes, [
    { pattern: 'media.acme.contentworker.app', custom_domain: true },
  ]);
  assert.equal(media.r2_buckets[0].bucket_name, names(acme).media);
  assert.equal(media.r2_buckets[0].jurisdiction, 'eu');
  assert.equal(media.kv_namespaces[0].id, acme.kvId);
  assert.equal(media.d1_databases[0].database_id, acme.d1Id);
  assert.deepEqual(
    media.queues.consumers.map((q: { queue: string }) => q.queue),
    ['contentworker-media-purge-acme', 'contentworker-media-purge-dlq-acme'],
  );
  assert.equal(media.queues.consumers[0].dead_letter_queue, 'contentworker-media-purge-dlq-acme');
  // Its cached entrypoint is never routable: only the gateway is the default export.
  assert.equal(media.exports.default.cache.enabled, false);
  assert.equal(media.exports.Media.cache.enabled, true);
  assert.deepEqual(SECRETS.media, ['MEDIA_SIGNING_SECRET']);

  // Every Worker that builds asset URLs builds them on it; the engine sends its purges.
  for (const [app, render] of [
    ['api', renderApi],
    ['delivery', renderDelivery],
    ['engine', renderEngine],
  ] as const) {
    assert.equal(
      render(base(app), acme).vars.MEDIA_PUBLIC_URL,
      'https://media.acme.contentworker.app',
    );
  }
  const producers = renderEngine(base('engine'), acme).queues.producers;
  assert.equal(
    producers.find((p: { binding: string }) => p.binding === 'MEDIA_PURGE_QUEUE').queue,
    'contentworker-media-purge-acme',
  );
  assert.match(
    shellVars(acme).QUEUES,
    /contentworker-media-purge-acme contentworker-media-purge-dlq-acme/,
  );
  assert.equal(shellVars(acme).MEDIA_DOMAIN, 'media.acme.contentworker.app');
});

test('asset ingest: the engine consumes the asset-events queue, and provisioning creates it', () => {
  const engine = renderEngine(base('engine'), acme);
  const consumer = engine.queues.consumers.find(
    (q: { queue: string }) => q.queue === 'contentworker-asset-events-acme',
  );
  assert.equal(consumer.dead_letter_queue, 'contentworker-asset-events-dlq-acme');
  assert.ok(
    engine.queues.consumers.some(
      (q: { queue: string }) => q.queue === 'contentworker-asset-events-dlq-acme',
    ),
  );
  assert.equal(
    engine.workflows.find((w: { binding: string }) => w.binding === 'ASSET_INGEST_WF').name,
    'contentworker-asset-ingest-acme',
  );
  const api = renderApi(base('api'), acme);
  assert.equal(
    api.queues.producers.find((p: { binding: string }) => p.binding === 'ASSET_EVENTS_QUEUE').queue,
    'contentworker-asset-events-acme',
  );
  const vars = shellVars(acme);
  assert.match(vars.QUEUES, /contentworker-asset-events-acme contentworker-asset-events-dlq-acme/);
  // The R2 notification rule targets the deployment's own queue.
  assert.equal(vars.ASSET_EVENTS, 'contentworker-asset-events-acme');
});

test('Workers deploy engine first, then media, api, delivery and web', () => {
  assert.deepEqual([...APPS], ['engine', 'media', 'api', 'delivery', 'web']);
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

test('the web Worker gets the sender too, for password reset codes', () => {
  assert.equal(renderWeb(base('web'), acme).send_email, undefined);
  const mailing = toDeployment({
    ...acme,
    slot: 3,
    email: { from: 'cms@acme.com', fromName: 'Acme' },
  });
  const c = renderWeb(base('web'), mailing);
  assert.deepEqual(c.send_email, [{ name: 'EMAIL' }]);
  assert.equal(c.vars.EMAIL_FROM, 'cms@acme.com');
  assert.equal(c.vars.EMAIL_FROM_NAME, 'Acme');
});

test('a demo mocks its models and has no vector index', () => {
  const demo = toDeployment({ ...acme, id: 'demo-x', slot: 4, demo: true });
  const engine = renderEngine(base('engine'), demo);
  assert.equal(engine.vars.AI_MODE, 'mock');
  assert.equal(engine.vectorize, undefined);
  assert.equal(shellVars(demo).VECTORS, '');
});

test('a demo offers the enterprise starter on its api, and no one else does', () => {
  const demo = toDeployment({ ...acme, id: 'demo-x', slot: 4, demo: true });
  assert.equal(renderApi(base('api'), demo).vars.DEMO_STARTERS, 'true');
  assert.equal(renderApi(base('api'), acme).vars.DEMO_STARTERS, 'false');
  assert.equal(renderEngine(base('engine'), demo).vars.DEMO_STARTERS, undefined);
});

test('a deployment’s AI tier cap reaches the api and the engine, and no cap renders empty', () => {
  const capped = toDeployment({ ...acme, slot: 5, aiMaxTier: 'balanced' });
  assert.equal(renderApi(base('api'), capped).vars.AI_MAX_TIER, 'balanced');
  assert.equal(renderEngine(base('engine'), capped).vars.AI_MAX_TIER, 'balanced');
  assert.equal(renderApi(base('api'), acme).vars.AI_MAX_TIER, '');
  assert.equal(renderEngine(base('engine'), acme).vars.AI_MAX_TIER, '');
  // Only Workers that call models carry it.
  assert.equal(renderDelivery(base('delivery'), capped).vars?.AI_MAX_TIER, undefined);
  assert.equal(renderWeb(base('web'), capped).vars?.AI_MAX_TIER, undefined);
  assert.throws(
    () => toDeployment({ ...acme, slot: 5, aiMaxTier: 'huge' }),
    /aiMaxTier must be "flagship", "balanced" or "fast"/,
  );
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

test('FLEET_REGISTRY moves the registry, and an unset one stays in this repo', () => {
  assert.match(registryDir({}), /\/deployments$/);
  assert.equal(registryDir({ FLEET_REGISTRY: '/srv/ops/deployments' }), '/srv/ops/deployments');
});

test('the fixture registry loads, with distinct slots, domains and suffixes', () => {
  const list = loadDeployments(FIXTURES);
  assert.deepEqual(list.map((d) => d.id).sort(), ['fixture-demo', 'fixture-main']);
});

test('a missing or empty registry is a clear error, not ENOENT', () => {
  const missing = join(tmpdir(), 'fleet-no-such-registry');
  assert.throws(() => loadDeployments(missing), /no deployment registry at .*FLEET_REGISTRY/);
  const empty = mkdtempSync(join(tmpdir(), 'fleet-empty-registry-'));
  assert.throws(() => loadDeployments(empty), /no deployment registry at .*examples\/fleet/);
  const r = spawnSync(process.execPath, [join(import.meta.dirname, 'fleet.ts'), 'matrix'], {
    encoding: 'utf8',
    env: { ...process.env, FLEET_REGISTRY: missing },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no deployment registry at/);
  assert.doesNotMatch(r.stderr, /ENOENT/);
});

test('the example registry entry loads, is held, and renders nothing for CI', () => {
  const list = loadDeployments(EXAMPLE);
  assert.deepEqual(
    list.map((d) => [d.id, d.hold]),
    [['example', true]],
  );
  for (const ring of Object.values(matrix(list))) assert.deepEqual(ring, []);
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
  for (const app of ['web', 'api', 'media', 'delivery'] as const)
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

// --- doctor ---

const bases = () =>
  Object.fromEntries(APPS.map((app) => [app, base(app)])) as Parameters<typeof doctor>[1];
const errors = (findings: ReturnType<typeof doctor>) =>
  findings.filter((f) => f.level === 'error').map((f) => `${f.app}: ${f.message}`);

test('a registry refuses two deployments on one database or key-value namespace', () => {
  const [kv1, kv2] = ['a'.repeat(32), 'b'.repeat(32)];
  const registry = (a: object, b: object) => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-registry-'));
    const entry = (id: string, slot: number, rest: object) =>
      JSON.stringify({ id, ring: 'general', slot, domain: `${id}.example.com`, ...rest });
    writeFileSync(join(dir, 'alpha.jsonc'), entry('alpha', 1, a));
    writeFileSync(join(dir, 'bravo.jsonc'), entry('bravo', 2, b));
    return dir;
  };
  assert.throws(
    () => loadDeployments(registry({ d1Id: 'same', kvId: kv1 }, { d1Id: 'same', kvId: kv2 })),
    /two deployments share d1Id "same"/,
  );
  assert.throws(
    () => loadDeployments(registry({ d1Id: 'd1', kvId: kv1 }, { d1Id: 'd2', kvId: kv1 })),
    /two deployments share kvId "a{32}"/,
  );
  // Not yet provisioned: neither has an id to share.
  assert.equal(loadDeployments(registry({}, {})).length, 2);
});

test('doctor passes a provisioned deployment rendered from the checked-in configs', () => {
  assert.deepEqual(errors(doctor(acme, bases())), []);
  for (const d of loadDeployments(FIXTURES).filter((x) => x.d1Id && x.kvId))
    assert.deepEqual(errors(doctor(d, bases())), [], d.id);
});

test('doctor requires every app’s bindings, and the template holds them', () => {
  for (const app of APPS) {
    const have = bindingNames(base(app));
    for (const b of REQUIRED_BINDINGS[app]) assert.ok(have.has(b), `${app} lacks ${b}`);
  }
  const b = bases();
  b.api.kv_namespaces = [];
  b.delivery.durable_objects.bindings = b.delivery.durable_objects.bindings.filter(
    (x: { name: string }) => x.name !== 'SEARCH',
  );
  assert.deepEqual(errors(doctor(acme, b)), [
    'api: missing bindings: KV_CACHE',
    'delivery: missing bindings: SEARCH',
  ]);
});

test('doctor refuses an engine with no per-minute cron or a lost queue consumer', () => {
  const b = bases();
  b.engine.triggers = { crons: ['*/5 * * * *'] };
  b.engine.queues.consumers = b.engine.queues.consumers.filter(
    (q: { queue: string }) => q.queue !== 'contentworker-bulk',
  );
  const found = errors(doctor(acme, b));
  assert.ok(
    found.some((e) => e.startsWith('engine: no "* * * * *" cron')),
    found.join('\n'),
  );
  assert.ok(found.includes('engine: consumes no contentworker-bulk-acme'), found.join('\n'));
  assert.equal(ENGINE_CRON, '* * * * *');
});

test('doctor checks cross-script Durable Object and Workflow bindings against the engine', () => {
  const b = bases();
  // A class the engine never defined, and a Workflow it doesn't run.
  b.delivery.durable_objects.bindings.push({
    name: 'GHOST',
    class_name: 'GhostDO',
    script_name: 'contentworker-engine',
  });
  b.api.workflows.push({
    binding: 'PUBLISH_WF',
    name: 'contentworker-publish',
    class_name: 'PublishWorkflow',
    script_name: 'contentworker-engine',
  });
  // A binding that forgot it lives in the engine.
  b.api.durable_objects.bindings[0].script_name = undefined;
  assert.deepEqual(errors(doctor(acme, b)), [
    'api: Durable Object LIVE_HUB binds itself, not contentworker-engine-acme',
    'api: Workflow PUBLISH_WF: contentworker-engine-acme runs no contentworker-publish-acme (PublishWorkflow)',
    'delivery: Durable Object GHOST: contentworker-engine-acme defines no class GhostDO',
  ]);
});

test('doctor reports an unprovisioned deployment, a secret declared as a var, and SSO’s secret', () => {
  const raw = toDeployment({ id: 'fresh', ring: 'staging', slot: 9 });
  assert.ok(errors(doctor(raw, bases())).every((e) => e.includes('run scripts/provision.sh')));
  const b = bases();
  b.api.vars.ADMIN_TOKEN = 'oops';
  assert.deepEqual(errors(doctor(acme, b)), ['api: secrets declared as plain vars: ADMIN_TOKEN']);
  const sso = toDeployment({
    ...{ id: 'acme', ring: 'canary', slot: 2, d1Id: acme.d1Id, kvId: acme.kvId },
    sso: { issuer: 'https://idp.example', clientId: 'cw' },
  });
  assert.ok(
    doctor(sso, bases()).some(
      (f) => f.level === 'warn' && f.message.includes('OIDC_CLIENT_SECRET'),
    ),
  );
});

test('doctor reads the scheduler from the api’s /health, without the network', async () => {
  const seen: string[] = [];
  const fake = (status: number, body: unknown) =>
    (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;

  assert.equal(
    (await doctorHealth(acme, fake(200, { status: 'ok', scheduler: 'ok' }))).level,
    'ok',
  );
  assert.equal(seen[0], 'https://api.acme.contentworker.app/health');
  const stale = await doctorHealth(
    acme,
    fake(200, { status: 'ok', scheduler: 'stale' }),
    'http://localhost:8787/',
  );
  assert.equal(stale.level, 'error');
  assert.match(stale.message, /scheduler stale/);
  assert.equal(seen[1], 'http://localhost:8787/health');

  const down = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  assert.equal((await doctorHealth(acme, down)).level, 'error');
  assert.equal(healthFinding(503, { status: 'ok' }, 'u').level, 'error');
  assert.equal(healthFinding(200, { status: 'ok', scheduler: 'unknown' }, 'u').level, 'warn');
  assert.equal(healthFinding(200, { status: 'ok' }, 'u').level, 'warn');
});

test('`doctor --offline` checks a registry deployment and asks nothing of the network', () => {
  const out = execFileSync(
    process.execPath,
    [join(import.meta.dirname, 'fleet.ts'), 'doctor', 'fixture-main', '--offline'],
    { encoding: 'utf8', env: { ...process.env, FLEET_REGISTRY: FIXTURES } },
  );
  assert.match(out, /cron "\* \* \* \* \*"/);
  assert.doesNotMatch(out, /ERROR|scheduler (ticking|stale|unknown)|unreachable/);
});
