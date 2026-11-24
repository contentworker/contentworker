import { join } from 'node:path';
import type { ImportScriptResult, ImportScriptRun } from '@contentworker/ports';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The sandbox against a real workerd and a real Worker Loader binding (Miniflare): the isolation
 * properties the adapter's unit tests can only assert as configuration are observed here.
 *
 * The host is a plain Miniflare Worker rather than the Workers Vitest pool, because the pool
 * proxies bindings into the test isolate and a dynamically loaded Worker's entrypoint cannot
 * cross that proxy (apps/engine/vitest.config.ts). The host calls the loader from its own fetch
 * handler, as the api and engine do.
 *
 * Not covered here: a CPU-bound busy loop. workerd enforces `limits.cpuMs` only on Cloudflare,
 * and locally a loop that never yields also starves the host's timer, so it would hang the
 * suite; the unit tests pin the limit the adapter asks for.
 */

let mf: Miniflare;

beforeAll(async () => {
  const bundle = await build({
    entryPoints: [join(import.meta.dirname, 'fixtures', 'host.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2023',
    write: false,
    external: ['cloudflare:*'],
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0]?.text ?? '',
      // Production's date (apps/api/wrangler.jsonc).
      compatibilityDate: '2026-10-01',
      compatibilityFlags: ['nodejs_compat'],
      workerLoaders: { LOADER: {} },
    }),
  );
  await mf.ready;
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

const page = {
  url: 'https://www.example.com/blog/hello',
  html: `<html><head><title>Hello | Blog</title><meta property="og:image" content="/og.png">
    <script type="application/ld+json">{"@type":"BlogPosting","headline":"Hello"}</script></head>
    <body><h1> Hello </h1><article><p>First <a href="/about">about</a></p><img src="a.png" alt="A"></article></body></html>`,
};

async function sandboxRun(
  script: string,
  over: Partial<ImportScriptRun> = {},
): Promise<ImportScriptResult> {
  const input: ImportScriptRun = {
    scope: { spaceId: 'space-a', environmentId: 'master' },
    script,
    page,
    contentType: { apiId: 'post', name: 'Post', fields: [] },
    timeoutMs: 2_000,
    ...over,
  };
  const res = await mf.dispatchFetch('http://host/', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return (await res.json()) as ImportScriptResult;
}

describe('import scripts in workerd', { timeout: 30_000 }, () => {
  it('runs a script over the parsed page and returns structured output with its logs', async () => {
    const result = await sandboxRun(`
      export default function transform(page, ctx) {
        console.log('importing', ctx.url);
        return {
          fields: { title: page.text('h1'), image: page.absolute(page.meta('og:image')) },
          blocks: [{ variant: 'text', fields: { body: page.html('article p') } }],
          assets: page.queryAll('img').map((img) => ({ url: page.absolute(page.attr(img, 'src')), alt: page.attr(img, 'alt') })),
          links: page.queryAll('a').map((a) => ({ href: page.absolute(page.attr(a, 'href')) })),
          meta: { type: ctx.contentType.apiId, jsonLd: page.jsonLd(), docTitle: page.title },
        };
      }`);
    expect(result).toEqual({
      ok: true,
      output: {
        fields: { title: 'Hello', image: 'https://www.example.com/og.png' },
        blocks: [{ variant: 'text', fields: { body: 'First <a href="/about">about</a>' } }],
        assets: [{ url: 'https://www.example.com/blog/a.png', alt: 'A' }],
        links: [{ href: 'https://www.example.com/about' }],
        meta: {
          type: 'post',
          jsonLd: [{ '@type': 'BlogPosting', headline: 'Hello' }],
          docTitle: 'Hello | Blog',
        },
      },
      logs: [`importing ${page.url}`],
    });
  });

  it('accepts a named transform export', async () => {
    expect(await sandboxRun(`export const transform = (page) => ({ t: page.title });`)).toEqual({
      ok: true,
      output: { t: 'Hello | Blog' },
      logs: [],
    });
  });

  it('reports a module that does not parse as a syntax error, with where', async () => {
    const result = await sandboxRun(`export default (page) => {{ `);
    expect(result).toMatchObject({ ok: false, error: { kind: 'syntax' } });
    if (!result.ok) expect(result.error.message).toMatch(/^SyntaxError: .*\n.*script\.js:1/);
  });

  it('reports a throw as a runtime error, keeping what was logged before it', async () => {
    const result = await sandboxRun(
      `export default () => { console.warn('half way'); throw new TypeError('no heading'); }`,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'runtime' },
      logs: ['warn: half way'],
    });
    if (!result.ok) expect(result.error.message).toMatch(/^TypeError: no heading\n.*script\.js/);
  });

  it('stops a script that outlives its timeout', async () => {
    const started = Date.now();
    const result = await sandboxRun(
      `export default () => new Promise((resolve) => setTimeout(() => resolve({}), 20_000));`,
      { timeoutMs: 300 },
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: 'timeout', message: 'the script did not finish within 300ms' },
      logs: [],
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('reports a promise that can never settle as a timeout', async () => {
    expect(await sandboxRun(`export default () => new Promise(() => {});`)).toMatchObject({
      ok: false,
      error: { kind: 'timeout' },
    });
  });

  it('refuses output over the size limit', async () => {
    const result = await sandboxRun(`export default () => ({ body: 'x'.repeat(20_000) });`);
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid-output' } });
    if (!result.ok) expect(result.error.message).toMatch(/over the 10000-byte limit/);
  });

  it('has no network: fetch and connect throw inside the isolate', async () => {
    const fetched = await sandboxRun(`
      export default async () => {
        const res = await fetch('https://example.com/');
        return { status: res.status };
      }`);
    expect(fetched).toMatchObject({ ok: false, error: { kind: 'runtime' } });
    if (!fetched.ok) expect(fetched.error.message).toMatch(/not permitted to access the internet/);

    const connected = await sandboxRun(`
      import { connect } from 'cloudflare:sockets';
      export default async () => {
        const socket = connect('example.com:80');
        await socket.opened;
        return { connected: true };
      }`);
    expect(connected).toMatchObject({ ok: false, error: { kind: 'runtime' } });
    if (!connected.ok) {
      expect(connected.error.message).toMatch(/not permitted to access the internet/);
    }
  });

  it('has no bindings: the isolate env is empty', async () => {
    expect(
      await sandboxRun(`
        import { env } from 'cloudflare:workers';
        export default () => ({ keys: Object.keys(env) });`),
    ).toEqual({ ok: true, output: { keys: [] }, logs: [] });
  });

  it("re-checks the answer when a script rewrites the runtime's globals", async () => {
    // Top-level code runs before the transform: it can make the runtime's own checks lie.
    const result = await sandboxRun(`
      const big = 'x'.repeat(50_000);
      JSON.stringify = () => JSON.parse('"' + big + '"') && '"' + big + '"';
      globalThis.TextEncoder = class { encode() { return { byteLength: 1 }; } };
      export default () => {
        console.log({ toString() { return big; } });
        return {};
      };`);
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'invalid-output', message: 'the output is over the 10000-byte limit' },
    });
  });

  it('keeps concurrent runs of one script apart: each gets only its own logs', async () => {
    const script = `export default async (page) => {
      console.log('start ' + page.url);
      await new Promise((resolve) => setTimeout(resolve, 50));
      console.log('end ' + page.url);
      return {};
    };`;
    const results = await Promise.all(
      ['https://a.example/1', 'https://a.example/2', 'https://a.example/3'].map((url) =>
        sandboxRun(script, { page: { url, html: '' } }),
      ),
    );
    expect(results.map((r) => r.logs)).toEqual(
      ['1', '2', '3'].map((n) => [`start https://a.example/${n}`, `end https://a.example/${n}`]),
    );
  });

  it("never shares a script's module state between spaces or environments", async () => {
    // Module state that outlives a run: the first page's count, carried to the next.
    const counter = `let runs = 0; export default () => ({ runs: ++runs });`;
    const spaceA = { spaceId: 'space-iso-a', environmentId: 'master' };
    const spaceB = { spaceId: 'space-iso-b', environmentId: 'master' };
    expect(await sandboxRun(counter, { scope: spaceA })).toMatchObject({ output: { runs: 1 } });
    expect(await sandboxRun(counter, { scope: spaceA })).toMatchObject({ output: { runs: 2 } });
    // Same bytes, another space or environment: a fresh isolate.
    expect(await sandboxRun(counter, { scope: spaceB })).toMatchObject({ output: { runs: 1 } });
    expect(
      await sandboxRun(counter, { scope: { spaceId: 'space-iso-a', environmentId: 'staging' } }),
    ).toMatchObject({ output: { runs: 1 } });
  });
});
