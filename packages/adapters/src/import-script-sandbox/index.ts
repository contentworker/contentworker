import type { Scope } from '@contentworker/domain';
import {
  IMPORT_SCRIPT_RUNTIME,
  IMPORT_SCRIPT_RUNTIME_HASH,
} from '@contentworker/import-script-runtime/bundle';
import type {
  ImportScriptErrorKind,
  ImportScriptResult,
  ImportScriptRun,
  ImportScriptSandbox,
} from '@contentworker/ports';

/**
 * Import-script sandbox backed by Cloudflare's Worker Loader.
 *
 * Each script runs in its own dynamic Worker, beside the bundled runtime (the parsed page over
 * linkedom, and the runner that calls the script and bounds its output). What isolates it, each
 * checked against workerd (`test/import-script-sandbox/workerd.test.ts`) rather than assumed:
 *
 * 1. `globalOutbound: null`: `fetch()` and `connect()` inside the isolate throw. A script has no
 *    way to the network; it only turns the page it is handed into fields.
 * 2. `env: {}`: no bindings, so `import { env } from 'cloudflare:workers'` holds nothing.
 * 3. Time: the host stops waiting at the run's timeout, and `limits.cpuMs` lets Cloudflare stop a
 *    script spinning on the CPU (a busy loop never yields to the host's timer; workerd enforces
 *    the CPU limit only on Cloudflare, not in local development).
 * 4. Output: the runtime refuses output over the size limit, and the host checks it again on what
 *    arrives, as JSON text it parses itself: nothing built inside the isolate is trusted as-is.
 *
 * Isolates are cached by space, environment, script hash and runtime hash: a warm isolate is
 * reused for the same script in the same environment (a script can keep module state between
 * pages, never between environments or spaces), and changed bytes or a changed runtime never
 * reuse an isolate warmed from the old ones. Callers run pages one at a time or a few at once:
 * Cloudflare allows four dynamic Workers in flight per request, plugins included.
 */

/** The subset of the Worker Loader binding this adapter uses. */
export interface ImportScriptLoaderBinding {
  get(
    id: string,
    supplier: () => {
      compatibilityDate: string;
      mainModule: string;
      modules: Record<string, string>;
      globalOutbound: null;
      env: Record<string, never>;
      limits: { cpuMs: number };
    },
  ): {
    getEntrypoint(
      name?: string,
      options?: { limits?: { cpuMs?: number } },
    ): Record<string, (...args: unknown[]) => Promise<unknown>>;
  };
}

export interface ImportScriptSandboxOptions {
  /**
   * Compatibility date handed to script isolates. Pinned separately from the host Worker's: a
   * script should not change behaviour because the platform's date moved.
   */
  readonly compatibilityDate?: string;
  /** Ceiling on a run's timeout, whatever the caller asks for; also the isolate's CPU limit. */
  readonly maxTimeoutMs?: number;
  /** Largest script accepted, in UTF-8 bytes. */
  readonly maxScriptBytes?: number;
  /** Largest page accepted, in UTF-8 bytes of its HTML. */
  readonly maxHtmlBytes?: number;
  /** Largest output, in UTF-8 bytes of its JSON. */
  readonly maxOutputBytes?: number;
  readonly onError?: (message: string, detail: unknown) => void;
}

const DEFAULT_COMPATIBILITY_DATE = '2026-06-01';
export const DEFAULT_IMPORT_SCRIPT_MAX_TIMEOUT_MS = 10_000;
export const DEFAULT_IMPORT_SCRIPT_MAX_SCRIPT_BYTES = 256 * 1024;
export const DEFAULT_IMPORT_SCRIPT_MAX_HTML_BYTES = 5 * 1024 * 1024;
export const DEFAULT_IMPORT_SCRIPT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_LOG_LINES = 100;
const MAX_LOG_LINE_LENGTH = 1_000;
const MAX_MESSAGE_LENGTH = 2_000;

/** The class the host's entry module exports. */
export const IMPORT_SCRIPT_ENTRYPOINT_CLASS = 'ImportScript';
export const ENTRY_MODULE = '__contentworker_entry.js';
export const RUNTIME_MODULE = '__contentworker_runtime.js';
export const SCRIPT_MODULE = 'script.js';

