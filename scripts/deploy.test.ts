import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// scripts/deploy.sh against stand-ins for pnpm, curl and sleep placed first on PATH, so nothing
// reaches Cloudflare; the token below is fake in case a stand-in were ever missed. fleet.ts is real.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ID = 'deploytest';
const APPS = ['engine', 'media', 'api', 'delivery', 'web'];

const bin = mkdtempSync(join(tmpdir(), 'deploy-bin-'));
const stub = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};
stub(
  'pnpm',
  `echo "$*" >>"$LOG"
if [[ "$*" =~ rollback ]]; then
  [[ -n "\${NO_EARLIER:-}" && "$*" =~ \${NO_EARLIER} ]] && { echo 'Could not find stable Worker Version to rollback to'; exit 1; }
  [[ -n "\${ROLLBACK_FAIL:-}" && "$*" =~ \${ROLLBACK_FAIL} ]] && exit 1
  exit 0
fi
[[ -n "\${PNPM_TERM:-}" && "$*" =~ \${PNPM_TERM} ]] && kill -TERM "$PPID"
[[ -n "\${PNPM_FAIL:-}" && "$*" =~ \${PNPM_FAIL} ]] && exit 1
[[ "$*" =~ time-travel ]] && echo '{"bookmark":"bm-1"}'
exit 0`,
);
stub(
  'curl',
  `echo "curl $*" >>"$LOG"
[[ -n "\${CURL_FAIL:-}" && "$*" =~ \${CURL_FAIL} ]] && exit 22
case "$*" in
  *time_total*) printf 0.1 ;;
  *http_code*delivery/smoke*) printf 401 ;;
  *http_code*media*) printf "\${MEDIA_STATUS:-404}" ;;
  *http_code*) printf 404 ;;
esac
exit 0`,
);
stub('sleep', 'exit 0');

const registry = (entry: Record<string, unknown>) => {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-registry-'));
  writeFileSync(
    join(dir, `${ID}.jsonc`),
    JSON.stringify({
      id: ID,
      ring: 'internal',
      slot: 900,
      domain: 'deploytest.example.com',
      d1Id: '00000000-0000-0000-0000-000000000000',
      kvId: '0'.repeat(32),
      ...entry,
    }),
  );
  return dir;
};

const KEY = 'k'.repeat(32);
const SECRETS = {
  PRINCIPAL_KEY: KEY,
  DATA_KEY: KEY,
  TOKEN_PEPPER: KEY,
  MEDIA_SIGNING_SECRET: KEY,
};

function deploy(env: Record<string, string> = {}, entry: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-run-'));
  const log = join(dir, 'log');
  const summary = join(dir, 'summary');
  writeFileSync(log, '');
  writeFileSync(summary, '');
  const r = spawnSync('bash', ['scripts/deploy.sh', ID], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: process.env.HOME ?? '',
      LOG: log,
      GITHUB_SHA: 'abcdef1234567890',
      GITHUB_STEP_SUMMARY: summary,
      FLEET_REGISTRY: registry(entry),
      CLOUDFLARE_API_TOKEN: 'fake',
      CLOUDFLARE_ACCOUNT_ID: 'fake',
      ...SECRETS,
      ...env,
    },
  });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return {
    status: r.status,
    out: r.stdout + r.stderr,
    calls,
    summary: readFileSync(summary, 'utf8'),
    /** The Workers rolled back, in order. */
    rolledBack: calls
      .filter((c) => c.includes('rollback'))
      .map((c) => /@contentworker\/([a-z-]+)/.exec(c)?.[1]),
    deployed: calls
      .filter((c) => / wrangler deploy/.test(c))
      .map((c) => /@contentworker\/([a-z-]+)/.exec(c)?.[1]),
  };
}

after(() => {
  for (const app of APPS) rmSync(join(ROOT, 'apps', app, `wrangler.${ID}.json`), { force: true });
});

test('a clean deploy migrates first, ships the engine first, and rolls nothing back', () => {
  const r = deploy();
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.deployed, APPS);
  assert.deepEqual(r.rolledBack, []);
  const at = (s: string) => r.calls.findIndex((c) => c.includes(s));
  assert.ok(at('time-travel') < at('migrations apply'));
  assert.ok(at('migrations apply') < at('wrangler deploy'));
  assert.ok(at('@contentworker/web build') < at('@contentworker/web exec wrangler deploy'));
  assert.match(r.summary, /D1 bookmark for deploytest before abcdef1: `bm-1`/);
  assert.ok(r.calls.some((c) => c.includes('curl') && c.includes('api.deploytest.example.com')));
});

