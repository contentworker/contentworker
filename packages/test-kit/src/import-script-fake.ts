import {
  DEFAULT_RUN_LIMITS,
  type ImportScriptRunLimits,
  runImportScript,
} from '@contentworker/import-script-runtime';
import type {
  ImportScriptResult,
  ImportScriptRun,
  ImportScriptSandbox,
} from '@contentworker/ports';

// test-kit declares no runtime libs; every JS host has these globals.
const host = globalThis as unknown as {
  fetch: unknown;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
};

/**
 * An {@link ImportScriptSandbox} that runs scripts in this process, through the same runtime the
 * Worker Loader sandbox bundles (the parsed page, the export rules, the output checks), so a
 * script behaves in a use-case test as it does deployed.
 *
 * It is not a sandbox: the script shares this process. `fetch` is swapped for one that throws
 * while a run is in flight, so a script that reaches for the network fails as it would in the
 * isolate, and an async script is stopped waiting at the timeout; a synchronous busy loop cannot
 * be stopped in-process (deployed, the isolate's CPU limit stops it). For tests only.
 *
 * Imported from `@contentworker/test-kit/import-script`, never the package root: the platform
 * imports the root at runtime, and this would pull linkedom into the host Worker, outside the
 * sandbox it is meant to run in.
 */
export class InProcessImportScriptSandbox implements ImportScriptSandbox {
  readonly runs: ImportScriptRun[] = [];

  constructor(private readonly limits: ImportScriptRunLimits = DEFAULT_RUN_LIMITS) {}

  async run(input: ImportScriptRun): Promise<ImportScriptResult> {
    this.runs.push(input);
    const load = () =>
      import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(input.script)}`);
    const realFetch = host.fetch;
    host.fetch = () =>
      Promise.reject(new Error('import scripts have no network access (fetch is blocked)'));
    let timer: unknown;
    try {
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = host.setTimeout(() => resolve('timeout'), input.timeoutMs);
      });
      const result = await Promise.race([
        runImportScript(load, { page: input.page, contentType: input.contentType }, this.limits),
        timedOut,
      ]);
      if (result === 'timeout') {
        return {
          ok: false,
          error: {
            kind: 'timeout',
            message: `the script did not finish within ${input.timeoutMs}ms`,
          },
          logs: [],
        };
      }
      return result.ok
        ? { ok: true, output: JSON.parse(result.output), logs: result.logs }
        : result;
    } finally {
      host.clearTimeout(timer);
      host.fetch = realFetch;
    }
  }
}