/**
 * Part of every isolate's key, with the script's and the runtime's hashes: bump it whenever
 * {@link ENTRY_SOURCE} changes, so no isolate warmed with an older entry is reused.
 */
export const ENTRY_MODULE_VERSION = 'e2';

/**
 * The isolate's main module. The script is imported dynamically, inside the call, so a throw
 * while it loads is reported as the script's failure rather than as an isolate that won't start;
 * a module that does not parse still fails the isolate's start, which the host reports as
 * `syntax`.
 *
 * Runs take turns: the runtime captures logs by swapping the isolate's console, so two runs at
 * once in one warm isolate would mix their logs. A run that never settles holds the queue, which
 * only ever stalls the same script in the same space, and the host's timeout still answers.
 */
export const ENTRY_SOURCE = `import { WorkerEntrypoint } from 'cloudflare:workers';
import { runImportScript } from './${RUNTIME_MODULE}';

let turn = Promise.resolve();

export class ${IMPORT_SCRIPT_ENTRYPOINT_CLASS} extends WorkerEntrypoint {
  run(input, limits) {
    const result = turn.then(() => runImportScript(() => import('./${SCRIPT_MODULE}'), input, limits));
    turn = result.then(() => {}, () => {});
    return result;
  }
}
`;

/** One isolate per space, environment, script, runtime and entry version. */
export async function isolateKey(scope: Scope, script: string): Promise<string> {
  return `import-script:${scope.spaceId}/${scope.environmentId}/${await sha256(script)}#${IMPORT_SCRIPT_RUNTIME_HASH}.${ENTRY_MODULE_VERSION}`;
}

export function createWorkerLoaderImportScriptSandbox(
  loader: ImportScriptLoaderBinding,
  options: ImportScriptSandboxOptions = {},
): ImportScriptSandbox {
  const compatibilityDate = options.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE;
  const maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_IMPORT_SCRIPT_MAX_TIMEOUT_MS;
  const maxScriptBytes = options.maxScriptBytes ?? DEFAULT_IMPORT_SCRIPT_MAX_SCRIPT_BYTES;
  const maxHtmlBytes = options.maxHtmlBytes ?? DEFAULT_IMPORT_SCRIPT_MAX_HTML_BYTES;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_IMPORT_SCRIPT_MAX_OUTPUT_BYTES;
  const report = options.onError ?? (() => {});

  return {
    async run(input: ImportScriptRun): Promise<ImportScriptResult> {
      const scriptBytes = utf8Length(input.script);
      if (scriptBytes > maxScriptBytes) {
        throw new RangeError(`import script is ${scriptBytes} bytes, over ${maxScriptBytes}`);
      }
      const htmlBytes = utf8Length(input.page.html);
      if (htmlBytes > maxHtmlBytes) {
        throw new RangeError(`page HTML is ${htmlBytes} bytes, over ${maxHtmlBytes}`);
      }
      if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
        throw new RangeError(`import script timeout must be a positive number of ms`);
      }
      const timeoutMs = Math.max(1, Math.min(Math.floor(input.timeoutMs), maxTimeoutMs));

      const worker = loader.get(await isolateKey(input.scope, input.script), () => ({
        compatibilityDate,
        mainModule: ENTRY_MODULE,
        modules: {
          [ENTRY_MODULE]: ENTRY_SOURCE,
          [RUNTIME_MODULE]: IMPORT_SCRIPT_RUNTIME,
          [SCRIPT_MODULE]: input.script,
        },
        // No network: fetch() and connect() inside the isolate throw.
        globalOutbound: null,
        // No bindings.
        env: {},
        limits: { cpuMs: maxTimeoutMs },
      }));

      let raw: unknown;
      try {
        // The lower of this and the isolate's own limit applies.
        const entrypoint = worker.getEntrypoint(IMPORT_SCRIPT_ENTRYPOINT_CLASS, {
          limits: { cpuMs: timeoutMs },
        });
        raw = await withTimeout(
          // Called as a method of the stub: on a real entrypoint `run` is an RPC stub, so
          // `.call(…)` would be a remote method named "call".
          (entrypoint.run as (...a: unknown[]) => Promise<unknown>)(
            // Only plain data crosses into the isolate.
            {
              page: { url: input.page.url, html: input.page.html },
              contentType: input.contentType,
            },
            { maxOutputBytes, maxLogLines: MAX_LOG_LINES, maxLogLineLength: MAX_LOG_LINE_LENGTH },
          ),
          timeoutMs,
        );
      } catch (err) {
        const failure = classify(err, timeoutMs);
        if (failure.kind === 'runtime') {
          // The message is the script's to choose: log the clipped one only, never the raw error.
          report(`import script failed in the sandbox: ${failure.message}`, failure.message);
        }
        return { ok: false, error: failure, logs: [] };
      }
      return interpret(raw, maxOutputBytes);
    },
  };
}

