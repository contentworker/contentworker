import type {
  AssetVideoStatus,
  DomainEvent,
  FieldIssue,
  FocalPoint,
  Scope,
  Webhook,
} from '@contentworker/domain';

/**
 * Infrastructure ports for the async backbone and AI layer. They are defined
 * here so the seams exist from day one (per the architecture's "leave clean
 * seams" rule); adapters are implemented in later phases. The application layer
 * may depend on these interfaces without any concrete infra being present.
 */

/** One message in a batched enqueue. */
export interface QueueMessage {
  readonly payload: unknown;
  readonly delayMs?: number;
  readonly dedupeKey?: string;
}

/** Generic work queue (Cloudflare Queues in production; in-memory in tests). */
export interface Queue {
  enqueue(
    topic: string,
    payload: unknown,
    opts?: { delayMs?: number; dedupeKey?: string },
  ): Promise<void>;
  /**
   * Enqueues many messages in as few backend calls as the adapter allows
   * (Cloudflare `sendBatch`). Same at-least-once and dedupe
   * semantics as {@link enqueue}; callers must not assume atomicity across the
   * whole batch — a crash mid-call may leave a prefix enqueued.
   */
  enqueueMany(topic: string, messages: readonly QueueMessage[]): Promise<void>;
  process(topic: string, handler: (payload: unknown) => Promise<void>): Subscription;
}

/** Pub/sub fan-out of domain events. */
export interface EventBus {
  publish(event: DomainEvent): Promise<void>;
  subscribe(pattern: string, handler: (event: DomainEvent) => Promise<void>): Subscription;
}

export interface Subscription {
  close(): Promise<void>;
}

/** Object storage for assets (R2). */
export interface BlobStore {
  getUploadUrl(
    key: string,
    contentType: string,
  ): Promise<{ url: string; headers: Record<string, string> }>;
  getDownloadUrl(key: string): Promise<string>;
  delete(key: string): Promise<void>;
  /**
   * Server-side write, for content the server owns rather than proxies.
   *
   * Distinct from {@link getUploadUrl}, which delegates the transfer to a
   * client — right for a user uploading an image, wrong for something the
   * server must also read back and verify, where presigning a URL for
   * ourselves to then fetch is a round-trip through the network for no reason.
   */
  put(key: string, body: string | Uint8Array, contentType: string): Promise<void>;
  /** Server-side read. `null` when the object does not exist. */
  get(key: string): Promise<string | null>;
  /**
   * Deletes every object under `prefix` except those `keep` names, and returns how many went.
   * Optional: a store without it leaves the objects (a deleted environment's files stay).
   */
  deletePrefix?(prefix: string, keep: (key: string) => boolean): Promise<number>;
}

/** How an image is fit into the requested box (provider-neutral names). */
export type ImageFit = 'clip' | 'crop' | 'fill' | 'max' | 'scale';

/**
 * Output encoding. `auto` asks the transformer to negotiate from the client's
 * `Accept` header (AVIF, then WebP, then the source format).
 */
export type ImageFormat = 'auto' | 'jpg' | 'png' | 'webp' | 'avif';

/** A requested image transformation. Validated by the application layer. */
export interface ImageTransformSpec {
  readonly width?: number;
  readonly height?: number;
  readonly fit?: ImageFit;
  readonly format?: ImageFormat;
  /** Output quality, 1..100 (lossy formats). */
  readonly quality?: number;
}

/**
 * Turns a stored image URL plus a transform into a URL that serves the
 * transformed image. A port so the application never learns which image
 * service (Cloudflare Images, an imgix-style CDN) does the work; the
 * focal point, when known, anchors crops (the service's "gravity").
 */
export interface ImageTransformer {
  transformUrl(
    sourceUrl: string,
    transform: ImageTransformSpec,
    focalPoint?: FocalPoint,
  ): Promise<string>;
}

