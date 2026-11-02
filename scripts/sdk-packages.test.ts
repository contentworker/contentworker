// The SDKs' npm manifests: what `pnpm pack` publishes (scripts/sdk-packages.ts). Runs in CI with
// `node --test scripts/*.test.ts`; the pack-and-load check runs in .github/workflows/sdk-packages.yml.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { sdkManifests } from './sdk-packages.ts';

const root = new URL('..', import.meta.url).pathname;

test('every SDK publishes its dist/, with an export map mirroring the workspace one', () => {
  const sdks = sdkManifests();
  assert.ok(sdks.length >= 8, 'found the SDKs');
  for (const { dir, manifest } of sdks) {
    const m = manifest as typeof manifest & {
      exports: Record<string, { default: string }>;
      files?: string[];
      repository?: { directory?: string };
      publishConfig?: {
        access?: string;
        provenance?: boolean;
        exports?: Record<string, { import: string; types: string }>;
      };
    };
    assert.deepEqual(m.files, ['dist', 'README.md'], `${m.name}: files`);
    assert.ok(existsSync(join(dir, 'README.md')), `${m.name}: README`);
    assert.equal(m.publishConfig?.access, 'public', `${m.name}: public`);
    assert.equal(m.publishConfig?.provenance, true, `${m.name}: provenance`);
    assert.equal(m.repository?.directory, relative(root, dir), `${m.name}: repository.directory`);
    assert.deepEqual(
      Object.keys(m.publishConfig?.exports ?? {}),
      Object.keys(m.exports),
      `${m.name}: same subpaths published`,
    );
    for (const [sub, src] of Object.entries(m.exports)) {
      const base = src.default.replace(/^\.\/src\//, '').replace(/\.ts$/, '');
      assert.equal(
        m.publishConfig?.exports?.[sub]?.import,
        `./dist/${base}.js`,
        `${m.name} ${sub}: import`,
      );
      assert.equal(
        m.publishConfig?.exports?.[sub]?.types,
        `./dist/${base}.d.ts`,
        `${m.name} ${sub}: types`,
      );
    }
  }
});

test('the SDKs share one version, released together by the sdk-v<version> tag', () => {
  const versions = new Set(sdkManifests().map(({ manifest }) => manifest.version));
  assert.equal(versions.size, 1, `one version for every SDK, found ${[...versions].join(', ')}`);
});
