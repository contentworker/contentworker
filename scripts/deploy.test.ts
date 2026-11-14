import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { SECRETS as APP_SECRETS, DERIVED } from './install.ts';

// scripts/deploy.sh against stand-ins for pnpm, curl and sleep placed first on PATH, so nothing
// reaches Cloudflare; the token below is fake in case a stand-in were ever missed. install.ts is real.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INSTANCE = 'deploytest';
const D1_UUID = '00000000-0000-4000-8000-0000000000aa';
const KV_ID = 'a'.repeat(32);
const APPS = ['engine', 'media', 'api', 'delivery', 'web'];
const SCRIPT = join('scripts', 'deploy.sh');

const bin = mkdtempSync(join(tmpdir(), 'deploy-bin-'));
const stub = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};
stub(
  'pnpm',
  `echo "$*" >>"$LOG"
env | cut -d= -f1 >>"$LOG.env"
if [[ "$*" =~ rollback ]]; then
  [[ -n "\${NO_EARLIER:-}" && "$*" =~ \${NO_EARLIER} ]] && { echo 'Could not find stable Worker Version to rollback to'; exit 1; }
  [[ -n "\${ROLLBACK_FAIL:-}" && "$*" =~ \${ROLLBACK_FAIL} ]] && exit 1
  exit 0
fi
[[ -n "\${PNPM_TERM:-}" && "$*" =~ \${PNPM_TERM} ]] && kill -TERM "$PPID"
[[ -n "\${PNPM_HANG:-}" && "$*" =~ \${PNPM_HANG} ]] && /bin/sleep 1
if [[ -n "\${PNPM_FLAKE:-}" && "$*" =~ \${PNPM_FLAKE} && ! -e "$LOG.flaked" ]]; then
  touch "$LOG.flaked"
  exit 1
fi
[[ -n "\${PNPM_FAIL:-}" && "$*" =~ \${PNPM_FAIL} ]] && exit 1
[[ "$*" =~ time-travel ]] && echo '{"bookmark":"bm-1"}'
[[ "$*" =~ "d1 list" && -z "\${NO_D1:-}" ]] && echo '[{"name":"contentworker-deploytest","uuid":"${D1_UUID}"}]'
[[ "$*" =~ "kv namespace list" ]] && echo '[{"title":"contentworker-cache-deploytest","id":"${KV_ID}"}]'
exit 0`,
);
stub(
  'curl',
  `echo "curl $*" >>"$LOG"
[[ -n "\${CURL_FAIL:-}" && "$*" =~ \${CURL_FAIL} ]] && exit 22
case "$*" in
  *time_total*) printf 0.1 ;;
  *http_code*delivery/smoke*) printf "\${DELIVERY_STATUS:-401}" ;;
  *http_code*media*) printf "\${MEDIA_STATUS:-404}" ;;
  *http_code*) printf 404 ;;
esac
exit 0`,
);
stub('sleep', 'exit 0');

const KEY = 'k'.repeat(32);
const SECRETS = {
  PRINCIPAL_KEY: KEY,
  DATA_KEY: KEY,
  TOKEN_PEPPER: KEY,
  MEDIA_SIGNING_SECRET: KEY,
};

/** The install's own secrets file, which the deploy reads for any secret the environment lacks. */
const SECRETS_FILE = join(ROOT, '.secrets', `secrets-${INSTANCE}.env`);

function setup(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-run-'));
  const log = join(dir, 'log');
  const summary = join(dir, 'summary');
  writeFileSync(log, '');
  writeFileSync(summary, '');
  return {
    dir,
    log,
    summary,
    // A settings file that doesn't exist, so a checkout's own .env never leaks into the test.
    envFile: join(dir, 'none.env'),
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: process.env.HOME ?? '',
      LOG: log,
      GITHUB_ACTIONS: 'true',
      DEPLOY_SHA: 'abcdef1234567890',
      GITHUB_STEP_SUMMARY: summary,
      DOMAIN: 'deploytest.example.com',
      INSTANCE,
      RATE_LIMIT_SLOT: '900',
      D1_ID: D1_UUID,
      KV_ID,
      CLOUDFLARE_API_TOKEN: 'fake',
      CLOUDFLARE_ACCOUNT_ID: 'fake',
      ...SECRETS,
      ...env,
    },
  };
}

