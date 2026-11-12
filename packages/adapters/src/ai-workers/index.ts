import type {
  AIProvider,
  ChatMessage,
  EmbeddingsProvider,
  GenerateRequest,
  GenerateResult,
  ModelLimits,
  ModelTier,
  ToolCall,
} from '@contentworker/ports';
import { extractJson } from './json';
import {
  asWorkersAIError,
  DEFAULT_TIMEOUT_MS,
  gatewayRunOptions,
  WorkersAIError,
  type WorkersAiRun,
  type WorkersAiRunOptions,
  withTimeout,
} from './transport';

export {
  createWorkersAIDecisionModel,
  MAX_DECISION_QUESTIONS,
  WORKERS_AI_DECISION_MODEL_BY_TIER,
  type WorkersAIDecisionOptions,
} from './decisions';
export {
  AUDIO_TOKENS_PER_MINUTE,
  createWorkersAITextExtractor,
  WORKERS_AI_TRANSCRIBE_MODEL,
  type WorkersAITextExtractorOptions,
  type WorkersAiToMarkdown,
} from './extract';
export { extractJson } from './json';
export {
  DEFAULT_TIMEOUT_MS,
  NO_LOG_PAYLOAD,
  WorkersAIError,
  type WorkersAIErrorReason,
  type WorkersAiRun,
  type WorkersAiRunOptions,
} from './transport';

/**
 * Provider-neutral tier → Workers AI text model: DeepSeek V4.1 Flash (1M-token
 * context, function calling) for the hardest work, Llama 3.3 70B fp8-fast
 * (reliable in JSON mode) as the workhorse, GLM 4.7 Flash where latency matters
 * most. All accept `response_format`. Kimi K2.6, the flagship until November
 * 2026, stops answering on 2026-11-20.
 */
export const WORKERS_AI_MODEL_BY_TIER: Readonly<Record<ModelTier, string>> = {
  flagship: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
  balanced: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  fast: '@cf/zai-org/glm-4.7-flash',
};

/**
 * Context windows (tokens) from the Workers AI model catalog (`context_window`), for the tier
 * defaults and the models an override is likely to name. A model not listed is budgeted at
 * {@link UNKNOWN_MODEL_CONTEXT_TOKENS}: a prompt sized for a window the model doesn't have would be
 * cut or refused.
 */
export const WORKERS_AI_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  '@cf/moonshotai/kimi-k2.6': 262_144,
  '@cf/moonshotai/kimi-k2.7-code': 262_144,
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': 24_000,
  '@cf/meta/llama-3.1-8b-instruct-fast': 60_000,
  '@cf/meta/llama-3.1-8b-instruct-fp8': 32_000,
  '@cf/meta/llama-4-scout-17b-16e-instruct': 131_000,
  '@cf/openai/gpt-oss-120b': 128_000,
  '@cf/openai/gpt-oss-20b': 128_000,
  '@cf/qwen/qwen3-30b-a3b-fp8': 32_768,
  '@cf/zai-org/glm-4.7-flash': 131_072,
  '@cf/zai-org/glm-5.3': 1_048_576,
  '@cf/deepseek-ai/deepseek-v4.1-flash-1017': 1_048_576,
};

/** The window assumed for a model the catalog table doesn't list: the smallest a tier ships with. */
export const UNKNOWN_MODEL_CONTEXT_TOKENS = 24_000;

/** The model a tier maps to, with the deployment's override when it has one. */
const modelFor = (models: Partial<Record<ModelTier, string>> | undefined, tier: ModelTier) =>
  models?.[tier] || WORKERS_AI_MODEL_BY_TIER[tier];

/** What the model `tier` maps to can take (`AIProvider.limits`). */
export function workersAiLimits(
  tier: ModelTier,
  models?: Partial<Record<ModelTier, string>>,
): ModelLimits {
  return {
    contextTokens:
      WORKERS_AI_CONTEXT_WINDOWS[modelFor(models, tier)] ?? UNKNOWN_MODEL_CONTEXT_TOKENS,
  };
}

