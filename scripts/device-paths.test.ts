/**
 * The device tests' path filter (scripts/device-paths.ts): its dependency closure is the one turbo
 * computes, and a sample of changed paths lands on the right side.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { closure, firstRelevant, globToRegExp, rootApps, stripJsonc } from './device-paths.ts';

const root = join(import.meta.dirname, '..');
const turbo = join(root, 'node_modules/.bin/turbo');

/** Packages turbo puts in the graph of `<name>...` (the package and everything it depends on). */
function turboClosure(names: string[]): string[] {
  const packages = new Set<string>();
  for (const name of names) {
    const out = execFileSync(
      turbo,
      ['run', 'build', `--filter=${name}...`, '--dry=json', '--no-daemon'],
      { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    for (const pkg of (JSON.parse(out.slice(out.indexOf('{'))) as { packages: string[] })
      .packages) {
      packages.add(pkg);
    }
  }
  return [...packages].filter((pkg) => pkg !== '//').sort();
}

describe('device test path filter', () => {
  it('runs the dev server apps vite.config.ts lists', () => {
    assert.deepEqual(rootApps().sort(), [
      'apps/api',
      'apps/delivery',
      'apps/engine',
      'apps/media',
      'apps/web',
    ]);
  });

  it('closure equals what turbo computes for those apps', () => {
    assert.ok(existsSync(turbo), 'run `pnpm install` first');
    const names = rootApps().map((dir) => `@contentworker/${dir.slice('apps/'.length)}`);
    assert.deepEqual(closure(), turboClosure(names));
  });

  const hit = (...files: string[]) => firstRelevant(files);

  it('runs for what the admin and its dev server load', () => {
    assert.ok(hit('apps/web/app/cms/entry.tsx'));
    assert.ok(hit('apps/web/e2e/shell.spec.ts'));
    assert.ok(hit('apps/api/wrangler.jsonc'));
    assert.ok(hit('packages/domain/src/entry/entry.ts'));
    assert.ok(hit('packages/db/migrations/0040_x.sql'));
    assert.ok(hit('packages/http/skills/author-and-publish/SKILL.md'));
    assert.ok(hit('packages/sdk/core/src/index.ts'));
    assert.ok(hit('pnpm-lock.yaml'));
    assert.ok(hit('pnpm-workspace.yaml'));
    assert.ok(hit('.github/workflows/ci.yml'));
    assert.ok(hit('docs/architecture.md'), 'docs/*.md feeds the docs embed the api bundles');
  });

  it('skips what they never load', () => {
    assert.equal(hit('apps/web/tests/entry-form.test.tsx'), undefined);
    assert.equal(hit('packages/domain/test/entry.test.ts'), undefined);
    assert.equal(hit('packages/sdk/core/test/x.test.ts'), undefined);
    assert.equal(hit('packages/http/README.md'), undefined);
    assert.equal(hit('apps/docs/src/content/index.mdx'), undefined);
    assert.equal(hit('packages/sdk/vue/src/index.ts'), undefined);
    assert.equal(
      hit('scripts/fleet.ts', '.claude/hooks/x.sh', 'README.md', 'docs/specs/x.md'),
      undefined,
    );
    assert.equal(hit('.github/workflows/deploy.yml', 'examples/fleet/x.jsonc'), undefined);
  });

  it('returns the first path that matters', () => {
    assert.equal(
      hit('README.md', 'apps/web/app/root.tsx', 'pnpm-lock.yaml'),
      'apps/web/app/root.tsx',
    );
  });

  it('reads turbo.json comments and URLs', () => {
    assert.deepEqual(JSON.parse(stripJsonc('{ // c\n "a": "https://x/y", /* b */ "b": [1,], }')), {
      a: 'https://x/y',
      b: [1],
    });
  });

  it('globs', () => {
    assert.ok(globToRegExp('docs/*.md').test('docs/a.md'));
    assert.ok(!globToRegExp('docs/*.md').test('docs/diagrams/a.md'));
    assert.ok(globToRegExp('apps/web/**').test('apps/web/a/b.ts'));
    assert.ok(globToRegExp('packages/*/src/**').test('packages/x/src/a/b.ts'));
    assert.ok(!globToRegExp('apps/web/**').test('apps/webx/a.ts'));
  });
});