/** A one-time, direct-from-client upload target issued by a {@link VideoHost}. */
export interface VideoUpload {
  /** The host's id for the video the upload will create. */
  readonly videoId: string;
  /** The client POSTs the file here as multipart form field {@link fileField}. */
  readonly uploadUrl: string;
  readonly method: 'POST';
  readonly fileField: string;
}

/** What a video host currently reports about a video. */
export interface HostedVideo {
  readonly videoId: string;
  readonly status: AssetVideoStatus;
  readonly hlsUrl?: string;
  readonly dashUrl?: string;
  readonly thumbnailUrl?: string;
  readonly durationSeconds?: number;
  readonly width?: number;
  readonly height?: number;
  readonly errorReason?: string;
}

/**
 * Hosts video: encoding, adaptive playback, posters. Uploads go straight from
 * the client to the host (the bytes never transit the API), mirroring the
 * BlobStore's presigned-upload contract.
 */
export interface VideoHost {
  /** Provider name stamped onto assets, e.g. `stream`. */
  readonly provider: string;
  createUpload(opts: {
    readonly maxDurationSeconds: number;
    /** Opaque metadata echoed back on status webhooks (asset id, scope). */
    readonly meta?: Readonly<Record<string, string>>;
  }): Promise<VideoUpload>;
  /** `null` when the host has no such video. */
  getVideo(videoId: string): Promise<HostedVideo | null>;
  delete(videoId: string): Promise<void>;
}

/** Read-through cache for the Delivery API, with tag-based invalidation. */
export interface Cache {
  get(key: string): Promise<string | null>;
  /** Stores `value` under `key`, associated with the given invalidation tags. */
  set(
    key: string,
    value: string,
    opts?: { ttlSeconds?: number; tags?: readonly string[] },
  ): Promise<void>;
  /** Evicts every cached entry associated with `tag`. */
  invalidateTag(tag: string): Promise<void>;
  /**
   * Batch {@link invalidateTag}: adapters dedupe and use their cheapest bulk
   * form (e.g. parallel KV writes). Idempotent — safe to re-run on
   * a redelivered event.
   */
  invalidateTags(tags: readonly string[]): Promise<void>;
}

export interface WebhookSendResult {
  readonly delivered: boolean;
  readonly statusCode?: number;
  readonly error?: string;
}

/**
 * Fetches a remote document on an operator's behalf.
 *
 * Narrow on purpose: GET only, size-bounded, and never follows redirects — a
 * 3xx to an internal host is the classic way an SSRF guard on the *requested*
 * URL gets walked around. Callers screen the URL before handing it over; this
 * is the second line, not the first.
 */
export interface RemoteFetcher {
  get(
    url: string,
    options: { readonly maxBytes: number; readonly timeoutMs?: number },
  ): Promise<RemoteDocument>;
}

export interface RemoteDocument {
  readonly status: number;
  readonly contentType?: string;
  /** Response body as text. Empty when the status is not 2xx. */
  readonly body: string;
}

/** One outbound email. */
export interface EmailMessage {
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  /**
   * Stable per logical send (a workflow node's effect key): an adapter that supports it passes it
   * on so a retried step never mails twice.
   */
  readonly idempotencyKey?: string;
}

export interface EmailSendResult {
  readonly delivered: boolean;
  readonly id?: string;
  readonly error?: string;
}

/**
 * Sends email (workflow notifications, approver digests). Cloudflare Email Sending implements it
 * on edge; test-kit records messages.
 */
export interface EmailSender {
  send(message: EmailMessage): Promise<EmailSendResult>;
}

/** Signs and POSTs a webhook payload. Implemented by the worker (HMAC + fetch). */
export interface WebhookSender {
  send(webhook: Webhook, payload: DomainEvent): Promise<WebhookSendResult>;
}

export interface FunctionInvokeResult {
  readonly ok: boolean;
  readonly statusCode?: number;
  readonly error?: string;
}

/** Invokes a user-defined function on an event (HTTP by default; sandbox swappable). */
export interface FunctionInvoker {
  invoke(url: string, event: DomainEvent): Promise<FunctionInvokeResult>;
}

