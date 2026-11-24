import { createParsedPage, type ParsedPage } from './page';

/** Why a run produced no output (the sandbox port's error kinds). */
export type ImportScriptFailureKind = 'syntax' | 'runtime' | 'timeout' | 'invalid-output';

/**
 * What a run hands back across the sandbox boundary. The output travels as JSON text, so the
 * host checks its size before parsing it and never trusts a structured value built inside.
 */
export type ImportScriptRunResult =
  | { readonly ok: true; readonly output: string; readonly logs: string[] }
  | {
      readonly ok: false;
      readonly error: { readonly kind: ImportScriptFailureKind; readonly message: string };
      readonly logs: string[];
    };

export interface ImportScriptRunInput {
  readonly page: { readonly url: string; readonly html: string };
  /** The template's content type, summarised; passed through to the script as `ctx.contentType`. */
  readonly contentType: unknown;
}

/** The second argument of a script's transform. */
export interface ImportScriptContext {
  readonly url: string;
  readonly contentType: unknown;
}

export interface ImportScriptRunLimits {
  /** Largest output, as UTF-8 bytes of its JSON. */
  readonly maxOutputBytes: number;
  /** Log lines kept; later ones are counted, not kept. */
  readonly maxLogLines: number;
  /** Characters kept of one log line. */
  readonly maxLogLineLength: number;
}

export const DEFAULT_RUN_LIMITS: ImportScriptRunLimits = {
  maxOutputBytes: 1_000_000,
  maxLogLines: 100,
  maxLogLineLength: 1_000,
};

const MAX_MESSAGE_LENGTH = 2_000;

// The runtime declares no host libs (it runs in workerd and in node); every JS host has these.
type Level = (typeof LEVELS)[number];
const host = globalThis as unknown as {
  console: Record<Level, (...args: unknown[]) => void>;
  TextEncoder: new () => { encode(s: string): Uint8Array };
};

type Transform = (page: ParsedPage, ctx: ImportScriptContext) => unknown;

/**
 * Runs one import script on one page: loads the module (`load`, so a syntax error is reported as
 * one rather than failing the isolate), finds its transform, calls it with the parsed page and
 * serialises what it returns. Never throws: every failure is a result, with the logs so far.
 *
 * The same function runs inside the Worker Loader sandbox (bundled) and in the in-process test
 * fake, so a script behaves alike in both.
 */
export async function runImportScript(
  load: () => Promise<unknown>,
  input: ImportScriptRunInput,
  limits: ImportScriptRunLimits = DEFAULT_RUN_LIMITS,
): Promise<ImportScriptRunResult> {
  const logs = captureConsole(limits);
  const fail = (kind: ImportScriptFailureKind, message: string): ImportScriptRunResult => ({
    ok: false,
    error: { kind, message: clip(message, MAX_MESSAGE_LENGTH) },
    logs: logs.lines(),
  });
  try {
    let mod: unknown;
    try {
      mod = await load();
    } catch (err) {
      return err instanceof SyntaxError
        ? fail('syntax', describe(err))
        : fail('runtime', `while loading the script: ${describe(err)}`);
    }
    const transform = pickTransform(mod);
    if (!transform) {
      return fail(
        'runtime',
        'the script must export a default function or a function named transform',
      );
    }

    let value: unknown;
    try {
      const page = createParsedPage(input.page);
      value = await transform(page, { url: input.page.url, contentType: input.contentType });
    } catch (err) {
      return fail('runtime', describe(err));
    }

    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch (err) {
      return fail('invalid-output', `the output is not JSON: ${describe(err)}`);
    }
    if (json === undefined) return fail('invalid-output', 'the script returned nothing');
    const bytes = new host.TextEncoder().encode(json).byteLength;
    if (bytes > limits.maxOutputBytes) {
      return fail(
        'invalid-output',
        `the output is ${bytes} bytes, over the ${limits.maxOutputBytes}-byte limit`,
      );
    }
    return { ok: true, output: json, logs: logs.lines() };
  } finally {
    logs.restore();
  }
}

/** A default-exported function, else a function exported as `transform`. Nothing else counts. */
function pickTransform(mod: unknown): Transform | undefined {
  if (typeof mod !== 'object' || mod === null) return undefined;
  const m = mod as { default?: unknown; transform?: unknown };
  if (typeof m.default === 'function') return m.default as Transform;
  if (typeof m.transform === 'function') return m.transform as Transform;
  return undefined;
}

/** `Name: message`, with the stack frames that follow it (they point into the script). */
export function describe(err: unknown): string {
  if (err instanceof Error) {
    const head = `${err.name}: ${err.message}`;
    const frames = (err.stack ?? '')
      .split('\n')
      .filter((line) => /^\s+at /.test(line))
      .slice(0, 5);
    return [head, ...frames].join('\n');
  }
  return String(err);
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const LEVELS = ['log', 'info', 'debug', 'warn', 'error'] as const;

/**
 * Collects the script's console output for the run, bounded, and puts the console back after.
 * Inside the sandbox nothing else writes to it, so the capture is the script's alone.
 */
function captureConsole(limits: ImportScriptRunLimits) {
  const kept: string[] = [];
  let dropped = 0;
  const original = LEVELS.map((level) => [level, host.console[level]] as const);
  for (const level of LEVELS) {
    host.console[level] = (...args: unknown[]) => {
      if (kept.length >= limits.maxLogLines) {
        dropped++;
        return;
      }
      const line = args.map(format).join(' ');
      const prefix = level === 'warn' || level === 'error' ? `${level}: ` : '';
      kept.push(clip(prefix + line, limits.maxLogLineLength));
    };
  }
  return {
    lines: () => (dropped ? [...kept, `… ${dropped} more lines not kept`] : [...kept]),
    restore: () => {
      for (const [level, fn] of original) host.console[level] = fn;
    },
  };
}

function format(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return describe(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
