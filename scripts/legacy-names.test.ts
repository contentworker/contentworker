import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// contentworker was scaffolded from another of the same owner's products. Nothing of that product's
// name belongs in this repository: not in code, docs, configs, package names or agent settings.
// Spelled in pieces so this file doesn't match itself.
const LEGACY = new RegExp(['order', 'loop'].join(''), 'i');

const root = join(import.meta.dirname, '..');

test('no tracked file names the product this repository was scaffolded from', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const offenders = files.filter((file) => {
    let text: string;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      return false; // deleted in the working tree, or not a regular file
    }
    return LEGACY.test(text) || LEGACY.test(file);
  });
  assert.deepEqual(offenders, []);
});