/**
 * Per-tier overrides from WORKERS_AI_MODEL_FLAGSHIP / _BALANCED / _FAST. Empty
 * strings (how wrangler vars ship "unset") are ignored.
 */
export function workersAiModelsFromEnv(
  env: Record<string, string | undefined>,
): Partial<Record<ModelTier, string>> {
  const models: Partial<Record<ModelTier, string>> = {};
  for (const tier of ['flagship', 'balanced', 'fast'] as const) {
    const value = env[`WORKERS_AI_MODEL_${tier.toUpperCase()}`];
    if (value) models[tier] = value;
  }
  return models;
}

/** Lower temperature for structured output: the answer should be data, not prose. */
const JSON_TEMPERATURE = 0.2;

/**
 * Workers AI's own JSON mode (the Llama family, gpt-oss) takes the schema itself as
 * `json_schema`. Every other chat model takes OpenAI's envelope, whose `name` is required, and
 * is the shape newer models document, so an override to an unlisted model gets that.
 */
function nativeJsonMode(model: string): boolean {
  return /^@(cf\/meta|cf\/meta-llama|hf)\/|^@cf\/openai\/gpt-oss-/.test(model);
}

function responseFormat(model: string, schema: Record<string, unknown>) {
  return {
    type: 'json_schema',
    json_schema: nativeJsonMode(model) ? schema : { name: 'output', schema },
  };
}

/**
 * Reasoning turned down for a structured call. `completion_tokens` counts the reasoning, so at a
 * model's default effort a 256–512 token cap (summaries, tags, alt text) runs out before the JSON
 * does. Each switch is the one the model's input schema documents: DeepSeek V4 takes
 * `reasoning_effort`, GLM 4.7 Flash a template flag. GLM 5.3 documents reasoning as always on,
 * and Llama and gpt-oss get nothing.
 */
function structuredReasoning(model: string): Record<string, unknown> {
  if (model.startsWith('@cf/deepseek-ai/deepseek-v4')) return { reasoning_effort: 'low' };
  if (model === '@cf/zai-org/glm-4.7-flash') {
    return { chat_template_kwargs: { enable_thinking: false } };
  }
  return {};
}

export interface WorkersAIProviderOptions {
  /** The Workers AI call: `env.AI.run.bind(env.AI)` on the edge, a REST runner on Node. */
  run: WorkersAiRun;
  /** Model per tier; unset tiers use {@link WORKERS_AI_MODEL_BY_TIER}. */
  models?: Partial<Record<ModelTier, string>>;
  /** AI Gateway id (AI_GATEWAY_ID); empty calls Workers AI directly. */
  gatewayId?: string;
  /**
   * Whether the gateway keeps a request log entry (model, tokens, cost) for each call
   * (AI_GATEWAY_LOGS); prompts and answers are never logged either way. Unset follows the
   * gateway's own setting.
   */
  collectLogs?: boolean;
  /** Hard ceiling per call in ms (default 120 000). */
  timeoutMs?: number;
}

/** OpenAI-style message as Workers AI's chat models take it. */
type WireMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

