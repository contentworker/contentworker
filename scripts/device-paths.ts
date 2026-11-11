/**
 * Which changed files can alter what the device tests (apps/web/e2e) run against.
 *
 *   node scripts/device-paths.ts list     the patterns, one per line
 *   node scripts/device-paths.ts match    read changed paths on stdin; print the first that
 *                                         matters and exit 0, or exit 1 when none does
 *
 * Nothing here is a hand-kept path list. The device tests start `react-router dev` for apps/web,
 * which runs the api, engine, media and delivery Workers beside it as auxiliary Workers
 * (`auxiliaryWorkers` in apps/web/vite.config.ts). So the code under test is those five apps plus
 * every workspace package any of them depends on, transitively (`workspace:` dependencies in each
 * package.json). Both halves are read from the repository:
 *
 *   - the roots from `auxiliaryWorkers` in apps/web/vite.config.ts,
 *   - the closure from the packages' manifests (scripts/device-paths.test.ts checks it equals
 *     `turbo run build --filter=<root>...`, so the two cannot drift apart),
 *   - files outside a package that feed what it generates, from the `$TURBO_ROOT$/...` entries in
 *     turbo.json `inputs` of its `generate` task (docs/*.md feeds the docs embed, for one).
 *
 * Plus what every install and every run reads (the manifests at the root, the lockfile, the
 * workspace file, .npmrc, .nvmrc, turbo.json) and this workflow's own file. Unit-test files and
 * READMEs inside the closure are excluded: the dev server never loads them.
 *
 * Used by the `changes` job in .github/workflows/ci.yml. Needs only Node and a checkout.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** The root's own inputs: every install and every run reads them, so any change can matter. */
export const ROOT_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'turbo.json',
  '.npmrc',
  '.nvmrc',
  '.github/workflows/ci.yml',
];

/** Files in a package the dev server never loads. */
export const NEVER_LOADED = [
  /\.test\.tsx?$/,
  /^packages\/[^/]+\/test\//,
  /^packages\/sdk\/[^/]+\/test\//,
  /^apps\/[^/]+\/tests?\//,
  /(^|\/)(README|CHANGELOG)\.md$/,
];

/** Glob to RegExp: `**` crosses directories, `*` stays within one. */
export function globToRegExp(glob: string): RegExp {
  let body = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*' && glob[i + 1] === '*') {
      // `**/` is any directories (or none); a trailing `**` is anything.
      if (glob[i + 2] === '/') {
        body += '(?:.*/)?';
        i += 2;
      } else {
        body += '.*';
        i += 1;
      }
    } else if (c === '*') {
      body += '[^/]*';
    } else if (c === '?') {
      body += '[^/]';
    } else {
      body += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${body}$`);
}

/** JSONC to JSON, leaving anything inside a string alone. */
export function stripJsonc(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Workspace packages: name to directory, from the globs in pnpm-workspace.yaml. */
export function workspacePackages(base = root): Map<string, { dir: string; manifest: Manifest }> {
  const yaml = readFileSync(join(base, 'pnpm-workspace.yaml'), 'utf8');
  const globs = [...yaml.matchAll(/^\s+-\s+["']?([^"'\s#]+)["']?\s*$/gm)]
    .map((m) => m[1] as string)
    .filter((g) => g.endsWith('/*'));
  const found = new Map<string, { dir: string; manifest: Manifest }>();
  for (const glob of globs) {
    const parent = glob.slice(0, -2);
    if (!existsSync(join(base, parent))) continue;
    for (const entry of readdirSync(join(base, parent), { withFileTypes: true })) {
      const dir = `${parent}/${entry.name}`;
      const file = join(base, dir, 'package.json');
      if (!entry.isDirectory() || !existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
      found.set(manifest.name, { dir, manifest });
    }
  }
  return found;
}

/** The apps the dev server runs: apps/web, and what its vite config lists as auxiliary Workers. */
export function rootApps(base = root): string[] {
  const vite = readFileSync(join(base, 'apps/web/vite.config.ts'), 'utf8');
  const list = /auxiliaryWorkers:\s*\[([^\]]*)\]/.exec(vite)?.[1];
  if (!list) throw new Error('apps/web/vite.config.ts no longer lists auxiliaryWorkers');
  const dirs = [...list.matchAll(/'\.\.\/([^']+)'/g)].map((m) => `apps/${m[1]}`);
  return ['apps/web', ...dirs];
}

/** Package names reachable from the roots through `workspace:` dependencies. */
export function closure(base = root): string[] {
  const all = workspacePackages(base);
  const byDir = new Map([...all].map(([name, p]) => [p.dir, name]));
  const queue = rootApps(base).map((dir) => {
    const name = byDir.get(dir);
    if (!name) throw new Error(`${dir} is not a workspace package`);
    return name;
  });
  const seen = new Set<string>();
  while (queue.length) {
    const name = queue.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const { manifest } = all.get(name) as { manifest: Manifest };
    for (const [dep, spec] of Object.entries({
      ...manifest.devDependencies,
      ...manifest.dependencies,
    })) {
      if (spec.startsWith('workspace:') && all.has(dep)) queue.push(dep);
    }
  }
  return [...seen].sort();
}

/**
 * Files outside a package that feed what it generates (the embeds and themes the dev server
 * bundles): the `$TURBO_ROOT$/...` entries in `inputs` of a package's `generate` task, in its own
 * turbo.json (or a `<package>#generate` task in the root's), for a package in the closure. Other
 * tasks' outside inputs (a test reading another package's files) are for the suites, not the dev
 * server.
 */
export function externalInputs(names: string[], base = root): string[] {
  type TurboConfig = { tasks?: Record<string, { inputs?: string[] }> };
  const read = (file: string): TurboConfig | undefined =>
    existsSync(file) ? JSON.parse(stripJsonc(readFileSync(file, 'utf8'))) : undefined;
  const inputs = new Set<string>();
  const add = (generate: { inputs?: string[] } | undefined) => {
    for (const input of generate?.inputs ?? []) {
      if (input.startsWith('$TURBO_ROOT$/')) inputs.add(input.slice('$TURBO_ROOT$/'.length));
    }
  };
  const all = workspacePackages(base);
  const rootTasks = read(join(base, 'turbo.json'))?.tasks ?? {};
  for (const name of names) {
    add(read(join(base, (all.get(name) as { dir: string }).dir, 'turbo.json'))?.tasks?.generate);
    add(rootTasks[`${name}#generate`]);
  }
  return [...inputs].sort();
}

export function patterns(base = root): string[] {
  const names = closure(base);
  const all = workspacePackages(base);
  const dirs = names.map((name) => `${(all.get(name) as { dir: string }).dir}/**`);
  return [...ROOT_FILES, ...dirs, ...externalInputs(names, base)];
}

/** The first changed path that matters, or undefined. */
export function firstRelevant(files: string[], base = root): string | undefined {
  const include = patterns(base).map(globToRegExp);
  const external = externalInputs(closure(base), base).map(globToRegExp);
  return files.find((file) => {
    if (external.some((re) => re.test(file))) return true;
    if (NEVER_LOADED.some((re) => re.test(file))) return false;
    return include.some((re) => re.test(file));
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [command] = process.argv.slice(2);
  if (command === 'list') {
    console.log(patterns().join('\n'));
  } else if (command === 'match') {
    const files = readFileSync(0, 'utf8').split('\n').filter(Boolean);
    const hit = firstRelevant(files);
    if (hit) console.log(hit);
    process.exit(hit ? 0 : 1);
  } else {
    console.error('usage: device-paths.ts list | match');
    process.exit(2);
  }
}
