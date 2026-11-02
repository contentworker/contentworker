/**
 * The public SDKs (packages/sdk/*) as npm sees them.
 *
 *   node scripts/sdk-packages.ts pack     build every SDK and pack it into .sdk-packages/
 *   node scripts/sdk-packages.ts check    install the tarballs into an empty project and load
 *                                          every export (ESM and CJS) and the codegen binary
 *   node scripts/sdk-packages.ts publish  publish each tarball whose version npm doesn't have yet
 *
 * In the workspace the SDKs resolve to src/*.ts; `pnpm pack` applies each package's
 * `publishConfig` (exports and bin pointing at dist/) and rewrites `workspace:` and `catalog:`
 * versions, so `check` tests exactly what a user installs. `publish` runs in
 * .github/workflows/sdk-release.yml with npm trusted publishing and provenance; never by hand.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const out = join(root, '.sdk-packages');

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  bin?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  publishConfig?: { exports?: Record<string, { import: string; require?: string; types: string }> };
}

export function sdkManifests(): { dir: string; manifest: Manifest }[] {
  const base = join(root, 'packages/sdk');
  return readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({
      dir: join(base, d.name),
      manifest: JSON.parse(readFileSync(join(base, d.name, 'package.json'), 'utf8')) as Manifest,
    }))
    .filter(({ manifest }) => !manifest.private)
    .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

const run = (cmd: string, args: string[], cwd = root) =>
  execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });

function tarballs(): string[] {
  return readdirSync(out)
    .filter((f) => f.endsWith('.tgz'))
    .map((f) => join(out, f));
}

function pack(): void {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const { dir, manifest } of sdkManifests()) {
    run('pnpm', ['--filter', manifest.name, 'build']);
    run('pnpm', ['pack', '--pack-destination', out], dir);
    console.log(`packed ${manifest.name}@${manifest.version}`);
  }
}

function catalogVersion(name: string): string {
  const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const m = new RegExp(`^\\s+${name}:\\s*(\\S+)`, 'm').exec(yaml);
  if (!m?.[1]) throw new Error(`${name} is not in the pnpm catalog`);
  return m[1].replace(/^['"]|['"]$/g, '');
}

function check(): void {
  const project = mkdtempSync(join(tmpdir(), 'sdk-check-'));
  try {
    writeFileSync(
      join(project, 'package.json'),
      '{ "name": "sdk-check", "private": true, "type": "module" }\n',
    );
    const peers = new Set<string>();
    for (const { manifest } of sdkManifests()) {
      for (const p of Object.keys(manifest.peerDependencies ?? {})) peers.add(p);
    }
    run(
      'npm',
      [
        'install',
        '--no-audit',
        '--no-fund',
        ...tarballs(),
        ...[...peers].map((p) => `${p}@${catalogVersion(p)}`),
      ],
      project,
    );
    const failures: string[] = [];
    for (const { manifest } of sdkManifests()) {
      for (const [sub, target] of Object.entries(manifest.publishConfig?.exports ?? {})) {
        const spec = sub === '.' ? manifest.name : `${manifest.name}/${sub.slice(2)}`;
        try {
          run(
            'node',
            [
              '--input-type=module',
              '-e',
              `const m = await import(${JSON.stringify(spec)}); if (!Object.keys(m).length) throw new Error('no exports');`,
            ],
            project,
          );
          if (target.require) {
            run(
              'node',
              [
                '-e',
                `const m = require(${JSON.stringify(spec)}); if (!Object.keys(m).length) throw new Error('no exports');`,
              ],
              project,
            );
          }
          console.log(`ok   ${spec}${target.require ? ' (esm + cjs)' : ' (esm)'}`);
        } catch (error) {
          failures.push(`${spec}: ${String(error).split('\n')[0]}`);
        }
      }
      for (const bin of Object.keys(manifest.bin ?? {})) {
        try {
          run('node', ['--check', join(project, 'node_modules/.bin', bin)], project);
          console.log(`ok   bin ${bin}`);
        } catch (error) {
          failures.push(`bin ${bin}: ${String(error).split('\n')[0]}`);
        }
      }
    }
    if (failures.length) {
      console.error(`\n${failures.length} export(s) failed to load:\n${failures.join('\n')}`);
      process.exitCode = 1;
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function publish(): void {
  for (const { manifest } of sdkManifests()) {
    let published = false;
    try {
      published =
        run('npm', ['view', `${manifest.name}@${manifest.version}`, 'version']).trim() ===
        manifest.version;
    } catch {
      // not on npm yet
    }
    if (published) {
      console.log(`skip ${manifest.name}@${manifest.version}: already on npm`);
      continue;
    }
    const file = tarballs().find((t) =>
      t.includes(manifest.name.replace('@', '').replace('/', '-')),
    );
    if (!file) throw new Error(`no tarball for ${manifest.name}; run pack first`);
    run('npm', ['publish', file, '--provenance', '--access', 'public']);
    console.log(`published ${manifest.name}@${manifest.version}`);
  }
}

const command = process.argv[2];
if (import.meta.url === `file://${process.argv[1]}`) {
  if (command === 'pack') pack();
  else if (command === 'check') check();
  else if (command === 'publish') publish();
  else {
    console.error('Usage: node scripts/sdk-packages.ts pack | check | publish');
    process.exitCode = 1;
  }
}
