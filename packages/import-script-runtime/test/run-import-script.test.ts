import { describe, expect, it } from 'vitest';
import { IMPORT_SCRIPT_RUNTIME, IMPORT_SCRIPT_RUNTIME_HASH } from '../src/bundle.generated';
import { type ImportScriptRunLimits, runImportScript } from '../src/index';

const input = {
  page: {
    url: 'https://www.example.com/blog/hello',
    html: '<title>Hello</title><h1>Hello</h1><p>Body</p>',
  },
  contentType: { apiId: 'article', name: 'Article', fields: [] },
};
const limits: ImportScriptRunLimits = {
  maxOutputBytes: 1_000,
  maxLogLines: 3,
  maxLogLineLength: 20,
};

/** A module as `import()` would hand it back. */
const loads = (mod: Record<string, unknown>) => () => Promise.resolve(mod);

describe('runImportScript', () => {
  it('calls a default-exported function with the parsed page and the context', async () => {
    const result = await runImportScript(
      loads({
        default: (
          page: { text(s: string): string },
          ctx: { url: string; contentType: unknown },
        ) => ({
          fields: { title: page.text('h1') },
          url: ctx.url,
          type: (ctx.contentType as { apiId: string }).apiId,
        }),
      }),
      input,
      limits,
    );
    expect(result).toEqual({
      ok: true,
      output: JSON.stringify({ fields: { title: 'Hello' }, url: input.page.url, type: 'article' }),
      logs: [],
    });
  });

  it('accepts a function exported as transform, and awaits an async one', async () => {
    const result = await runImportScript(
      loads({ transform: async () => ({ fields: {} }) }),
      input,
      limits,
    );
    expect(result).toMatchObject({ ok: true, output: '{"fields":{}}' });
  });

  it('refuses a module with neither, rather than guessing', async () => {
    for (const mod of [{}, { default: { transform: () => ({}) } }, { transformDOM: () => ({}) }]) {
      const result = await runImportScript(loads(mod), input, limits);
      expect(result).toMatchObject({ ok: false, error: { kind: 'runtime' } });
      if (!result.ok)
        expect(result.error.message).toMatch(/default function or a function named transform/);
    }
  });

  it('reports a module that does not parse as a syntax error', async () => {
    const result = await runImportScript(
      () => Promise.reject(new SyntaxError('Unexpected end of input')),
      input,
      limits,
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'syntax' } });
    if (!result.ok) expect(result.error.message).toMatch(/^SyntaxError: Unexpected end of input/);
  });

  it('reports a throw while loading, or in the transform, as a runtime error with the logs so far', async () => {
    const loading = await runImportScript(() => Promise.reject(new Error('top')), input, limits);
    expect(loading).toMatchObject({ ok: false, error: { kind: 'runtime' } });
    if (!loading.ok) expect(loading.error.message).toMatch(/^while loading the script: Error: top/);

    const throwing = await runImportScript(
      loads({
        default: () => {
          console.log('reading', 1);
          throw new TypeError('boom');
        },
      }),
      input,
      limits,
    );
    expect(throwing).toMatchObject({
      ok: false,
      error: { kind: 'runtime' },
      logs: ['reading 1'],
    });
    if (!throwing.ok) expect(throwing.error.message).toMatch(/^TypeError: boom/);

    const thrownValue = await runImportScript(
      loads({
        default: () => {
          throw 'plain';
        },
      }),
      input,
      limits,
    );
    expect(thrownValue).toMatchObject({ ok: false, error: { kind: 'runtime', message: 'plain' } });
  });

  it('refuses output that is not JSON, is missing, or is over the limit', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [cyclic, { n: 1n }, undefined, () => 1, { big: 'x'.repeat(1_000) }]) {
      const result = await runImportScript(loads({ default: () => value }), input, limits);
      expect(result).toMatchObject({ ok: false, error: { kind: 'invalid-output' } });
    }
    const over = await runImportScript(
      loads({ default: () => ({ big: 'x'.repeat(1_000) }) }),
      input,
      limits,
    );
    if (!over.ok)
      expect(over.error.message).toBe('the output is 1010 bytes, over the 1000-byte limit');
  });

  it('bounds the logs and puts the console back', async () => {
    const before = console.log;
    const result = await runImportScript(
      loads({
        default: () => {
          console.warn('careful');
          console.log({ a: 1 });
          console.info('a line far longer than twenty characters');
          console.error('dropped');
          console.debug('dropped too');
          return {};
        },
      }),
      input,
      limits,
    );
    expect(result.logs).toEqual([
      'warn: careful',
      '{"a":1}',
      'a line far longer t…',
      '… 2 more lines not kept',
    ]);
    expect(console.log).toBe(before);
  });
});

describe('the bundled runtime', () => {
  it('is one self-contained module that runs a script', async () => {
    expect(IMPORT_SCRIPT_RUNTIME_HASH).toMatch(/^[0-9a-f]{16}$/);
    // No bare imports left for a sandbox to resolve: everything, linkedom included, is inlined.
    expect(IMPORT_SCRIPT_RUNTIME).not.toMatch(/(^|;)\s*import[\s{*]/);
    expect(IMPORT_SCRIPT_RUNTIME).not.toMatch(/\brequire\(/);
    const runtime = (await import(
      /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(IMPORT_SCRIPT_RUNTIME)}`
    )) as { runImportScript: typeof runImportScript };
    const result = await runtime.runImportScript(
      loads({ default: (page: { text(s: string): string }) => ({ title: page.text('h1') }) }),
      input,
      limits,
    );
    expect(result).toEqual({ ok: true, output: '{"title":"Hello"}', logs: [] });
  });
});
