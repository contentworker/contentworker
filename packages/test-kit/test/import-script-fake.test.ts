import type { ImportScriptRun } from '@contentworker/ports';
import { describe, expect, it } from 'vitest';
import { InProcessImportScriptSandbox } from '../src/import-script-fake';
import * as testKit from '../src/index';

const run = (script: string, over: Partial<ImportScriptRun> = {}): ImportScriptRun => ({
  scope: { spaceId: 'space-a', environmentId: 'master' },
  script,
  page: {
    url: 'https://www.example.com/a/',
    html: '<title>A</title><h1>Heading</h1><a href="b">b</a>',
  },
  contentType: { apiId: 'page', name: 'Page', fields: [] },
  timeoutMs: 1_000,
  ...over,
});

describe('InProcessImportScriptSandbox', () => {
  it('is not on the package root, which the platform imports at runtime', () => {
    // Exported there, it would pull linkedom into the api and engine Workers, outside the sandbox.
    expect('InProcessImportScriptSandbox' in testKit).toBe(false);
  });

  it('runs a script over the parsed page, as the Worker Loader sandbox does', async () => {
    const sandbox = new InProcessImportScriptSandbox();
    const result = await sandbox.run(
      run(`export default (page, ctx) => {
        console.log('type', ctx.contentType.apiId);
        return { fields: { title: page.text('h1') }, links: [{ href: page.absolute(page.attr('a', 'href')) }] };
      }`),
    );
    expect(result).toEqual({
      ok: true,
      output: { fields: { title: 'Heading' }, links: [{ href: 'https://www.example.com/a/b' }] },
      logs: ['type page'],
    });
    expect(sandbox.runs).toHaveLength(1);
  });

  it('reports syntax errors, throws and oversized output like the sandbox', async () => {
    const sandbox = new InProcessImportScriptSandbox({
      maxOutputBytes: 50,
      maxLogLines: 10,
      maxLogLineLength: 100,
    });
    expect(await sandbox.run(run('export default () => {{'))).toMatchObject({
      ok: false,
      error: { kind: 'syntax' },
    });
    expect(
      await sandbox.run(run(`export default () => { throw new Error('nope'); }`)),
    ).toMatchObject({ ok: false, error: { kind: 'runtime' } });
    expect(await sandbox.run(run(`export default () => ({ big: 'x'.repeat(100) })`))).toMatchObject(
      { ok: false, error: { kind: 'invalid-output' } },
    );
  });

  it('blocks fetch while a script runs, and puts it back after', async () => {
    const before = globalThis.fetch;
    const result = await new InProcessImportScriptSandbox().run(
      run(`export default async () => { await fetch('https://example.com/'); return {}; }`),
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'runtime' } });
    if (!result.ok) expect(result.error.message).toMatch(/no network access/);
    expect(globalThis.fetch).toBe(before);
  });

  it('stops waiting on an async script at the timeout', async () => {
    const result = await new InProcessImportScriptSandbox().run(
      run(`export default () => new Promise(() => {})`, { timeoutMs: 20 }),
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: 'timeout', message: 'the script did not finish within 20ms' },
      logs: [],
    });
  });
});
