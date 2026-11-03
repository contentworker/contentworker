#!/usr/bin/env node
/**
 * The type declarations for @contentworker/sdk. TypeScript 7 has no compiler API, so no .d.ts
 * bundler can run; instead each workspace SDK emits its own declarations with `tsc` (their
 * `build`, which turbo runs first), and this copies them into dist/types/<package>/, rewrites any
 * `@contentworker/sdk-*` import inside them to a relative path, and writes one dist/<entry>.d.ts
 * per subpath. Users only ever see @contentworker/sdk.
 */
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

const pkg = new URL('..', import.meta.url).pathname;
const sdkDir = join(pkg, '..');
const dist = join(pkg, 'dist');
const types = join(dist, 'types');

/** Workspace package → its folder under packages/sdk. */
const PACKAGES: Record<string, string> = {
  '@contentworker/sdk-core': 'core',
  '@contentworker/sdk-rich-text': 'rich-text',
  '@contentworker/sdk-edge': 'edge',
  '@contentworker/sdk-management': 'management',
  '@contentworker/sdk-web': 'web',
  '@contentworker/sdk-vue': 'vue',
  '@contentworker/sdk-react-native': 'react-native',
  '@contentworker/sdk-codegen': 'codegen',
};

/** Each published subpath and the workspace module it re-exports. */
const ENTRIES: Record<string, string> = {
  index: '@contentworker/sdk-core',
  'inline-edit': '@contentworker/sdk-core/inline-edit',
  redirects: '@contentworker/sdk-core/redirects',
  webhooks: '@contentworker/sdk-core/webhooks',
  'rich-text': '@contentworker/sdk-rich-text',
  edge: '@contentworker/sdk-edge',
  management: '@contentworker/sdk-management',
  react: '@contentworker/sdk-web',
  vue: '@contentworker/sdk-vue',
  'react-native': '@contentworker/sdk-react-native',
  codegen: '@contentworker/sdk-codegen',
};

/** `@contentworker/sdk-core/webhooks` → dist/types/core/webhooks.d.ts (as a `.js` specifier). */
function target(spec: string): string {
  const name = Object.keys(PACKAGES).find((n) => spec === n || spec.startsWith(`${n}/`));
  if (!name) throw new Error(`no workspace package for ${spec}`);
  const sub = spec.slice(name.length).replace(/^\//, '') || 'index';
  return join(types, PACKAGES[name] ?? '', `${sub}.js`);
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (name.endsWith('.d.ts')) yield path;
  }
}

const specifier = (from: string, to: string) => {
  const rel = relative(dirname(from), to);
  return rel.startsWith('.') ? rel : `./${rel}`;
};

rmSync(types, { recursive: true, force: true });
for (const [name, dir] of Object.entries(PACKAGES)) {
  const src = join(sdkDir, dir, 'dist');
  if (!existsSync(join(src, 'index.d.ts')))
    throw new Error(`${name} has no dist/index.d.ts: build it first`);
  cpSync(src, join(types, dir), {
    recursive: true,
    filter: (p) => statSync(p).isDirectory() || p.endsWith('.d.ts'),
  });
}

// Inside the copied declarations, imports of other workspace SDKs become relative paths.
let rewrites = 0;
for (const file of walk(types)) {
  const before = readFileSync(file, 'utf8');
  const after = before.replace(
    /(['"])(@contentworker\/sdk-[a-z-]+(?:\/[a-z-]+)?)\1/g,
    (_m, q: string, spec: string) => {
      rewrites += 1;
      return `${q}${specifier(file, target(spec))}${q}`;
    },
  );
  if (after !== before) writeFileSync(file, after);
}

for (const [entry, spec] of Object.entries(ENTRIES)) {
  const file = join(dist, `${entry}.d.ts`);
  writeFileSync(file, `export * from '${specifier(file, target(spec))}';\n`);
}

const leftover = [...walk(dist)].filter((f) =>
  /['"]@contentworker\/sdk-/.test(readFileSync(f, 'utf8')),
);
if (leftover.length) throw new Error(`unresolved workspace imports in: ${leftover.join(', ')}`);
console.log(
  `types: ${Object.keys(ENTRIES).length} entries, ${Object.keys(PACKAGES).length} packages, ${rewrites} imports rewritten`,
);