test('the rendered config and secrets reach each Worker, and the secrets files are removed', () => {
  const r = deploy();
  const engine = r.calls.find((c) => c.includes('engine exec wrangler deploy')) ?? '';
  assert.match(engine, /--config wrangler\.deploytest\.json/);
  const file = /--secrets-file (\S+)/.exec(engine)?.[1] ?? '';
  assert.ok(file.endsWith('engine-secrets.json'), engine);
  assert.equal(existsSync(file), false);
  // Web deploys from the build's own config.
  const web = r.calls.find((c) => c.includes('web exec wrangler deploy')) ?? '';
  assert.doesNotMatch(web, /--config/);
});

test('missing credentials stop the deploy before anything runs', () => {
  const r = deploy({ CLOUDFLARE_API_TOKEN: '' });
  assert.equal(r.status, 1);
  assert.deepEqual(r.calls, []);
  assert.match(r.out, /CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set/);
});

test('a missing required secret stops the deploy before migrating', () => {
  const r = deploy({ DATA_KEY: '' });
  assert.equal(r.status, 1);
  assert.deepEqual(r.calls, []);
  assert.match(r.out, /DATA_KEY not set/);
  assert.match(r.out, /failed at: Collect secrets/);
});

test('a failed migration ships nothing and rolls nothing back', () => {
  const r = deploy({ PNPM_FAIL: 'migrations apply' });
  assert.equal(r.status, 1);
  assert.deepEqual(r.deployed, []);
  assert.deepEqual(r.rolledBack, []);
  assert.equal(r.calls.filter((c) => c.includes('migrations apply')).length, 3);
});

test('an engine that never shipped has nothing to roll back', () => {
  const r = deploy({ PNPM_FAIL: 'engine exec wrangler deploy' });
  assert.equal(r.status, 1);
  assert.deepEqual(r.rolledBack, []);
});

test('a failure part way rolls back only what shipped, engine first', () => {
  const r = deploy({ PNPM_FAIL: 'api exec wrangler deploy' });
  assert.equal(r.status, 1);
  assert.deepEqual(r.rolledBack, ['engine', 'media']);
  assert.match(r.out, /failed at: Deploy api/);
});

test('a failed smoke test rolls every Worker back, engine first', () => {
  const r = deploy({ CURL_FAIL: 'health/deep' });
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.rolledBack, APPS);
  assert.match(r.summary, /Rolled back engine/);
});

test('a media origin that serves an unknown asset fails the smoke test', () => {
  const r = deploy({ MEDIA_STATUS: '200' });
  assert.equal(r.status, 1);
  assert.match(r.out, /an unknown media URL answered 200, not 404/);
  assert.deepEqual(r.rolledBack, APPS);
});

test('an engine that refuses its rollback leaves the others on the new version', () => {
  const r = deploy({ CURL_FAIL: 'health/deep', ROLLBACK_FAIL: 'engine' });
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.rolledBack, ['engine', 'engine', 'engine']);
  assert.match(r.out, /Fix forward/);
});

test('a first deploy with no earlier version stays, and the rest still roll back', () => {
  const r = deploy({ CURL_FAIL: 'health/deep', NO_EARLIER: 'api' });
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.rolledBack, APPS);
});

test('a slow or failing latency check never fails the deploy', () => {
  const r = deploy({ CURL_FAIL: 'time_total' });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.rolledBack, []);
});

test('docs ship only with the deployment that hosts them', () => {
  assert.equal(deploy().calls.filter((c) => c.includes('docs-site')).length, 0);
  const r = deploy({}, { docs: true });
  assert.equal(r.status, 0, r.out);
  assert.ok(r.calls.some((c) => c.includes('docs-site run deploy')));
});

test('a failed docs deploy leaves the app alone', () => {
  const r = deploy({ PNPM_FAIL: 'docs-site run deploy' }, { docs: true });
  assert.equal(r.status, 1);
  assert.deepEqual(r.rolledBack, []);
});

test('a failed docs smoke test rolls back the docs and not the app', () => {
  const r = deploy({ CURL_FAIL: 'reference/rest-api' }, { docs: true });
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.rolledBack, ['docs-site']);
});

test('a cancelled job rolls nothing back', () => {
  const r = deploy({ PNPM_TERM: 'api exec wrangler deploy' });
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.rolledBack, []);
  assert.equal(r.deployed.includes('delivery'), false);
});
