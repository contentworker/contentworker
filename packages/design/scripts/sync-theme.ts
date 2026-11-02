/**
 * Regenerates the docs' Starlight theme and the diagrams' Mermaid themes from the Ledger tokens:
 *
 *   pnpm sync:theme
 *
 * apps/docs/src/styles/theme.css (Starlight loads it through `customCss`) and
 * docs/diagrams/themes/ledger-{light,dark}.json (mermaid-cli's `-c`) are gitignored build
 * outputs, so two PRs that change tokens can't conflict on them: `pnpm install` (postinstall) and
 * turbo's `generate` task, which runs before every check-types, test, build and dev, write them.
 * tests/tokens.test.ts fails when one is stale, and a PreToolUse hook blocks hand edits.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mermaidThemeJson } from '../src/mermaid';
import { starlightThemeCss } from '../src/tokens';

const out = fileURLToPath(new URL('../../../apps/docs/src/styles/theme.css', import.meta.url));
const css = starlightThemeCss();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, css);
console.log(`wrote ${out} (${css.split('\n').length} lines)`);

for (const scheme of ['light', 'dark'] as const) {
  const file = fileURLToPath(
    new URL(`../../../docs/diagrams/themes/ledger-${scheme}.json`, import.meta.url),
  );
  // The themes are the folder's only files, so a fresh clone has no folder to write them into.
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, mermaidThemeJson(scheme));
  console.log(`wrote ${file}`);
}
