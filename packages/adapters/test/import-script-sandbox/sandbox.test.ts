import type { ImportScriptRun } from '@contentworker/ports';
import { describe, expect, it } from 'vitest';
import {
  createWorkerLoaderImportScriptSandbox,
  ENTRY_MODULE,
  ENTRY_SOURCE,
  IMPORT_SCRIPT_ENTRYPOINT_CLASS,
  type ImportScriptLoaderBinding,
  isolateKey,
  RUNTIME_MODULE,
  SCRIPT_MODULE,
} from '../../src/import-script-sandbox/index';

/**
 * A stand-in for the Worker Loader binding. It records what it was asked to load and answers
 * `run` with whatever the test hands it, which is how the host's own checks are exercised: what
 * workerd does with the config is proven in workerd.test.ts.
 */
function fakeLoader(answer: (...args: unknown[]) => Promise<unknown>) {
  const loads: { id: string; config: Record<string, unknown> }[] = [];
  const entrypoints: { name?: string; options?: unknown }[] = [];
  const cache = new Map<string, Record<string, unknown>>();
  const binding: ImportScriptLoaderBinding = {
    get(id, supplier) {
      if (!cache.has(id)) {
        const config = supplier() as unknown as Record<string, unknown>;
        cache.set(id, config);
        loads.push({ id, config });
      }
      return {
        getEntrypoint: (name, options) => {
          entrypoints.push({ name, options });
          return { run: answer };
        },
      };
    },
  };
  return { binding, loads, entrypoints };
}

const run = (over: Partial<ImportScriptRun> = {}): ImportScriptRun => ({
  scope: { spaceId: 'space-a', environmentId: 'master' },
  script: 'export default (page) => ({ title: page.title })',
  page: { url: 'https://www.example.com/', html: '<title>Home</title>' },
  contentType: { apiId: 'page', name: 'Page', fields: [] },
  timeoutMs: 1_000,
  ...over,
});

const answers = (value: unknown) => async () => value;