// ---- AI layer seams -------------------------------------------------------

export type ModelTier = 'flagship' | 'balanced' | 'fast';

/** A tool call the model asked for (or, in history, made earlier). */
export interface ToolCall {
  /** Provider-assigned id; a `tool` message answers it by this id. */
  id: string;
  name: string;
  /** Parsed arguments (an object matching the tool's `inputSchema`). */
  input: unknown;
}

/** A tool the model may call. */
export interface ToolSpec {
  name: string;
  description?: string;
  /** JSON Schema of the tool's input object. */
  inputSchema: Record<string, unknown>;
}

/**
 * One turn of a multi-turn conversation. `system` stays on
 * {@link GenerateRequest.system}; tool results answer a prior assistant
 * tool call by its id.
 */
export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface GenerateRequest {
  system?: string;
  /**
   * The user turn. With {@link messages}, it is appended as the final user
   * turn when non-empty (pass `''` to send `messages` alone).
   */
  prompt: string;
  /** Earlier turns of a conversation, oldest first (tool calling, assistants). */
  messages?: ChatMessage[];
  /** Tools the model may call; any calls come back in {@link GenerateResult.toolCalls}. */
  tools?: ToolSpec[];
  tier?: ModelTier;
  maxTokens: number;
  /** When set, the provider must return JSON matching this JSON Schema. */
  outputSchema?: Record<string, unknown>;
}

export interface GenerateResult {
  text: string;
  /** Parsed object when `outputSchema` was supplied. */
  object?: unknown;
  /** Tool calls the model made this turn (only when `tools` were offered). */
  toolCalls?: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
}

