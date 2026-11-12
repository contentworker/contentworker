/**
 * The evaluation's HTTP client: plain fetch against one dev deployment's Management API, refusing
 * anything else before a single request goes out. The golden set uploads files and spends model
 * calls, so it must never reach a customer's deployment.
 */

export interface EvalTarget {
  /** The api's origin, e.g. https://api.dev.example.test (CW_EVAL_BASE_URL). */
  readonly baseUrl: URL;
  /** A cma key for the dev space (CW_EVAL_TOKEN). */
  readonly token: string;
  readonly space: string;
  readonly environment: string;
  /** Every host a request may go to (CW_EVAL_ALLOWED_HOSTS): the api's, and its upload host's. */
  readonly allowedHosts: readonly string[];
}

/** The env the runner needs, read and checked. Throws, naming what is wrong. */
export function evalTarget(env: Record<string, string | undefined>): EvalTarget {
  const raw = env.CW_EVAL_BASE_URL ?? '';
  const allowed = (env.CW_EVAL_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  let baseUrl: URL;
  try {
    baseUrl = new URL(raw);
  } catch {
    throw new Error(`CW_EVAL_BASE_URL is not a URL: "${raw}"`);
  }
  if (baseUrl.protocol !== 'https:' && baseUrl.hostname !== 'localhost') {
    throw new Error('CW_EVAL_BASE_URL must be https (or localhost)');
  }
  // Only a host the operator named as a dev deployment, exactly: never a pattern, never a default.
  if (!allowed.includes(baseUrl.hostname.toLowerCase())) {
    throw new Error(
      `${baseUrl.hostname} is not in CW_EVAL_ALLOWED_HOSTS: the evaluation runs only on a dev ` +
        'deployment its operator names, never a customer’s',
    );
  }
  const token = env.CW_EVAL_TOKEN ?? '';
  if (!token) throw new Error('CW_EVAL_TOKEN (a cma key for the dev space) is required');
  const space = env.CW_EVAL_SPACE ?? '';
  if (!/^[\w.:-]{1,128}$/.test(space))
    throw new Error('CW_EVAL_SPACE (the dev space id) is required');
  return {
    baseUrl,
    token,
    space,
    environment: env.CW_EVAL_ENVIRONMENT || 'main',
    allowedHosts: allowed,
  };
}

export interface Answer<T = unknown> {
  readonly status: number;
  readonly body: T;
  readonly ms: number;
}

export interface EvalClient {
  /** A request under `/spaces/:space/environments/:env` (`path` starts with `/`). */
  env<T = unknown>(method: string, path: string, body?: unknown): Promise<Answer<T>>;
  /** A request under `/spaces/:space`. */
  space<T = unknown>(method: string, path: string, body?: unknown): Promise<Answer<T>>;
  /** PUTs bytes to an upload URL (a signed one, absolute or relative to the api). */
  upload(url: string, headers: Record<string, string>, bytes: Uint8Array): Promise<number>;
}

export function evalClient(target: EvalTarget): EvalClient {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Answer<T>> => {
    const started = Date.now();
    const res = await fetch(new URL(path, target.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${target.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: kept as text.
    }
    return { status: res.status, body: parsed as T, ms: Date.now() - started };
  };
  const spacePath = `/spaces/${encodeURIComponent(target.space)}`;
  const envPath = `${spacePath}/environments/${encodeURIComponent(target.environment)}`;
  return {
    env: (method, path, body) => call(method, `${envPath}${path}`, body),
    space: (method, path, body) => call(method, `${spacePath}${path}`, body),
    async upload(url, headers, bytes) {
      const to = new URL(url, target.baseUrl);
      // A signed upload URL goes to a host the operator listed (the api, or its media host).
      if (!target.allowedHosts.includes(to.hostname.toLowerCase())) {
        throw new Error(`Refusing to upload to ${to.hostname}: not in CW_EVAL_ALLOWED_HOSTS`);
      }
      const res = await fetch(to, { method: 'PUT', headers, body: bytes });
      return res.status;
    },
  };
}