describe('isolation settings', () => {
  it('loads the script with no network, no bindings and a CPU limit, beside the runtime', async () => {
    const { binding, loads, entrypoints } = fakeLoader(
      answers({ ok: true, output: '{}', logs: [] }),
    );
    const sandbox = createWorkerLoaderImportScriptSandbox(binding, { maxTimeoutMs: 5_000 });
    await sandbox.run(run({ timeoutMs: 2_000 }));

    const config = loads[0]?.config ?? {};
    expect(config.globalOutbound).toBeNull();
    expect(config.env).toEqual({});
    expect(config.limits).toEqual({ cpuMs: 5_000 });
    expect(config.mainModule).toBe(ENTRY_MODULE);
    const modules = config.modules as Record<string, string>;
    expect(Object.keys(modules).sort()).toEqual(
      [ENTRY_MODULE, RUNTIME_MODULE, SCRIPT_MODULE].sort(),
    );
    expect(modules[SCRIPT_MODULE]).toBe(run().script);
    expect(modules[ENTRY_MODULE]).toBe(ENTRY_SOURCE);
    expect(modules[RUNTIME_MODULE]).toContain('runImportScript');
    // The call's own CPU limit is the run's timeout; workerd applies the lower of the two.
    expect(entrypoints[0]).toEqual({
      name: IMPORT_SCRIPT_ENTRYPOINT_CLASS,
      options: { limits: { cpuMs: 2_000 } },
    });
  });

  it('keys isolates by space, environment and script, so none of them reuse another one', async () => {
    const { binding, loads } = fakeLoader(answers({ ok: true, output: '{}', logs: [] }));
    const sandbox = createWorkerLoaderImportScriptSandbox(binding);
    const a = { spaceId: 'space-a', environmentId: 'master' };
    await sandbox.run(run());
    await sandbox.run(run({ page: { url: 'https://www.example.com/2', html: '' } }));
    await sandbox.run(run({ scope: { spaceId: 'space-b', environmentId: 'master' } }));
    await sandbox.run(run({ scope: { spaceId: 'space-a', environmentId: 'staging' } }));
    await sandbox.run(run({ script: 'export default () => ({})' }));

    expect(loads.map((l) => l.id)).toEqual([
      await isolateKey(a, run().script),
      await isolateKey({ spaceId: 'space-b', environmentId: 'master' }, run().script),
      await isolateKey({ spaceId: 'space-a', environmentId: 'staging' }, run().script),
      await isolateKey(a, 'export default () => ({})'),
    ]);
    expect(loads[0]?.id).toMatch(/^import-script:space-a\/master\/[0-9a-f]{64}#[0-9a-f]{16}\.e2$/);
  });

  it('hands the isolate plain data only, with the output and log limits', async () => {
    const calls: unknown[][] = [];
    const { binding } = fakeLoader(async (...args) => {
      calls.push(args);
      return { ok: true, output: '{}', logs: [] };
    });
    const sandbox = createWorkerLoaderImportScriptSandbox(binding, { maxOutputBytes: 500 });
    await sandbox.run(run());
    expect(calls[0]).toEqual([
      { page: run().page, contentType: run().contentType },
      { maxOutputBytes: 500, maxLogLines: 100, maxLogLineLength: 1_000 },
    ]);
  });

  it('refuses a script or a page over the size limits before loading anything', async () => {
    const { binding, loads } = fakeLoader(answers({ ok: true, output: '{}', logs: [] }));
    const sandbox = createWorkerLoaderImportScriptSandbox(binding, {
      maxScriptBytes: 10,
      maxHtmlBytes: 10,
    });
    await expect(sandbox.run(run())).rejects.toThrow(RangeError);
    await expect(
      sandbox.run(run({ script: 'x', page: { url: 'https://x.example/', html: 'é'.repeat(6) } })),
    ).rejects.toThrow(/page HTML is 12 bytes, over 10/);
    expect(loads).toHaveLength(0);
  });

  it('refuses a timeout that is not a positive number', async () => {
    const { binding, loads } = fakeLoader(answers({ ok: true, output: '{}', logs: [] }));
    const sandbox = createWorkerLoaderImportScriptSandbox(binding);
    for (const timeoutMs of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      await expect(sandbox.run(run({ timeoutMs }))).rejects.toThrow(RangeError);
    }
    expect(loads).toHaveLength(0);
  });
});

describe('results', () => {
  it('parses the output the isolate serialised', async () => {
    const { binding } = fakeLoader(
      answers({ ok: true, output: '{"fields":{"title":"Home"}}', logs: ['hello'] }),
    );
    const result = await createWorkerLoaderImportScriptSandbox(binding).run(run());
    expect(result).toEqual({ ok: true, output: { fields: { title: 'Home' } }, logs: ['hello'] });
  });

  it("passes the runtime's own failures through", async () => {
    const { binding } = fakeLoader(
      answers({ ok: false, error: { kind: 'runtime', message: 'TypeError: boom' }, logs: ['a'] }),
    );
    const result = await createWorkerLoaderImportScriptSandbox(binding).run(run());
    expect(result).toEqual({
      ok: false,
      error: { kind: 'runtime', message: 'TypeError: boom' },
      logs: ['a'],
    });
  });

  // A script can rewrite the runtime's globals (JSON, console) inside its isolate, so what comes
  // back is checked again here rather than trusted.
  it('re-checks what the isolate answered: size, JSON, shape and log bounds', async () => {
    const check = async (answer: unknown, options = {}) =>
      createWorkerLoaderImportScriptSandbox(fakeLoader(answers(answer)).binding, options).run(
        run(),
      );

    expect(
      await check({ ok: true, output: `"${'x'.repeat(200)}"`, logs: [] }, { maxOutputBytes: 100 }),
    ).toMatchObject({
      ok: false,
      error: {
        kind: 'invalid-output',
        message: 'the output is over the 100-byte limit',
      },
    });
    // Under the limit in characters, over it in UTF-8 bytes.
    expect(
      await check({ ok: true, output: `"${'é'.repeat(60)}"`, logs: [] }, { maxOutputBytes: 100 }),
    ).toMatchObject({
      ok: false,
      error: {
        kind: 'invalid-output',
        message: 'the output is 122 bytes, over the 100-byte limit',
      },
    });
    expect(await check({ ok: true, output: '{not json', logs: [] })).toMatchObject({
      ok: false,
      error: { kind: 'invalid-output', message: 'the output is not JSON' },
    });
    expect(await check({ ok: true, output: { already: 'structured' }, logs: [] })).toMatchObject({
      ok: false,
      error: { kind: 'invalid-output' },
    });
    expect(
      await check({ ok: false, error: { kind: 'root', message: 'x' }, logs: [] }),
    ).toMatchObject({
      ok: false,
      error: { kind: 'invalid-output', message: 'the sandbox returned an unrecognised result' },
    });
    expect(await check('nonsense')).toMatchObject({ ok: false, error: { kind: 'invalid-output' } });

    const noisy = await check({
      ok: true,
      output: '{}',
      logs: [
        7,
        { toString: () => 'z'.repeat(5_000) },
        ...Array.from({ length: 500 }, () => 'y'.repeat(5_000)),
      ],
    });
    // Non-strings are dropped, not converted.
    expect(noisy.logs).toHaveLength(99);
    expect(noisy.logs.every((l) => l.startsWith('y') && l.length <= 1_000)).toBe(true);
  });
});

describe('failures the host sees', () => {
  it('stops waiting at the timeout, capped by the sandbox maximum', async () => {
    const { binding, entrypoints } = fakeLoader(() => new Promise(() => {}));
    const sandbox = createWorkerLoaderImportScriptSandbox(binding, { maxTimeoutMs: 30 });
    const started = Date.now();
    const result = await sandbox.run(run({ timeoutMs: 60_000 }));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'timeout', message: 'the script did not finish within 30ms' },
      logs: [],
    });
    expect(entrypoints[0]?.options).toEqual({ limits: { cpuMs: 30 } });
  });

  it('classifies what workerd throws: a module that does not parse, CPU, a hung promise', async () => {
    const thrown = async (message: string) =>
      createWorkerLoaderImportScriptSandbox(
        fakeLoader(() => Promise.reject(new Error(message))).binding,
      ).run(run());

    // As workerd words them (workerd.test.ts sees the first and last for real).
    expect(
      await thrown(
        'Failed to start Worker:\nUncaught SyntaxError: Unexpected end of input\n  at script.js:1:25',
      ),
    ).toEqual({
      ok: false,
      error: {
        kind: 'syntax',
        message: 'SyntaxError: Unexpected end of input\n  at script.js:1:25',
      },
      logs: [],
    });
    expect(await thrown('Worker exceeded CPU time limit.')).toMatchObject({
      error: { kind: 'timeout', message: 'the script ran out of CPU time' },
    });
    expect(
      await thrown(
        "The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response.",
      ),
    ).toMatchObject({ error: { kind: 'timeout' } });
    expect(await thrown('Worker exceeded memory limit.')).toMatchObject({
      error: { kind: 'runtime', message: 'Worker exceeded memory limit.' },
    });
  });

  it('reports an unexpected sandbox failure to the operator, clipped', async () => {
    const reported: unknown[][] = [];
    const sandbox = createWorkerLoaderImportScriptSandbox(
      fakeLoader(() => Promise.reject(new Error('loader unavailable'))).binding,
      { onError: (...args) => reported.push(args) },
    );
    expect(await sandbox.run(run())).toMatchObject({ ok: false, error: { kind: 'runtime' } });
    expect(reported).toEqual([
      ['import script failed in the sandbox: loader unavailable', 'loader unavailable'],
    ]);

    // The message is the script's to choose; a megabyte of it never reaches the logs.
    reported.length = 0;
    await createWorkerLoaderImportScriptSandbox(
      fakeLoader(() => Promise.reject(new Error('m'.repeat(1_000_000)))).binding,
      { onError: (...args) => reported.push(args) },
    ).run(run());
    expect(String(reported[0]?.[0]).length).toBeLessThan(2_100);
    expect(String(reported[0]?.[1]).length).toBeLessThanOrEqual(2_000);
  });
});