/** Chat/generation provider. Workers AI by default; swappable. */
export interface AIProvider {
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

/**
 * A question for a {@link DecisionModel}. Decision models don't write text: they read a state
 * and answer each question with a probability for every allowed answer.
 * - `noul`: yes or no; answered with the probability of yes.
 * - `choice`: one of `options` (id → description); answered with the most probable option,
 *   the probability of each, and a confidence.
 * - `score`: a level on an ordered rubric (`levels`, lowest first); answered with a
 *   probability-weighted score (0 = the lowest level) and the probability of each level.
 */
export type DecisionQuestion =
  | {
      readonly type: 'noul';
      readonly instructions: string;
      /** What yes and no mean, when the instructions alone leave it open. */
      readonly criteria?: { readonly true: string; readonly false: string };
    }
  | {
      readonly type: 'choice';
      readonly instructions: string;
      readonly options: Readonly<Record<string, string>>;
    }
  | { readonly type: 'score'; readonly instructions: string; readonly levels: readonly string[] };

export interface DecisionRequest {
  /** What to decide about: text, or structured data. Untrusted content is fine here: the model
   *  can only answer the questions, from the options they define. */
  readonly state: string | Readonly<Record<string, unknown>> | readonly unknown[];
  /** 1 to 64 questions, by id (letters, digits, `_`, `.`, `-`). Answers come back by the same ids. */
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
  /** `flagship` for the most precise decisions, `fast` for the hot path. */
  readonly tier?: ModelTier;
}

export type DecisionAnswer =
  | { readonly type: 'noul'; readonly probability: number }
  | {
      readonly type: 'choice';
      readonly choice: string;
      readonly confidence: number;
      readonly probabilities: Readonly<Record<string, number>>;
    }
  | { readonly type: 'score'; readonly score: number; readonly probabilities: readonly number[] };

export interface DecisionResult {
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
  /** The model that answered. */
  readonly model: string;
  /** Decision models bill input only. */
  readonly usage: { readonly inputTokens: number };
}

/** Decision provider: typed questions in, probabilities out. Workers AI (Clef) by default. */
export interface DecisionModel {
  decide(req: DecisionRequest): Promise<DecisionResult>;
}

/** Verdict from a {@link CostGuard} on whether a scope may make an AI call now. */
export interface AiBudgetDecision {
  readonly allowed: boolean;
  /** Which ceiling was hit, when `allowed` is false. */
  readonly reason?: 'requests' | 'tokens';
  /** Seconds until the rolling window frees up (best-effort hint for Retry-After). */
  readonly retryAfterSeconds?: number;
}

/**
 * Per-space AI usage governor. The application layer calls {@link consume}
 * before every AI generation and {@link settle} with the observed token usage
 * after — enforcing per-`Scope` request and token ceilings over a rolling
 * window so a single space (or a leaked key) cannot drive unbounded provider
 * spend. Backed by a Durable Object when shared state across isolates is needed,
 * or an in-process window for dev/tests.
 */
export interface CostGuard {
  /** Registers one AI request for the scope and reports whether it is within budget. */
  consume(scope: Scope): Promise<AiBudgetDecision>;
  /** Records observed token usage after a call (counts toward the token ceiling). */
  settle(scope: Scope, tokens: number): Promise<void>;
}

/** Embeddings provider (a separate port: embedding and generation models are chosen apart). */
export interface EmbeddingsProvider {
  readonly modelId: string;
  readonly dimensions: number;
  embed(texts: string[], opts?: { taskType?: 'document' | 'query' }): Promise<number[][]>;
}

export interface VectorRow {
  readonly scope: Scope;
  readonly entryId: string;
  readonly locale: string;
  readonly chunkIndex: number;
  readonly chunkText: string;
  readonly embedding: number[];
  readonly entryVersion: number;
}

export interface VectorMatch {
  readonly entryId: string;
  readonly chunkText: string;
  readonly score: number;
}

/** One indexed lexical document per published entry. */
export interface SearchDoc {
  readonly entryId: string;
  readonly contentTypeApiId: string;
  /** Human-readable text per locale (extracted from the entry's fields). */
  readonly textByLocale: Record<string, string>;
  readonly entryVersion: number;
}

/** What an index knows about its own contents, for one scope. */
export interface SearchIndexStats {
  /** Documents held for this scope — one per published entry when in sync. */
  readonly documents: number;
  /** Engine identifier, for an operator staring at a drift number. */
  readonly engine?: string;
}

/** One ranked lexical match (engine-relative score, ordering-only). */
export interface LexicalSearchHit {
  readonly entryId: string;
  readonly score: number;
}

/**
 * Lexical full-text index over published entries: the SearchShard Durable Objects (FTS5) in a
 * deployment. When bound, publishes (and the reindex job) write into it and hybrid search reads
 * its ranking; absent, the lexical leg falls back to `EntryRepo.searchPublished` (a bounded
 * substring scan, fine for dev and small spaces).
 */
export interface SearchIndex {
  /**
   * `refresh: false` defers making the doc searchable until the engine's own
   * refresh cycle — bulk callers (reindex) set it; publish-time indexing
   * defaults to immediate visibility.
   */
  index(scope: Scope, doc: SearchDoc, opts?: { refresh?: boolean }): Promise<void>;
  remove(scope: Scope, entryId: string): Promise<void>;
  search(scope: Scope, query: string, opts: { topK: number }): Promise<LexicalSearchHit[]>;
  /**
   * How many documents the engine holds for this scope.
   *
   * Optional: an engine that cannot count cheaply should omit it rather than
   * estimate, so a health report can say the number is unavailable instead of
   * reporting drift that may not exist.
   */
  stats?(scope: Scope): Promise<SearchIndexStats>;
}

/** Vector store for semantic search / RAG (Vectorize by default). */
export interface VectorStore {
  /**
   * Largest `topK` a single query honors, when the backend caps it (e.g.
   * Vectorize: 50 with metadata). Callers clamp their over-fetch to this so a
   * backend limit is an explicit contract, not a silent truncation.
   */
  readonly maxTopK?: number;
  upsert(rows: VectorRow[]): Promise<void>;
  deleteByEntry(scope: Scope, entryId: string): Promise<void>;
  query(
    scope: Scope,
    embedding: number[],
    opts: { topK: number; minScore?: number },
  ): Promise<VectorMatch[]>;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * The interception points a hook can register for.
 *
 * Deliberately few and named for the exact moment they fire. Every one sits on
 * a write path, so each addition costs latency on an operation an editor is
 * waiting for — this is not a general event bus. Anything that can happen
 * *after* a commit belongs on the outbox instead, where it is retried,
 * observable, and cannot fail the request.
 */
export const HOOK_NAMES = [
  /** After defaults are applied, before slug normalization and validation. */
  'entry:beforeSave',
  /** Inside the publish transaction — a veto rolls the whole publish back. */
  'entry:beforePublish',
  'entry:beforeTrash',
  'entry:beforePurge',
  /** Before an upload URL is minted, so a refusal costs no storage. */
  'asset:beforeCreate',
] as const;
export type HookName = (typeof HOOK_NAMES)[number];

/** A hook declined the operation. */
export interface HookVeto {
  /** Which hook refused, so the message can say whose rule this was. */
  readonly hook: string;
  readonly reason: string;
  /**
   * Field-level objections. When present on `entry:beforeSave` the caller
   * raises a ValidationError, so a hook's complaint about a field reaches the
   * editor the same way a built-in validation would.
   */
  readonly issues?: readonly FieldIssue[];
}

/**
 * The outcome of dispatching one hook: either the (possibly rewritten) payload,
 * or a refusal.
 */
export type HookResult<T> = { readonly payload: T } | { readonly veto: HookVeto };

/**
 * Runs registered handlers for a hook.
 *
 * Implementations MUST: run handlers sequentially in registration order, each
 * seeing the previous one's mutations, so the result is deterministic; bound
 * every handler with a timeout; and never expose the store — a handler
 * receives a payload, not a database.
 *
 * A handler that throws or times out is governed by that handler's own error
 * policy, not the dispatcher's: an optional enrichment must not make the CMS
 * unwritable, while a compliance rule must be able to insist that failure means
 * refusal.
 */
export interface HookDispatcher {
  dispatch<T>(hook: HookName, payload: T, scope: Scope): Promise<HookResult<T>>;
}

// ---------------------------------------------------------------------------
// Plugin execution
// ---------------------------------------------------------------------------

/** One call into a plugin: the code, the hook, and the payload. */
export interface PluginInvocation {
  readonly pluginId: string;
  /** Module source. The caller has already verified it against its checksum. */
  readonly bundle: string;
  /** Module path the bundle registers itself under. */
  readonly entrypoint: string;
  /** Distinguishes cached isolates — a changed bundle must not reuse an old one. */
  readonly checksum: string;
  readonly hook: HookName;
  readonly payload: unknown;
  /**
   * The effective grant (declared ∩ approved). A runtime MUST hand the plugin
   * no capability method outside this list.
   */
  readonly capabilities: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly timeoutMs?: number;
  /** Where the hook fired — carried so a refused capability call can be audited. */
  readonly scope?: Scope;
}

/**
 * Host-side capability objects, keyed by the name a plugin sees.
 *
 * Passed *per invocation* rather than baked into the isolate: a warm, cached
 * sandbox must not retain authority granted for an earlier call. The
 * implementations live outside the sandbox, so a plugin holds a reference, never
 * the code or the authority behind it.
 *
 * A capability that was not granted carries no authority: the application
 * builds no method for it, and the sandbox runtime hands the plugin at most an
 * inert stand-in that refuses with a `capability_denied` error.
 */
export type PluginCapabilities = Record<string, unknown>;

/**
 * Runs plugin code in isolation.
 *
 * Implementations MUST: refuse to run anything they cannot sandbox; bound every
 * invocation with a timeout; and never hand a plugin a capability that was not
 * passed in.
 */
export interface PluginRuntime {
  invoke(
    invocation: PluginInvocation,
    capabilities: PluginCapabilities,
  ): Promise<HookResult<unknown>>;
}
