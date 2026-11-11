/**
 * The turbo cache is only safe if a task's hash moves whenever something its result depends on
 * changes: CI restores the cache between runs and a hit skips the task, so a stale hit is a green
 * check for code that was never checked. This changes one file at a time in a scratch copy of the
 * repository (never the working tree) and compares `turbo run ... --dry=json` hashes before and
 * after. Each case names a file the tasks read from outside their own package, or a file every
 * package reads, and the tasks that must notice it. See the notes at the top of turbo.json.
 *
 * Needs the repository's own turbo (`pnpm install`); reads no cache and runs no task.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const root = join(import.meta.dirname, '..');
const turbo = join(root, 'node_modules/.bin/turbo');
const TASKS = ['lint', 'check-types', 'build', 'test'];

let copy = '';

const turboEnv = { ...process.env, TURBO_TELEMETRY_DISABLED: '1', TURBO_NO_UPDATE_NOTIFIER: '1' };

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: copy, encoding: 'utf8', maxBuffer: 1 << 28 });
}

function dry(env: Record<string, string> = {}): {
  hashes: Map<string, string>;
  envMode: string;
  declaredEnv: string[];
} {
  const out = execFileSync(turbo, ['run', ...TASKS, '--dry=json', '--no-daemon'], {
    cwd: copy,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: { ...turboEnv, ...env },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const json = JSON.parse(out.slice(out.indexOf('{'))) as {
    tasks: {
      taskId: string;
      hash: string;
      envMode: string;
      environmentVariables?: { specified?: { env?: string[] } };
    }[];
  };
  return {
    hashes: new Map(json.tasks.map((t) => [t.taskId, t.hash])),
    envMode: json.tasks[0]?.envMode ?? '',
    declaredEnv: json.tasks.flatMap((t) => t.environmentVariables?.specified?.env ?? []),
  };
}

/** Append to a file in the copy, hash, then undo. */
function changed(file: string, text = '\n'): Set<string> {
  const before = dry().hashes;
  const path = join(copy, file);
  assert.ok(existsSync(path), `${file} exists`);
  appendFileSync(path, text);
  try {
    const after = dry().hashes;
    return new Set([...after].filter(([task, hash]) => before.get(task) !== hash).map(([t]) => t));
  } finally {
    git('checkout', '--', file);
  }
}

function assertMoves(file: string, tasks: string[], text?: string) {
  const moved = changed(file, text);
  for (const task of tasks) {
    assert.ok(moved.has(`@contentworker/${task}`), `${file} must change the hash of ${task}`);
  }
}

describe('turbo cache inputs', () => {
  before(() => {
    assert.ok(existsSync(turbo), 'run `pnpm install` first: this test uses the repository turbo');
    copy = mkdtempSync(join(tmpdir(), 'cw-turbo-'));
    const files = [
      ...execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0'),
      ...execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], {
        cwd: root,
        encoding: 'utf8',
      }).split('\0'),
    ].filter((file) => file && existsSync(join(root, file)));
    for (const file of files) {
      mkdirSync(join(copy, file, '..'), { recursive: true });
      cpSync(join(root, file), join(copy, file));
    }
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'copy');
  });
  after(() => rmSync(copy, { recursive: true, force: true }));

  it('a docs page re-runs the embed and what consumes it', () => {
    assertMoves('docs/architecture.md', [
      'docs#generate',
      'docs#test',
      'http#check-types',
      'http#test',
      'http#build',
      'api#build',
      'engine#build',
      'delivery#build',
    ]);
  });

  it('a docs file outside docs/*.md does not', () => {
    const moved = changed('docs/specs/breakpoint-overrides.md');
    assert.ok(!moved.has('@contentworker/docs#generate'));
  });

  it('a skill re-runs the MCP embed, the API suite and the CLI suite', () => {
    assertMoves('packages/http/skills/author-and-publish/SKILL.md', [
      'http#generate',
      'http#test',
      'api#build',
    ]);
    assertMoves('skills/modeling-content-with-contentworker/SKILL.md', ['cli#test', 'http#test']);
  });

  it('a design token re-runs the themes and the docs site', () => {
    assertMoves('packages/design/src/tokens.ts', [
      'design#generate',
      'design#test',
      'docs-site#build',
      'media#build',
    ]);
  });

  it('files a test reads from another package move that test', () => {
    assertMoves('apps/web/app/app.css', ['design#test']);
    assertMoves('packages/ui/src/button.tsx', ['design#test', 'web#test']);
    assertMoves('apps/docs/src/content/index.mdx', ['design#test', 'cli#test']);
    assertMoves('packages/sdk/vue/src/index.ts', ['cli#test']);
  });

  it('a change reaches the tests of every package that depends on it, not only the direct ones', () => {
    // web does not depend on ports directly (it reaches it through application).
    assertMoves('packages/ports/src/index.ts', ['web#test', 'http#test', 'engine#test']);
    assertMoves('packages/domain/src/index.ts', ['web#test', 'media#test', 'delivery#test']);
  });

  it('a migration moves every suite that runs it', () => {
    assertMoves('packages/db/migrations/0039_promotion_blocks.sql', [
      'db#test',
      'engine#test',
      'media#test',
      'web#test',
      'api#build',
    ]);
  });

  it('files every package reads move every package', () => {
    for (const file of [
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      '.npmrc',
      '.nvmrc',
      'biome.json',
      'packages/typescript-config/base.json',
    ]) {
      const moved = changed(file, file === 'pnpm-lock.yaml' ? '\n# x\n' : '\n');
      for (const task of ['ports#check-types', 'web#build', 'domain#test']) {
        assert.ok(moved.has(`@contentworker/${task}`), `${file} must change the hash of ${task}`);
      }
    }
    // Biome's config is lint's alone to read, but a shared tsconfig and the lockfile are everyone's.
    assertMoves('biome.json', ['ports#lint', 'web#lint']);
  });

  it('a change in a package leaves unrelated packages cached', () => {
    const moved = changed('packages/sdk/vue/src/index.ts');
    assert.ok(!moved.has('@contentworker/domain#test'));
    assert.ok(!moved.has('@contentworker/engine#build'));
    assert.ok(!moved.has('@contentworker/web#test'));
  });

  it('env vars from the shell never reach a task, so none can change a result', () => {
    const base = dry();
    assert.equal(base.envMode, 'strict');
    assert.deepEqual(base.declaredEnv, [], 'a task declares an env var: add a case for it here');
    const other = dry({ AI_MODE: 'live', CLOUDFLARE_API_TOKEN: 'x', NODE_ENV: 'production' });
    assert.deepEqual([...other.hashes], [...base.hashes]);
  });
});
