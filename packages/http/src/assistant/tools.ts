/**
 * The assistant's tools are contentworker's MCP tools, run in-process: each call is a JSON-RPC
 * request to the same handler `/mcp` serves (./mcp/http.ts), authenticated as the person's own
 * principal, so the assistant can never do what an MCP client with their access couldn't. Only the
 * tools `ASSISTANT_TOOLS` names are offered, and every call runs in the page's space and
 * environment, whatever the arguments said.
 */

import { wrapUntrusted } from '@contentworker/application';
import {
  ASSISTANT_TOOLS,
  type AssistantScope,
  type AssistantTool,
  type Principal,
} from '@contentworker/domain';
import { redactCredentials } from '@contentworker/redaction';
import type { JSONSchema7 } from 'ai';
import type { McpDeps } from '../mcp/deps.js';
import { authInfoFor, createHandler } from '../mcp/http.js';
import { INTERNAL_TOOL_ERROR } from '../mcp/server.js';

/** An MCP tool as `tools/list` describes it. */
export interface ListedTool {
  readonly name: string;
  readonly description: string;
  /** Its input schema with the scope arguments taken out: the page decides those. */
  readonly inputSchema: JSONSchema7;
  /** Which of the scope arguments (`space`, `environment`) it takes. */
  readonly scoped: { readonly space: boolean; readonly environment: boolean };
}

/** What a tool refused, in its own words: safe to show the person and to keep. */
export class ToolRefused extends Error {}

/** What a call that failed for any other reason says, in place of the reason. */
export const NOT_THROUGH = 'That didn’t go through. Try again in a moment.';

/** A failure's words for the person: a refusal's own, never an internal error's. */
export const errorLine = (err: unknown) =>
  err instanceof ToolRefused ? redactCredentials(err.message) : NOT_THROUGH;

/** The MCP arguments that name a scope; the assistant always fills them from the page. */
const SCOPE_ARGS = ['space', 'environment'] as const;

/** A refusal is shown in a card and kept in the conversation: a sentence, not a payload. */
const MAX_REFUSAL = 300;

/** A tool result the model reads is cut here (an entries_query page can be large). */
const MAX_RESULT_CHARS = 24_000;

let listing: Promise<Map<AssistantTool, ListedTool>> | undefined;

/**
 * The assistant's tools as MCP lists them, in `ASSISTANT_TOOLS` order. Listed once per isolate:
 * the schemas don't vary with who asks (the MCP suite holds the server to that), only with a
 * deploy. A failed listing isn't kept, so the next turn lists again.
 */
export function listAssistantTools(
  deps: McpDeps,
  principal: Principal,
): Promise<Map<AssistantTool, ListedTool>> {
  if (!listing) {
    listing = listAll(deps, principal);
    listing.catch(() => {
      listing = undefined;
    });
  }
  return listing;
}

async function listAll(deps: McpDeps, principal: Principal) {
  const all = new Map<string, { description?: string; inputSchema?: JSONSchema7 }>();
  let cursor: string | undefined;
  do {
    const page = (await rpc(deps, principal, 'tools/list', cursor ? { cursor } : {})) as {
      tools?: { name: string; description?: string; inputSchema?: JSONSchema7 }[];
      nextCursor?: string;
    };
    for (const t of page.tools ?? []) all.set(t.name, t);
    cursor = page.nextCursor;
  } while (cursor);
  const out = new Map<AssistantTool, ListedTool>();
  for (const name of Object.keys(ASSISTANT_TOOLS) as AssistantTool[]) {
    const t = all.get(name);
    if (!t) continue;
    const schema = t.inputSchema ?? { type: 'object' };
    const properties = { ...(schema.properties ?? {}) };
    const scoped = { space: 'space' in properties, environment: 'environment' in properties };
    for (const arg of SCOPE_ARGS) delete properties[arg];
    out.set(name, {
      name,
      description: t.description ?? ASSISTANT_TOOLS[name].title,
      inputSchema: {
        ...schema,
        properties,
        ...(schema.required
          ? {
              required: schema.required.filter(
                (r) => !(SCOPE_ARGS as readonly string[]).includes(r),
              ),
            }
          : {}),
      },
      scoped,
    });
  }
  return out;
}

/** A tool call's arguments, held to the page's scope: what the caller said about it is dropped. */
export function scopedArguments(
  tool: Pick<ListedTool, 'scoped'>,
  input: unknown,
  scope: AssistantScope,
): Record<string, unknown> {
  const args: Record<string, unknown> = { ...(isRecord(input) ? input : {}) };
  for (const arg of SCOPE_ARGS) delete args[arg];
  if (tool.scoped.space) args.space = scope.spaceId;
  if (tool.scoped.environment) args.environment = scope.environmentId;
  return args;
}