class RunTimeout extends Error {}

/**
 * What the isolate answered, re-checked: its shape, the log bounds, and the output's size before
 * it is parsed. The runtime inside already enforces all of this, but a script can rewrite the
 * runtime's globals (`JSON`, `console`), so the host trusts none of it.
 */
function interpret(raw: unknown, maxOutputBytes: number): ImportScriptResult {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as {
    ok?: unknown;
    output?: unknown;
    error?: { kind?: unknown; message?: unknown };
    logs?: unknown;
  };
  // Strings only, and nothing converted: a value the isolate sent back is never stringified here.
  const logs = Array.isArray(r.logs)
    ? r.logs
        .slice(0, MAX_LOG_LINES + 1)
        .filter((line): line is string => typeof line === 'string')
        .map((line) => clip(line, MAX_LOG_LINE_LENGTH))
    : [];
  const invalid = (message: string): ImportScriptResult => ({
    ok: false,
    error: { kind: 'invalid-output', message },
    logs,
  });

  if (r.ok === true) {
    if (typeof r.output !== 'string') return invalid('the sandbox returned no output');
    // UTF-8 never takes fewer bytes than UTF-16 code units, so the length alone refuses most
    // oversized output without encoding (copying) it first.
    if (r.output.length > maxOutputBytes) {
      return invalid(`the output is over the ${maxOutputBytes}-byte limit`);
    }
    const bytes = utf8Length(r.output);
    if (bytes > maxOutputBytes) {
      return invalid(`the output is ${bytes} bytes, over the ${maxOutputBytes}-byte limit`);
    }
    try {
      return { ok: true, output: JSON.parse(r.output), logs };
    } catch {
      return invalid('the output is not JSON');
    }
  }
  if (r.ok === false && r.error && isKind(r.error.kind)) {
    const message = typeof r.error.message === 'string' ? r.error.message : 'the script failed';
    return {
      ok: false,
      error: { kind: r.error.kind, message: clip(message, MAX_MESSAGE_LENGTH) },
      logs,
    };
  }
  return invalid('the sandbox returned an unrecognised result');
}

const KINDS: readonly ImportScriptErrorKind[] = ['syntax', 'runtime', 'timeout', 'invalid-output'];
const isKind = (v: unknown): v is ImportScriptErrorKind =>
  typeof v === 'string' && (KINDS as readonly string[]).includes(v);

/**
 * A failure that reached the host as a thrown error rather than the runtime's result: the
 * isolate would not start (a module that does not parse), the run outlived its timeout, or
 * workerd stopped it (CPU limit, or a promise it found could never settle).
 */
function classify(
  err: unknown,
  timeoutMs: number,
): { kind: ImportScriptErrorKind; message: string } {
  if (err instanceof RunTimeout) {
    return { kind: 'timeout', message: `the script did not finish within ${timeoutMs}ms` };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/\bSyntaxError\b/.test(message)) {
    // "Failed to start Worker:\nUncaught SyntaxError: … at script.js:1:25"
    const detail = message.replace(/^[\s\S]*?Uncaught\s+/, '');
    return { kind: 'syntax', message: clip(detail, MAX_MESSAGE_LENGTH) };
  }
  if (/CPU time limit|exceeded CPU/i.test(message)) {
    return { kind: 'timeout', message: 'the script ran out of CPU time' };
  }
  if (/hung and would never generate a response/i.test(message)) {
    return { kind: 'timeout', message: 'the script waits on something that never settles' };
  }
  return { kind: 'runtime', message: clip(message, MAX_MESSAGE_LENGTH) };
}

/** Bounds how long the host waits; the isolate's CPU is bounded by `limits.cpuMs`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RunTimeout()), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const utf8Length = (s: string): number => new TextEncoder().encode(s).byteLength;

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