function deploy(env: Record<string, string> = {}) {
  const { log, summary, envFile, env: full } = setup(env);
  const r = spawnSync('bash', [SCRIPT, '--env-file', envFile], {
    cwd: ROOT,
    encoding: 'utf8',
    env: full,
  });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return {
    status: r.status,
    out: r.stdout + r.stderr,
    calls,
    /** Every variable name any pnpm call saw. */
    seen: existsSync(`${log}.env`) ? readFileSync(`${log}.env`, 'utf8').split('\n') : [],
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

const CONFIG_FILE = `wrangler.deploy-${INSTANCE}.json`;

after(() => {
  for (const app of APPS) rmSync(join(ROOT, 'apps', app, CONFIG_FILE), { force: true });
  rmSync(SECRETS_FILE, { force: true });
});

test('a clean deploy migrates first, ships the engine first, and rolls nothing back', () => {
  const r = deploy();
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.deployed, APPS);
  assert.deepEqual(r.rolledBack, []);
  const at = (s: string) => {
    const i = r.calls.findIndex((c) => c.includes(s));
    assert.notEqual(i, -1, `${s} never ran`);
    return i;
  };
  assert.ok(at('time-travel') < at('migrations apply'));
  assert.ok(at('migrations apply') < at('wrangler deploy'));
  assert.ok(at('@contentworker/web build') < at('@contentworker/web exec wrangler deploy'));
  assert.match(r.summary, /D1 bookmark before abcdef1: `bm-1`/);
  assert.ok(r.calls.some((c) => c.includes('curl') && c.includes('api.deploytest.example.com')));
});

test('the rendered config and secrets reach each Worker, and the secrets files are removed', () => {
  const r = deploy();
  const engine = r.calls.find((c) => c.includes('engine exec wrangler deploy')) ?? '';
  assert.match(engine, /--config wrangler\.deploy-deploytest\.json/);
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

test('a cancelled job rolls nothing back', () => {
  const r = deploy({ PNPM_TERM: 'api exec wrangler deploy' });
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.rolledBack, []);
  assert.equal(r.deployed.includes('delivery'), false);
});

const CONFIG = `--config ${CONFIG_FILE}`;

test('production commands carry their exact arguments', () => {
  const r = deploy({ CURL_FAIL: 'health/deep' });
  const has = (line: string) => assert.ok(r.calls.includes(line), `${line}\n${r.calls.join('\n')}`);
  has(`--filter @contentworker/engine exec wrangler d1 time-travel info DB --json ${CONFIG}`);
  has(`--filter @contentworker/engine exec wrangler d1 migrations apply DB --remote ${CONFIG}`);
  for (const app of APPS) {
    has(
      `--filter @contentworker/${app} exec wrangler rollback -y -m Deploy failed for abcdef1 ${CONFIG}`,
    );
    if (app === 'web') continue;
    const line = r.calls.find((c) => c.includes(`${app} exec wrangler deploy`)) ?? '';
    assert.ok(line.includes(`wrangler deploy ${CONFIG} --secrets-file `), line);
  }
});

test('a failed bookmark stops the deploy before migrating', () => {
  const r = deploy({ PNPM_FAIL: 'time-travel' });
  assert.notEqual(r.status, 0);
  assert.equal(r.calls.filter((c) => c.includes('time-travel')).length, 3);
  assert.equal(
    r.calls.some((c) => c.includes('migrations apply')),
    false,
  );
});

test('a call that fails once is retried and the deploy carries on', () => {
  const r = deploy({ PNPM_FLAKE: 'api exec wrangler deploy' });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.deployed.filter((a) => a === 'api').length, 2);
  assert.deepEqual(r.rolledBack, []);
});

test('an engine with no earlier version still lets the others roll back', () => {
  const r = deploy({ CURL_FAIL: 'health/deep', NO_EARLIER: 'engine' });
  assert.deepEqual(r.rolledBack, APPS);
});

test('a Worker that fails its rollback does not stop the rest', () => {
  const r = deploy({ CURL_FAIL: 'health/deep', ROLLBACK_FAIL: 'media' });
  assert.deepEqual(r.rolledBack, ['engine', 'media', 'media', 'media', 'api', 'delivery', 'web']);
});

test('an open delivery read fails the smoke test', () => {
  const r = deploy({ DELIVERY_STATUS: '200' });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /anonymous delivery read answered 200/);
  assert.deepEqual(r.rolledBack, APPS);
});

test('a failure log ends by naming what failed, after any rollback', () => {
  const r = deploy({ CURL_FAIL: 'health/deep' });
  const lines = r.out.trim().split('\n');
  assert.match(lines.at(-1) ?? '', /failed at: Smoke test/);
  assert.ok(lines.includes('::group::Roll back'));
});