function toWire(m: ChatMessage): WireMessage {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

/** Workers AI's own models answer in `response`; chat-completions models in `choices`. */
interface ModelAnswer {
  response?: unknown;
  tool_calls?: { id?: string; name?: string; arguments?: unknown }[];
  choices?: {
    message?: {
      content?: unknown;
      tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[];
    };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function parseArgs(args: unknown): unknown {
  if (typeof args !== 'string') return args ?? {};
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

function toolCallsOf(res: ModelAnswer): ToolCall[] {
  const chat = res.choices?.[0]?.message?.tool_calls;
  if (chat?.length) {
    return chat.map((c, i) => ({
      id: c.id || `call_${i}`,
      name: c.function?.name ?? '',
      input: parseArgs(c.function?.arguments),
    }));
  }
  return (res.tool_calls ?? []).map((c, i) => ({
    id: c.id || `call_${i}`,
    name: c.name ?? '',
    input: parseArgs(c.arguments),
  }));
}

/**
 * Cloudflare Workers AI implementation of the AIProvider port. Callers pick a
 * tier, never a model. Transport-agnostic: everything goes through the
 * injected `run`, so the same code serves the edge binding and the REST API.
 *
 * - `outputSchema` → JSON mode (`response_format: json_schema`, bare or in
 *   OpenAI's envelope as the model takes it); the parsed value comes back as
 *   `object` (schema conformance is `generateJson`'s job).
 * - An answer cut off at `max_tokens` (`finish_reason: 'length'`) is an error,
 *   never half an answer.
 * - `messages`/`tools` → OpenAI-style multi-turn + function calling; the
 *   model's calls come back as `toolCalls`.
 * - Every failure is a {@link WorkersAIError} (`timeout`, `upstream`,
 *   `bad_response`), which `generateJson` turns into a retry or its fallback.
 */
export function createWorkersAIProvider(opts: WorkersAIProviderOptions): AIProvider {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runOpts = gatewayRunOptions(opts.gatewayId, opts.collectLogs);

  return {
    limits: (tier) => workersAiLimits(tier, opts.models),
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const model = modelFor(opts.models, req.tier ?? 'balanced');
      const messages: WireMessage[] = [];
      if (req.system) messages.push({ role: 'system', content: req.system });
      for (const m of req.messages ?? []) messages.push(toWire(m));
      if (req.prompt || !req.messages?.length) messages.push({ role: 'user', content: req.prompt });

      const input: Record<string, unknown> = { messages, max_tokens: req.maxTokens };
      if (req.outputSchema) {
        input.response_format = responseFormat(model, req.outputSchema);
        input.temperature = JSON_TEMPERATURE;
        Object.assign(input, structuredReasoning(model));
      }
      if (req.tools?.length) {
        input.tools = req.tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            parameters: t.inputSchema,
          },
        }));
      }

      let res: ModelAnswer;
      try {
        res = ((await withTimeout(
          opts.run(model, input, callRunOptions(runOpts, req)),
          timeoutMs,
        )) ?? {}) as ModelAnswer;
      } catch (err) {
        throw asWorkersAIError(err);
      }
      const usage = {
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
      };
      if (res.choices?.[0]?.finish_reason === 'length') {
        // Billed in full though unusable: the usage rides on the error for the budget.
        throw new WorkersAIError(
          'bad_response',
          `Workers AI ${model}: the answer ran past max_tokens`,
          undefined,
          usage,
        );
      }

      const raw = res.response ?? res.choices?.[0]?.message?.content;
      const text =
        typeof raw === 'string'
          ? raw
          : raw === undefined || raw === null
            ? ''
            : JSON.stringify(raw);
      const result: GenerateResult = { text, usage };
      if (req.outputSchema && raw !== undefined && raw !== null) {
        const value = typeof raw === 'string' ? extractJson(raw) : raw;
        if (value !== undefined) result.object = value;
      }
      if (req.tools?.length) {
        const calls = toolCallsOf(res);
        if (calls.length) result.toolCalls = calls;
      }
      return result;
    },
  };
}

/**
 * One call's run options: the gateway route with the request's metadata (ids and versions the
 * caller set), and `x-session-affinity` so calls sharing a prompt prefix reach the replica that
 * cached it. Without a gateway the affinity header still rides (Workers AI reads it directly).
 */
function callRunOptions(
  base: WorkersAiRunOptions | undefined,
  req: Pick<GenerateRequest, 'sessionAffinity' | 'metadata'>,
): WorkersAiRunOptions | undefined {
  const affinity = req.sessionAffinity ? { 'x-session-affinity': req.sessionAffinity } : undefined;
  const metadata = req.metadata && Object.keys(req.metadata).length > 0 ? req.metadata : undefined;
  if (!affinity && !metadata) return base;
  return {
    ...(base?.gateway ? { gateway: { ...base.gateway, ...(metadata ? { metadata } : {}) } } : {}),
    ...(base?.extraHeaders || affinity
      ? { extraHeaders: { ...base?.extraHeaders, ...affinity } }
      : {}),
  };
}

