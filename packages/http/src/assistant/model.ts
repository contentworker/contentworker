/**
 * The assistant's model: Workers AI's flagship tier (through AI Gateway when AI_GATEWAY_ID is set),
 * then its fast tier, with a deterministic mock model behind both. The mock speaks the same
 * protocol, so it calls the same tools through the same confirms; it answers every turn when
 * AI_MODE is "mock" (local development, the tests, a demo), and takes over a turn when the models
 * error or say nothing in time. Page edits (`act`, `resolve`) never reach a model at all.
 */

import {
  NO_LOG_PAYLOAD,
  WORKERS_AI_MODEL_BY_TIER,
  workersAiModelsFromEnv,
} from '@contentworker/adapters/ai-workers';
import { ASSISTANT_TOOLS, type AssistantContext, isAssistantTool } from '@contentworker/domain';
import type { EdgeEnv } from '@contentworker/platform/env';
import { createAI, type WorkersAIModelId } from 'agents/models/ai-sdk';
import type { LanguageModel } from 'ai';

type Model = Extract<LanguageModel, { specificationVersion: 'v4' }>;
export type AssistantModel = Model;
type CallOptions = Parameters<Model['doStream']>[0];
type Prompt = CallOptions['prompt'];
type StreamPart =
  Awaited<ReturnType<Model['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never;
type GenerateResult = Awaited<ReturnType<Model['doGenerate']>>;

/** A slow model must not hold the person hostage: the mock answers after this. */
const AI_TIMEOUT_MS = 20_000;

/** Which model answered a turn: `mock` costs nothing and isn't metered. */
export type ModelSource = { source: 'model' | 'mock'; model?: string };

const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

/**
 * The model for one turn. `used.source` says which model answered once it has, so the turn is
 * metered only when a real one did.
 */
export async function assistantModel(
  env: EdgeEnv,
  context: AssistantContext,
  used: ModelSource,
  personId: string,
): Promise<Model> {
  const mock = mockModel(context);
  if (env.AI_MODE === 'mock' || !env.AI) {
    used.source = 'mock';
    return mock;
  }
  const models = workersAiModelsFromEnv(env as unknown as Record<string, string | undefined>);
  const flagship = (models.flagship ?? WORKERS_AI_MODEL_BY_TIER.flagship) as WorkersAIModelId;
  const fast = (models.fast ?? WORKERS_AI_MODEL_BY_TIER.fast) as WorkersAIModelId;
  const gatewayId = env.AI_GATEWAY_ID ?? '';
  const ai = createAI({
    // EdgeEnv types only the `run` the adapters use; createAI takes the whole binding.
    binding: env.AI as unknown as Ai,
    // An empty id calls Workers AI directly; undefined would pick the account's "default" gateway.
    gateway: gatewayId
      ? {
          id: gatewayId,
          ...(env.AI_GATEWAY_LOGS ? { collectLog: env.AI_GATEWAY_LOGS === 'true' } : {}),
          metadata: { prompt: 'assistant' },
          retries: { maxAttempts: 2, retryDelayMs: 500, backoff: 'exponential' },
          requestTimeoutMs: AI_TIMEOUT_MS,
        }
      : { id: '' },
  });
  const primary = ai(flagship, {
    fallback: fast === flagship ? [] : [fast],
    // Workers AI's prefix cache: the system prompt and tools repeat within a conversation.
    sessionAffinity: await sha256(`assistant:${personId}`),
    // Tool results carry people's content: the gateway keeps no prompt or answer.
    headers: { ...NO_LOG_PAYLOAD },
  });
  return withFallback(primary, mock, used);
}

function timeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve(p),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const CONTENT = new Set(['text-delta', 'tool-call', 'tool-input-start', 'reasoning-delta']);

/**
 * Tries the model; if it errors, or nothing useful arrives before the deadline, the mock answers
 * instead. Once the model has produced content, its stream passes through untouched.
 */
export function withFallback(primary: Model, fallback: Model, used: ModelSource): Model {
  return {
    specificationVersion: 'v4',
    provider: 'contentworker',
    modelId: primary.modelId,
    supportedUrls: {},
    async doGenerate(options) {
      try {
        const res = await timeout(primary.doGenerate(options), AI_TIMEOUT_MS);
        used.source = 'model';
        used.model = primary.modelId;
        return res;
      } catch (err) {
        console.warn('assistant fallback', err instanceof Error ? err.message : err);
        used.source = 'mock';
        return fallback.doGenerate(options);
      }
    },
    async doStream(options) {
      const deadline = Date.now() + AI_TIMEOUT_MS;
      let reader: ReadableStreamDefaultReader<StreamPart> | undefined;
      try {
        const res = await timeout(primary.doStream(options), AI_TIMEOUT_MS);
        reader = res.stream.getReader();
        const read = reader;
        const held: StreamPart[] = [];
        let finished = false;
        for (;;) {
          const { done, value } = await timeout(read.read(), Math.max(1, deadline - Date.now()));
          if (done) {
            finished = true;
            break;
          }
          if (value.type === 'error') throw value.error;
          held.push(value);
          if (CONTENT.has(value.type)) break;
        }
        if (finished && !held.some((p) => CONTENT.has(p.type))) throw new Error('empty answer');
        used.source = 'model';
        used.model = primary.modelId;
        return {
          ...res,
          stream: new ReadableStream<StreamPart>({
            start(c) {
              for (const p of held) c.enqueue(p);
              if (finished) c.close();
            },
            async pull(c) {
              if (finished) return;
              const { done, value } = await read.read();
              if (done) c.close();
              else c.enqueue(value);
            },
            cancel(reason) {
              return read.cancel(reason);
            },
          }),
        };
      } catch (err) {
        console.warn('assistant fallback', err instanceof Error ? err.message : err);
        // Stop paying for an answer nobody will read.
        reader?.cancel().catch(() => {});
        used.source = 'mock';
        return fallback.doStream(options);
      }
    },
  };
}

/** A tool call as the model emitted it: its id, the tool, and its input (JSON text). */
export type EmittedCall = { toolCallId: string; toolName: string; input: string };

/**
 * The model, reporting every tool call it emits as it emits it, before the AI SDK runs or holds
 * it: what the agent records so that only calls the model really made can run (a client can save
 * messages, and so could put a call there the model never made).
 */
export function recordingCalls(model: Model, onCall: (call: EmittedCall) => void): Model {
  const note = (p: { type: string }) => {
    if (p.type === 'tool-call') onCall(p as unknown as EmittedCall);
  };
  return {
    ...model,
    specificationVersion: 'v4',
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    async doGenerate(options) {
      const res = await model.doGenerate(options);
      for (const c of res.content) note(c);
      return res;
    },
    async doStream(options) {
      const res = await model.doStream(options);
      return {
        ...res,
        stream: res.stream.pipeThrough(
          new TransformStream<StreamPart, StreamPart>({
            transform(p, c) {
              note(p);
              c.enqueue(p);
            },
          }),
        ),
      };
    },
  };
}

// ── The mock model ──────────────────────────────────────────────────────────
// Deterministic: plain requests become one tool call, a tool result becomes one plain sentence.

type Step = { tool: string; input: Record<string, unknown> } | { text: string };

const USAGE: GenerateResult['usage'] = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

function lastUserText(prompt: Prompt) {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i]!;
    if (m.role === 'user')
      return m.content
        .map((c) => (c.type === 'text' ? c.text : ''))
        .join(' ')
        .trim();
  }
  return '';
}

