import type { ImportScriptRun } from '@contentworker/ports';
import {
  createWorkerLoaderImportScriptSandbox,
  type ImportScriptLoaderBinding,
} from '../../../src/import-script-sandbox/index';

// The host Worker workerd.test.ts runs: the real adapter over a real Worker Loader binding, one
// run per request. Bundled by the test with esbuild; never deployed.
export default {
  async fetch(request: Request, env: { LOADER: ImportScriptLoaderBinding }): Promise<Response> {
    const sandbox = createWorkerLoaderImportScriptSandbox(env.LOADER, { maxOutputBytes: 10_000 });
    return Response.json(await sandbox.run((await request.json()) as ImportScriptRun));
  },
};