/**
 * Output width of the Workers AI embedding models. Known widths let the
 * adapter fail at boot when EMBEDDINGS_DIM (the Vectorize
 * index width) disagrees with the model, rather than on the first upsert.
 */
export const WORKERS_AI_EMBEDDING_DIMENSIONS: Readonly<Record<string, number>> = {
  '@cf/baai/bge-small-en-v1.5': 384,
  '@cf/baai/bge-base-en-v1.5': 768,
  '@cf/baai/bge-large-en-v1.5': 1024,
  '@cf/baai/bge-m3': 1024,
  // On Workers AI's deprecation list: stops answering on 2026-11-20 (successor
  // `embeddinggemma-2` not out yet). Kept so a deployment on it boots until then.
  '@cf/google/embeddinggemma-300m': 768,
};

/** Default embedding model: 768 dimensions. */
export const DEFAULT_WORKERS_AI_EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';

/** Texts per embedding call — the bge models' batch limit. */
const EMBED_BATCH = 100;

export interface WorkersAIEmbeddingsOptions {
  run: WorkersAiRun;
  /** Embedding model (EMBEDDINGS_MODEL); default {@link DEFAULT_WORKERS_AI_EMBEDDING_MODEL}. */
  model?: string;
  /** The width the platform is sized for (EMBEDDINGS_DIM); must equal the model's. */
  dimensions?: number;
  gatewayId?: string;
  /** As {@link WorkersAIProviderOptions.collectLogs}. */
  collectLogs?: boolean;
  timeoutMs?: number;
}

/**
 * Workers AI implementation of the EmbeddingsProvider port (bge-* by default),
 * over the same injected `run`. Vectors are validated against `dimensions` so a
 * mis-sized model fails loudly instead of corrupting the vector index.
 */
export function createWorkersAIEmbeddings(opts: WorkersAIEmbeddingsOptions): EmbeddingsProvider {
  const model = opts.model || DEFAULT_WORKERS_AI_EMBEDDING_MODEL;
  const known = WORKERS_AI_EMBEDDING_DIMENSIONS[model];
  const dimensions = opts.dimensions ?? known;
  if (dimensions === undefined) {
    throw new WorkersAIError(
      'config',
      `unknown output width for Workers AI embedding model "${model}"; set EMBEDDINGS_DIM`,
    );
  }
  if (known !== undefined && known !== dimensions) {
    throw new WorkersAIError(
      'config',
      `Workers AI model "${model}" produces ${known}-dim vectors but EMBEDDINGS_DIM is ${dimensions}; set EMBEDDINGS_DIM=${known} (and size the Vectorize index to match)`,
    );
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runOpts = gatewayRunOptions(opts.gatewayId, opts.collectLogs);

  return {
    modelId: model,
    dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += EMBED_BATCH) {
        const batch = texts.slice(i, i + EMBED_BATCH);
        let res: { data?: unknown } | undefined;
        try {
          res = (await withTimeout(opts.run(model, { text: batch }, runOpts), timeoutMs)) as
            | { data?: unknown }
            | undefined;
        } catch (err) {
          throw asWorkersAIError(err);
        }
        const data = res?.data;
        if (!Array.isArray(data) || data.length !== batch.length) {
          throw new WorkersAIError(
            'bad_response',
            `embeddings response shape mismatch: expected ${batch.length} vectors, got ${Array.isArray(data) ? data.length : 'none'}`,
          );
        }
        for (const vector of data) {
          if (!Array.isArray(vector) || vector.length !== dimensions) {
            throw new WorkersAIError(
              'bad_response',
              `model "${model}" returned ${Array.isArray(vector) ? vector.length : 'non-array'}-dim vectors but the platform is configured for ${dimensions} (EMBEDDINGS_DIM)`,
            );
          }
          out.push(vector as number[]);
        }
      }
      return out;
    },
  };
}