/** Picks one tool from the words used, or says what it understands. */
export function mockStep(text: string, context: AssistantContext, tools: Set<string>): Step {
  const t = text.toLowerCase();
  const page = context.page;
  const entryId = page.kind === 'entry' ? page.entryId : undefined;
  const contentType = page.kind === 'everything' ? undefined : page.contentType;
  const pick = (tool: string, input: Record<string, unknown>): Step =>
    tools.has(tool) ? { tool, input } : { text: 'That isn’t something I can do here.' };

  if (entryId && /\bunpublish\b/.test(t)) return pick('entries_unpublish', { id: entryId });
  if (entryId && /\bpublish\b/.test(t)) return pick('entries_publish', { id: entryId });
  if (entryId && /\b(trash|delete|remove)\b/.test(t)) return pick('entries_trash', { id: entryId });
  if (entryId && /\b(versions?|history)\b/.test(t))
    return pick('entries_list_versions', { id: entryId });
  if (entryId && /\b(this|it|entry|what|show|read)\b/.test(t))
    return pick('entries_get', { id: entryId });
  if (/\b(content types?|models?|schemas?)\b/.test(t)) return pick('model_list_content_types', {});
  if (/\b(how|docs?|documentation)\b/.test(t)) return pick('docs_search', { query: text });
  if (/\b(releases?)\b/.test(t)) return pick('releases_list', {});
  if (/\b(trash|trashed)\b/.test(t)) return pick('entries_list_trashed', {});
  if (/\b(entries|find|list|show)\b/.test(t))
    return pick('entries_query', { ...(contentType ? { contentType } : {}), limit: 10 });
  return {
    text: [
      'I’m answering without the language model right now, so I follow plain requests best:',
      '',
      '- “List the content types”',
      '- “Find entries”',
      entryId ? '- “Publish this entry”' : '- “How do locales work?”',
    ].join('\n'),
  };
}