/**
 * Calls one assistant tool as `principal`, in `scope`. Its result as data (the JSON the tool
 * answered, or its text); a refusal (an MCP tool error) throws `ToolRefused` with the tool's own
 * words; anything else throws as it is, for `errorLine` to keep out of sight.
 */
export async function callAssistantTool(
  deps: McpDeps,
  principal: Principal,
  name: AssistantTool,
  input: unknown,
  scope: AssistantScope,
): Promise<unknown> {
  const tool = (await listAssistantTools(deps, principal)).get(name);
  if (!tool) throw new ToolRefused(`${ASSISTANT_TOOLS[name].title} isn’t available here.`);
  const result = (await rpc(deps, principal, 'tools/call', {
    name,
    arguments: scopedArguments(tool, input, scope),
  })) as { content?: { type: string; text?: string }[]; isError?: boolean };
  const text = (result.content ?? [])
    .flatMap((c) => (c.type === 'text' && typeof c.text === 'string' ? [c.text] : []))
    .join('\n');
  if (result.isError) {
    // The MCP server keeps a refusal's words (what REST answers with a 4xx) and says only
    // INTERNAL_TOOL_ERROR for anything else; that one is no refusal to show.
    const said = redactCredentials(text.trim());
    if (!said || said === INTERNAL_TOOL_ERROR) throw new Error(`mcp ${name}: internal error`);
    throw new ToolRefused(said.length > MAX_REFUSAL ? `${said.slice(0, MAX_REFUSAL)}…` : said);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * A tool result as the model reads it: people's content, so inside the untrusted-content delimiter
 * (the system prompt carries `UNTRUSTED_CONTENT_GUARD`), and cut short when it is very large.
 */
export function forModel(output: unknown): string {
  const text = (typeof output === 'string' ? output : JSON.stringify(output)) ?? '';
  return wrapUntrusted(
    text.length <= MAX_RESULT_CHARS
      ? text
      : `${text.slice(0, MAX_RESULT_CHARS)}… (cut short: ask for fewer results or one item)`,
  );
}

/** One JSON-RPC request to the in-process MCP handler. */
async function rpc(
  deps: McpDeps,
  principal: Principal,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const res = await createHandler(deps, (err) => console.error('assistant: mcp failed', err)).fetch(
    new Request('https://assistant.invalid/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
    // No token: the principal is already resolved, and nothing here is forwarded.
    { authInfo: authInfoFor(principal, '') },
  );
  const body = await readJsonRpc(res);
  if (!body) throw new Error(`mcp ${method}: HTTP ${res.status} with no JSON-RPC answer`);
  if (body.error) throw new Error(`mcp ${method}: ${body.error.message ?? 'error'}`);
  return body.result;
}

type JsonRpcAnswer = { id?: unknown; result?: unknown; error?: { message?: string } };

/** The handler answers in JSON or as an event stream; either way, the answer to request 1. */
async function readJsonRpc(res: Response): Promise<JsonRpcAnswer | null> {
  const text = await res.text();
  const type = res.headers.get('content-type') ?? '';
  const candidates = type.includes('text/event-stream')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
    : [text];
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as JsonRpcAnswer;
      if (parsed && (parsed.id === 1 || 'result' in parsed || 'error' in parsed)) return parsed;
    } catch {
      // not this one
    }
  }
  return null;
}

// ── What a page's call keeps in the conversation ──
// The conversation is stored, and the model reads it on the person's next turn: a page's call
// keeps only what its line needs. Field values, comment text and the like stay in the page's own
// result.

const KEPT_INPUT = new Set(['action', 'entityType', 'contentType', 'locale', 'version']);

/** A call's ids (and the few words that say what kind of call it was): all its line needs. */
export function idsOf(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) return {};
  return Object.fromEntries(
    Object.entries(input).filter(([k, v]) => {
      if (/^ids?$|Ids?$/.test(k))
        return typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
      return KEPT_INPUT.has(k) && (typeof v === 'string' || typeof v === 'number');
    }),
  );
}

const KEPT_OUTPUT = [
  'id',
  'entryId',
  'releaseId',
  'contentTypeApiId',
  'status',
  'currentVersion',
  'publishedVersion',
  'version',
  'scheduledFor',
] as const;

/**
 * What a page's call keeps of its result: what it changed, and where it stands now. An entry
 * comes back as `{ entry, fields }`; its `entry` says that, never its field values.
 */
export function kept(output: unknown): Record<string, unknown> {
  if (Array.isArray(output)) return { count: output.length };
  if (!isRecord(output)) return {};
  const from = isRecord(output.entry) ? { ...output.entry, ...output } : output;
  const out: Record<string, unknown> = Object.fromEntries(
    KEPT_OUTPUT.filter((k) => k in from && isScalar(from[k])).map((k) => [k, from[k]]),
  );
  for (const [k, v] of Object.entries(output)) if (Array.isArray(v)) out[`${k}Count`] = v.length;
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isScalar = (v: unknown) =>
  v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