test('outside CI it refuses, unless told otherwise', () => {
  const r = deploy({ GITHUB_ACTIONS: '' });
  assert.equal(r.status, 1);
  assert.deepEqual(r.calls, []);
  assert.match(r.out, /CONTENTWORKER_DEPLOY=1/);
  assert.equal(deploy({ GITHUB_ACTIONS: '', CONTENTWORKER_DEPLOY: '1' }).status, 0);
});

test('on a workstation, wrangler’s own login stands in for a deploy token', () => {
  const local = { GITHUB_ACTIONS: '', CONTENTWORKER_DEPLOY: '1', CLOUDFLARE_API_TOKEN: '' };
  const r = deploy(local);
  assert.equal(r.status, 0, r.out);
  assert.ok(r.calls.some((c) => c.includes('wrangler whoami')));
  assert.match(r.out, /== Deploy engine/);
  const out = deploy({ ...local, PNPM_FAIL: 'whoami' });
  assert.equal(out.status, 1);
  assert.match(out.out, /Not signed in to Cloudflare/);
  assert.deepEqual(out.deployed, []);
});

test('the database and KV ids are looked up by the install’s names when not given', () => {
  const r = deploy({ D1_ID: '', KV_ID: '' });
  assert.equal(r.status, 0, r.out);
  const engine = JSON.parse(readFileSync(join(ROOT, 'apps', 'engine', CONFIG_FILE), 'utf8'));
  assert.equal(engine.d1_databases[0].database_id, D1_UUID);
  assert.equal(engine.d1_databases[0].database_name, 'contentworker-deploytest');
  assert.equal(engine.kv_namespaces[0].id, KV_ID);
});

test('an install that was never set up stops before migrating', () => {
  const r = deploy({ D1_ID: '', NO_D1: '1' });
  assert.equal(r.status, 1);
  assert.match(r.out, /no D1 database contentworker-deploytest: run scripts\/setup\.sh first/);
  assert.equal(
    r.calls.some((c) => c.includes('migrations apply')),
    false,
  );
});

test('secrets come from the install’s secrets file when the environment has none', () => {
  mkdirSync(dirname(SECRETS_FILE), { recursive: true });
  writeFileSync(
    SECRETS_FILE,
    Object.entries(SECRETS)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  );
  try {
    // An empty variable (an unset CI secret) counts as unset, so the file's value is used.
    const r = deploy(Object.fromEntries(Object.keys(SECRETS).map((k) => [k, ''])));
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /engine: ASSISTANT_PRINCIPAL_KEY, DATA_KEY, TOKEN_PEPPER, MEDIA_SIGNING_SECRET/);
  } finally {
    rmSync(SECRETS_FILE, { force: true });
  }
});

const workflow = readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8');

test('deploy.yml hands over every secret a Worker reads', () => {
  const held = Object.values(APP_SECRETS)
    .flat()
    .filter((k) => !DERIVED[k]);
  for (const k of held) assert.ok(workflow.includes(`${k}: \${{ secrets.${k} }}`), k);
});

test('no build or wrangler call sees the deployment secrets', () => {
  const all = [...workflow.matchAll(/^ {10}([A-Z_]+): \$\{\{ secrets\./gm)].map((m) => m[1]);
  assert.ok(all.includes('DATA_KEY'));
  const env = Object.fromEntries(all.map((k) => [k as string, KEY]));
  const r = deploy(env);
  assert.equal(r.status, 0, r.out);
  assert.ok(r.seen.includes('CLOUDFLARE_API_TOKEN'));
  for (const k of all) assert.equal(r.seen.includes(k as string), false, `${k} reached a child`);
});

test('a cancel through the workflow step stops before the next Worker', async () => {
  const line = /^ +run: (exec scripts\/\S+)$/m.exec(workflow)?.[1] ?? '';
  const { dir, log, env } = setup({ PNPM_HANG: 'api exec wrangler deploy' });
  const step = join(dir, 'step.sh');
  writeFileSync(step, `${line}\n`);
  // The shape of an Actions `run:` step, with the signal sent to that outer shell.
  const job = spawn('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', step], {
    cwd: ROOT,
    env,
    stdio: 'ignore',
  });
  while (!readFileSync(log, 'utf8').includes('api exec wrangler deploy')) await wait(20);
  job.kill('SIGTERM');
  await wait(2500);
  const calls = readFileSync(log, 'utf8');
  assert.equal(calls.includes('delivery exec wrangler deploy'), false);
  assert.equal(calls.includes('rollback'), false);
});