const plain = (v: unknown) => String(v ?? '').replace(/[[\]()<>]/g, '');

/** One plain line per tool result. */
export function describeResult(tool: string, output: unknown): string {
  const title = isAssistantTool(tool) ? ASSISTANT_TOOLS[tool] : undefined;
  const list = Array.isArray(output)
    ? output
    : Array.isArray((output as { items?: unknown })?.items)
      ? (output as { items: unknown[] }).items
      : undefined;
  if (title?.write) return `${title.done}.`;
  if (list) return `${list.length} result${list.length === 1 ? '' : 's'}.`;
  const id = (output as { id?: unknown; entry?: { id?: unknown } } | null)?.id;
  return id ? `${title?.title ?? 'Done'}: ${plain(id)}.` : `${title?.title ?? 'Done'}.`;
}

/** A tool result as the agent hands it to a model: JSON inside the untrusted-content delimiter. */
function unwrapped(text: string): unknown {
  const inner = text.replace(/^<user_content>\n/, '').replace(/\n<\/user_content>$/, '');
  try {
    return JSON.parse(inner);
  } catch {
    return inner;
  }
}

function lastToolResults(prompt: Prompt) {
  const last = prompt.at(-1);
  if (last?.role !== 'tool') return null;
  return last.content.flatMap((p) => (p.type === 'tool-result' ? [p] : []));
}

export function mockModel(context: AssistantContext): Model {
  const answer = (options: CallOptions): Step => {
    const tools = new Set((options.tools ?? []).map((t) => t.name));
    const results = lastToolResults(options.prompt);
    if (results) {
      return {
        text: results
          .map((r) => {
            const out = r.output;
            if (out.type === 'execution-denied') return 'Left as it was.';
            if (out.type === 'error-text') return `That didn’t go through: ${out.value}`;
            if (out.type === 'error-json') return 'That didn’t go through.';
            return describeResult(
              r.toolName,
              out.type === 'json' ? out.value : out.type === 'text' ? unwrapped(out.value) : null,
            );
          })
          .join('\n\n'),
      };
    }
    return mockStep(lastUserText(options.prompt), context, tools);
  };
  return {
    specificationVersion: 'v4',
    provider: 'contentworker',
    modelId: 'mock',
    supportedUrls: {},
    async doGenerate(options) {
      const step = answer(options);
      const call = 'tool' in step;
      return {
        content: call
          ? [
              {
                type: 'tool-call',
                toolCallId: crypto.randomUUID(),
                toolName: step.tool,
                input: JSON.stringify(step.input),
              },
            ]
          : [{ type: 'text', text: step.text }],
        finishReason: { unified: call ? 'tool-calls' : 'stop', raw: undefined },
        usage: USAGE,
        warnings: [],
      };
    },
    async doStream(options) {
      const step = answer(options);
      const parts: StreamPart[] = [{ type: 'stream-start', warnings: [] }];
      if ('tool' in step) {
        parts.push({
          type: 'tool-call',
          toolCallId: crypto.randomUUID(),
          toolName: step.tool,
          input: JSON.stringify(step.input),
        });
      } else {
        parts.push(
          { type: 'text-start', id: 't0' },
          { type: 'text-delta', id: 't0', delta: step.text },
          { type: 'text-end', id: 't0' },
        );
      }
      parts.push({
        type: 'finish',
        usage: USAGE,
        finishReason: { unified: 'tool' in step ? 'tool-calls' : 'stop', raw: undefined },
      });
      return {
        stream: new ReadableStream({
          start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
          },
        }),
      };
    },
  };
}
