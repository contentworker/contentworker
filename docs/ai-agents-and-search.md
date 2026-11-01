# AI, agents & search

contentworker treats AI as a first-class client. Everything here ultimately calls the **same
application use-cases** as the HTTP API, so generated and agent-authored content is validated and
authorized identically to human writes.

## AI provider port

`AIProvider` (`packages/ports/src/infra.ts`) is the generation seam. Callers pick a **tier**, not
a model:

```ts
type ModelTier = 'flagship' | 'balanced' | 'fast';

interface GenerateRequest {
  system?: string;
  prompt: string;
  tier?: ModelTier; // default 'balanced'
  maxTokens: number;
  outputSchema?: Record<string, unknown>; // when set, provider returns JSON matching this schema
}
interface GenerateResult {
  text: string;
  object?: unknown; // parsed when outputSchema was supplied
  usage: { inputTokens: number; outputTokens: number };
}
```

### The Workers AI adapter

`@contentworker/adapters/ai-workers` is the only provider. It runs through the Worker's `AI`
binding, so it needs no credentials, and maps tier → model (overridable per tier with
`WORKERS_AI_MODEL_FLAGSHIP` / `_BALANCED` / `_FAST`):

| Tier       | Default model                              |
| ---------- | ------------------------------------------ |
| `flagship` | `@cf/moonshotai/kimi-k2.6`                 |
| `balanced` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| `fast`     | `@cf/zai-org/glm-4.7-flash`                |

With `AI_GATEWAY_ID` set (the fleet renders one gateway per deployment), calls route through
Cloudflare AI Gateway via the binding's `gateway` option; the gateway applies its rate limit,
retries and, when `aiGatewayLogs` is on, request logging. Without the `AI` binding the stub
provider answers with placeholder values, which the fail-closed adapter guard refuses on a
persistent deployment. `AI_MODE=mock` (local dev, demos, tests) answers every `generateJson` from
its heuristic without calling a model. See [Configuration](./configuration.md) for
`AI_TIMEOUT_MS`.

Embeddings are a **separate port** (`EmbeddingsProvider`): Workers AI
(`createWorkersAIEmbeddings`, `@cf/baai/bge-base-en-v1.5`, 768 dims by default), or the test-kit's
deterministic `LocalEmbeddingsProvider` (`EMBEDDINGS_PROVIDER=local`) for development.

## Content generation

`draftEntry(ctx, ai, scope, input)` generates field values for a content type from a natural-language prompt:

```ts
interface DraftEntryInput {
  contentTypeApiId: string;
  prompt: string;
  tier?: ModelTier; // default 'balanced'
}
```

- It builds a strict JSON Schema (`additionalProperties: false`) from the content type's
  **scalar** fields (`Symbol`, `Text`, `Integer`, `Number`, `Boolean`, `Date` — not links or
  rich text), asks the provider for structured output, then **validates the result against the
  content model** with the same `validateEntryFields` path as human writes.
- Generated values are wrapped in the space's default locale.
- Returns `{ contentTypeApiId, fields, usage }`. Pair it with `createEntry` to actually author.

The rule: _an agent can never produce an entry a person couldn't_ — generation output is rejected
if it fails validation.

## Semantic search / RAG

`packages/application/src/rag.ts`, backed by the `VectorStore` + `EmbeddingsProvider` ports
(`RagDeps`).

**Indexing** (on `entry.published`, driven by the queue consumer's event dispatch):

1. `removeEntryEmbeddings` clears any existing vectors for the entry (idempotent).
2. `extractTextByLocale` collects the entry's string values — plus rich-text bodies flattened
   to plain text via `richTextToPlainText` — grouped by locale.
3. `chunk(text, 400)` splits each locale's text into ≤ 400-word, word-bounded chunks.
4. Chunks are embedded (`taskType: 'document'`) and upserted as `VectorRow`s carrying
   `{ scope, entryId, locale, chunkIndex, chunkText, embedding, entryVersion }`.

On `entry.unpublished`, `removeEntryEmbeddings` deletes the entry's vectors.

**Bulk reindex** — re-embeds every published entry in a scope (optionally one content
type). Use after a change to text extraction or the embedding model so already-published
content becomes searchable without a republish. Exposed as
`POST /spaces/:space/environments/:env/search/reindex` (body: `{ contentTypeApiId? }`,
scope `content:manage`) and the `content_reindex_embeddings` MCP tool.

The trigger (`requestReindex`) is **asynchronous**: it appends a `search.reindex_requested`
event to the transactional outbox and returns **202 Accepted** (`{ enqueued: true }`) — the
`contentworker-events` queue consumer then runs the actual embed loop (`reindexEmbeddings`) off the request
path. It is rate-limited per scope via the shared cache (a retrigger within
`REINDEX_COOLDOWN_SECONDS` returns 429), a single run is bounded by `MAX_REINDEX_ENTRIES`
(reported as `truncated`), and each entry reindex is idempotent (stale vectors are replaced).

**Index health** — answers "is search returning everything it should?" without querying it.
`GET /spaces/:space/environments/:env/search/index` (optional `?content_type=`, scope
`content:manage` — a CDA token carries `search:read` and ships in browsers, and this reports
operational posture, not content) and the `search_index_health` MCP tool compare the documents the
lexical index (`SearchShardDO` shards) holds for the environment against the number of entries
published in it:

```json
{
  "bound": true,
  "engine": "fts5-shards",
  "documents": 1204,
  "publishedEntries": 1207,
  "drift": -3,
  "inSync": false
}
```

- `bound: false` means no `SEARCH` binding, so the lexical leg runs on the store's bounded
  substring scan; a configuration answer, not a health problem.
- Negative `drift` means published entries are missing from the index and searches will not
  find them; positive means it holds documents for entries that are no longer published,
  which surface as hits resolving to nothing.
- `documents` is omitted when the engine cannot count cheaply. It reports the number as
  unavailable rather than estimating one, so drift is never invented.
- Asking about one content type narrows `publishedEntries` but not the index-wide document
  count, so `drift` and `inSync` are withheld — subtracting them would report drift that
  does not exist.
- `inSync` is a cheap negative signal, not a guarantee: one missing and one stale document
  cancel out. It catches the common failure — an index that silently stopped being written
  to — and the remedy is the bulk reindex above, which rewrites both legs.

Read-only and two counts, so it is safe to poll from a monitor.

**Querying** (`semanticSearch(deps, scope, query, { topK = 10, minScore })`):

1. The query is embedded (`taskType: 'query'`).
2. The vector store returns top matches by cosine similarity (over-fetched, then deduplicated to
   the best-scoring chunk per entry).
3. Returns `SearchHit[]` of `{ entryId, score, snippet }`.

The `VectorStore` is Cloudflare Vectorize (`@contentworker/adapters/vector-vectorize`, bound via
`VECTORIZE`; 768 dimensions, cosine, metadata-indexed on `spaceId` and `environmentId`). Vectorize
indexes mutations asynchronously, so search-after-publish lags by a few seconds, and caps a query
at 50 matches (`MAX_TOP_K`, honored by the over-fetch). Without a `VECTORIZE` binding, or with
`VECTOR_STORE=memory`, the Worker uses a per-isolate, non-durable in-memory vector store. The local
stack sets `VECTOR_STORE=kv` instead: vectors live in `KV_CACHE`, which every Worker in the dev
session shares, so what the engine embeds the api can search (brute-force cosine; dev scale only).
The fail-closed adapter guard refuses both on a persistent deployment unless `ALLOW_FAKE_ADAPTERS`
includes `vectors`.

**Hybrid search** (`hybridSearch(deps, ctx, scope, query, { topK = 10 })`) fuses two legs with
Reciprocal Rank Fusion (`score = Σ 1/(60 + rank)`; rank-based, so the legs' incomparable
scores never need calibrating):

- **Semantic**: `semanticSearch` above.
- **Lexical**: the `SearchIndex` port, implemented by `SearchShardDO`
  (`packages/platform/src/do/search-shard.ts`): FTS5 in Durable Objects, `SEARCH_SHARDS` (default
  8) objects per space:environment, keyed `${spaceId}:${environmentId}:${n}`. An entry lives on
  the shard its id hashes to; a query asks every shard for its best `topK` and merges. The
  tokenizer folds accents (`unicode61 remove_diacritics 2`) with 2- and 3-character prefix
  indexes; a `versions` table makes indexing idempotent and order-independent. BM25 is per shard,
  which RRF tolerates. The events consumer keeps the shards fresh on publish and unpublish, and
  reindex slices refresh them in bulk. Keeping FTS out of D1 keeps search writes off D1's single
  writer (and D1 cannot export a database holding a virtual table). If a shard query fails, or no
  `SEARCH` binding exists, the leg falls back to `EntryRepo.searchPublished`, a bounded
  term-prefiltered scan of the published read model. The in-memory test-kit store mirrors the
  semantics so hybrid search is testable.

Lexical-only hits derive their snippet from the published fields. Exposed at
`GET /delivery/:space/:env/search` (hybrid by default; `?mode=semantic` / `?mode=lexical`
selects one leg), the GraphQL `search` resolver, and the `content_search` MCP tool.

## MCP server

The MCP server is served by the api Worker, at **`/mcp`** (`https://api.<domain>/mcp`, and on the
admin origin through the web gateway).
It is a **stateless streamable-HTTP** server built on the v2 TypeScript SDK
(`@modelcontextprotocol/server`): tools are defined in `packages/http/src/mcp/server.ts`, and one
shared handler (`packages/http/src/mcp/http.ts`, `createHandler`) serves both protocol eras:

- **2026-07-28** clients send self-contained requests with no `initialize` handshake. A fresh
  client makes its first call in two requests instead of four, and it caches `tools/list` for
  five minutes.
- **2025-era** clients get the stateless fallback: a fresh server for each request, as before.

Auth is a bearer token resolved like the HTTP API: the MCP root token (`MCP_TOKEN`), a hashed API
key, an OAuth access token, or a personal access token (`packages/http/src/mcp/routes.ts`). MCP mounts
only where the management surface does (`ROLE` includes `management`). On a persistent deployment
it also requires an explicit `MCP_TOKEN`; the in-memory store falls back to `dev-mcp-token`, and
`pnpm dev` sets `MCP_TOKEN=dev-mcp-token`, so a local client can connect to
`http://localhost:5173/mcp`. Every tool calls `authorize(principal, scope, space)`
before delegating to a use-case, and `space`/`environment` default to the seeded values when
omitted. Request bodies are capped at 32 MiB, which fits the importers' 20 MB payload limit after
JSON escaping. The SDK answers internal failures with a bare 500, so the Worker logs them through
the handler's `onerror`.

**Per-request cost.** Each request builds a server bound to the caller's principal, so building it
has to be cheap. Every tool's Zod input schema, and its JSON Schema conversion, is built once per
isolate and shared (`toolSchema` in `packages/http/src/mcp/server.ts`). Building a server takes about
0.1 ms; without the cache it took about 2 ms, and every `tools/list` added another millisecond. As
a consequence, **a tool's input schema must never depend on the principal or deps**;
authorization belongs in the handler. `preloadSchemas()` runs at module scope, so the SDK's own
schemas are built during isolate warm-up rather than on the first request.

**Connecting a client.** With `OAUTH_ISSUER` set, the server is installable as a connector in
Claude, ChatGPT and MCP-capable IDEs: an unauthenticated request answers with
`WWW-Authenticate: Bearer resource_metadata="…"` (RFC 9728), the client fetches
`/.well-known/oauth-protected-resource`, registers itself dynamically, and runs an
authorization-code + PKCE flow that a human approves on the admin origin after signing in to the
web app, choosing the space the connection works in (a fleet deployment's issuer and resource are
`https://<domain>` and `https://<domain>/mcp`). CLI clients that cannot open a browser use
the device flow, and CI uses a personal access token. Whatever the route, the resulting token is
an ordinary API key — so an agent can still never exceed the scopes the approving human holds.
See [Auth & RBAC](./auth-and-rbac.md#oauth-21-for-mcp-clients).

### Tools

The MCP server exposes **123 tools** — one per major Management/Delivery capability. Each tool
calls `authorize` before delegating to the same use-case as the HTTP route.

| Category      | Tools                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Model         | `model_list_content_types`, `model_get_content_type`, `model_entry_counts`, `model_create_content_type`, `model_publish_content_type`                                                                                                                                                                                                                                                            |
| Entries       | `entries_query`, `entries_get`, `entries_create`, `entries_update`, `entries_publish`, `entries_unpublish`, `entries_bulk_action`, `entries_trash`, `entries_list_trashed`, `entries_restore`, `entries_purge`, `entries_duplicate`, `entries_list_versions`, `entries_diff_versions`, `entries_restore_version`, `entries_set_metadata`                                                         |
| AI            | `generate_draft`, `entry_from_canvas`, `entry_translate`, `entry_summarize`, `entry_autofill_field`, `entry_suggest_tags`, `entry_apply_tags`, `entry_audit`, `entry_moderate`                                                                                                                                                                                                                   |
| Search        | `content_search` (hybrid), `content_semantic_search`, `content_related`, `content_duplicates`                                                                                                                                                                                                                                                                                                    |
| Roles         | `roles_list`, `role_create`, `role_update`, `role_delete`                                                                                                                                                                                                                                                                                                                                        |
| Team          | `role_presets_list`, `team_list`, `role_preset_assign` (first-run setup is HTTP-only)                                                                                                                                                                                                                                                                                                            |
| Releases      | `releases_list`, `releases_get`, `releases_create`, `releases_add_entry`, `releases_publish`                                                                                                                                                                                                                                                                                                     |
| Collaboration | `comments_list`, `comments_add`, `tasks_list`, `tasks_create`, `tasks_resolve`, `workflow_transition`                                                                                                                                                                                                                                                                                            |
| Workflows     | `workflow_save_draft`, `workflow_publish`, `workflow_versions`, `workflow_validate`, `workflow_copilot`, `workflow_run_start`, `workflow_run_list`, `workflow_run_get`, `workflow_run_cancel`, `workflow_event_deliver`, `workflow_task_list`, `workflow_task_decide`, `workflow_settings_set`                                                                                                   |
| Taxonomy      | `taxonomy_list_tags`, `taxonomy_create_tag`, `taxonomy_list_concepts`, `taxonomy_create_concept`, `taxonomy_create_scheme`                                                                                                                                                                                                                                                                       |
| Assets        | `assets_list`, `asset_set_metadata`, `asset_usage`, `asset_generate_alt_text`, `asset_auto_tag`, `asset_transform_url`, `asset_video_create`, `asset_video_refresh`                                                                                                                                                                                                                              |
| Branching     | `environments_compare`, `environments_merge`, `environment_aliases_list`, `environment_alias_set`, `environment_alias_delete`, `environment_export`, `environment_import`, `environment_clone`, `environment_delete` |
| Platform      | `functions_list`, `function_create`, `function_delete`, `app_extensions_list`, `app_extension_create`, `app_extension_delete`, `ai_actions_list`, `ai_action_create`, `ai_action_run`, `schedule_action`, `agent_schedule_create`, `agent_schedule_list`, `agent_schedule_update`, `agent_schedule_delete`, `agent_review_list`, `agent_review_approve`, `agent_review_reject`, `audit_log_list` |

Canonical list: `packages/http/src/mcp/server.ts`. The workflow tools declare MCP tool annotations
(`readOnlyHint` on reads, validate and the copilot; `destructiveHint` on `workflow_run_cancel`;
`idempotentHint` where a repeat changes nothing), and run the same use-cases and scope checks as
the `…/workflows`, `…/workflow-runs` and `…/workflow-tasks` routes.

### Skills

The server also publishes **agent skills** through the MCP Skills extension (SEP-2640,
`io.modelcontextprotocol/skills`). A skill is a `SKILL.md` describing a task end to end: which
tools to call, in what order, and which rules trip agents up. Clients that support the extension
list skills with `skills/list` and read them as `skill://contentworker/<name>/SKILL.md` resources.

| Skill                | Covers                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `model-content`      | Creating and publishing content types, choosing field types, `model_typescript`          |
| `author-and-publish` | Finding and editing entries, versions, releases, scheduling, workflow runs and approvals |
| `import-content`     | Field mapping, `identityField`, analyze → execute, publishing the result                 |

The sources live in `packages/http/skills/<name>/`. A Worker has no filesystem, so the files
are embedded into `packages/http/src/mcp/skills.generated.ts`, the same approach as the docs. After
editing a skill, run `pnpm --filter @contentworker/http generate:skills`; a test fails if the
embed drifts. The catalog is loaded with `strict: true`, so a malformed skill fails loudly instead
of being skipped. If loading fails, the error is logged and the tools are served without skills;
the load is retried on the next request. It is digested once per isolate and then attached to
each request's server. Like the `docs_*` tools, skills describe the product rather than any
tenant's content, so being authenticated is the only gate.

Because the tools are thin wrappers over the use-cases, the MCP surface inherits all validation,
referential integrity, RBAC, and event emission for free.

## Agent runtime

`packages/agent-runtime` runs durable agent **workflows** behind an engine-agnostic facade.

```ts
type WorkflowName = 'enrich' | 'moderate' | 'curate' | 'repurpose';
interface AgentRuntime {
  run(workflow, input): Promise<AgentRunResult>;
}
```

On-publish hooks (`AGENTS_ENRICH`, `AGENTS_MODERATE`) run `enrich` then `moderate`. `curate` and
`repurpose` are available for on-demand orchestration (API, MCP, and agent schedules).

`AGENT_RUNTIME=cloudflare-workflows` (with the `AGENT_WF` Workflow binding) routes on-publish and
scheduled agent runs through `CloudflareWorkflowsAgentRuntime` (`packages/platform/src/workflows.ts`),
which starts instances of the durable `AgentWorkflow` (`apps/engine/src/workflows/agent-workflow.ts`). When
`AGENTS_QUEUE` is bound, the events consumer forwards each `entry.published` to the
`contentworker-agents` queue; that consumer starts one workflow instance per chunk of up to 25
entries and acks without waiting on the result. Otherwise, and whenever the binding is absent,
agents run on `InProcessAgentRuntime` (non-durable).

The crucial seam is `Activities` — the side-effecting operations (`loadEntry`, `generateFields`,
`applyFields`, `classify`, `record`). Workflow functions are **pure orchestration** over
`Activities`, so the _same_ workflow code runs:

- **`InProcessAgentRuntime`** — directly in the calling isolate (dev, tests, and every
  synchronous on-demand action from the API or MCP, which need the result in the response). Not
  durable (no crash replay).
- **Cloudflare Workflows** (production) — `AgentWorkflow` hosts `enrich`/`moderate`/`curate`/
  `repurpose`, with each `Activities` call as a durable step. `CloudflareWorkflowsAgentRuntime`
  implements the same `AgentRuntime` interface — callers swap executors with no logic change.

### enrich

Fills empty text/symbol fields (excluding the display field) on a freshly-published entry:

1. Load the entry; if missing → `skipped`.
2. Find empty text fields; if none → `skipped`.
3. `generateFields` (tier `fast`) with the existing text as context.
4. If `autoApply` **and** the model filled every requested field → `applyFields` (a new validated
   draft version) → `completed`.
5. Otherwise → `record` the proposal and return `needs_review` with the `proposed` fields (the
   human-in-the-loop path).

### moderate

1. Load the entry; if missing → `skipped`.
2. `classify` the concatenated text (tier `fast`, strict `{ flagged, categories }` schema).
3. If flagged → `record` a hold → `held`; else → `completed`. Only an explicit
   `flagged: false` passes: an answer that is missing, off the schema or not a boolean holds the
   entry as `unclassified`, so a model that errs (or is talked out of its schema by the content)
   never waves content through.

### curate

Improves already-filled text/symbol fields (excluding the display field) on a published entry:

1. Load the entry; skip if missing or no filled non-display text fields.
2. `generateFields` with an "improve" instruction; compare proposed vs. current values.
3. If `autoApply` and values changed → `applyFields` → `completed`; else → `needs_review`.

### repurpose

Derives channel variants (e.g. social, newsletter) from entry text:

1. Load the entry; skip if missing or no text.
2. `generateFields` with a repurpose instruction for variant fields.
3. Always records the proposal → `needs_review` (never auto-applies).

### Result

```ts
interface AgentRunResult {
  workflow: WorkflowName;
  entryId: string;
  status: 'completed' | 'needs_review' | 'held' | 'skipped';
  decisions: string[]; // audit trail
  usage: { inputTokens: number; outputTokens: number };
  proposed?: EntryFields; // present when needs_review
}
```

The queue consumer runs the on-publish workflows on `entry.published` events: `AGENTS_ENRICH=true`
enables `enrich`, `AGENTS_MODERATE=true` enables `moderate` (enrich runs first so moderation
classifies the enriched content), and `AGENTS_AUTO_APPLY` toggles auto-apply vs. routing
enrichment to human review. Every run is recorded in the agent ledger.

Moderation is also available on demand — `POST .../entries/:id/moderate` (Management API) and
the `entry_moderate` MCP tool both call the same `moderateEntry` use-case, which runs the
workflow in-process and returns `{ flagged, status, decisions, usage }`. A flagged result is a
recorded hold, not a state change: callers (or a webhook consumer) decide whether to unpublish.

## Human-in-the-loop reviews

A workflow run that ends `needs_review` (autoApply off, or low confidence) persists its
proposal as a pending **agent review** — the field values, the agent's reasoning notes, and
the entry it targets. Reviewers list and decide them on both surfaces:

- HTTP: `GET …/agent-reviews?status=pending`, `POST …/agent-reviews/:id/approve`,
  `POST …/agent-reviews/:id/reject` (`preview:read` to list, `content:write` to decide).
- MCP: `agent_review_list`, `agent_review_approve`, `agent_review_reject`.

Approval applies the proposed values as a new draft version through the normal update
use-case (validated, versioned) — **exactly once**, guarded by a CAS apply marker.

On durable runtimes the decision travels as a real signal: after a `needs_review` outcome
the runtime arms a detached **review-watcher workflow** (instance id `review-<reviewId>`)
that parks — for up to 7 days — until the decision arrives as a **Cloudflare Workflow event**
(`review-decision`), then applies/records durably. The
decide use-case signals the watcher when one is armed and falls back to applying directly
when it isn't (in-process runtime, watcher timed out, or signal delivery failed) — the CAS
markers make every combination race-safe: concurrent reviewers can't both decide, and no
path can double-apply. The initiating consumer never waits on a human: the agent run
completes immediately at `needs_review`; only the detached watcher parks.

## Agent schedules

A recurring agent job: on a cron cadence, run one agent workflow (`enrich`, `moderate`,
`curate`, or `repurpose`) over the entries **published since the schedule's previous run** —
delta-based, so a run never reprocesses the whole space. The cron expression is 5-field
(minute hour day-of-month month day-of-week), evaluated in **UTC**, supporting `*`, lists,
ranges, and steps (dependency-free parser in `packages/domain/src/scheduling/cron.ts`).

Window semantics (`runDueAgentSchedules`, `packages/application/src/agent-schedules.ts`):

- **First run = baseline.** A schedule's first due run only records the cursor — schedules
  watch changes going forward, they don't backfill history.
- **Compound delta cursor.** Each run processes entries published strictly after
  `(lastRunAt, cursorEntryId)` in publish order — the entry-id tie-break keeps the boundary
  exact across same-instant publishes (same-transaction publishes share a publish instant).
- **Bounded runs.** A run stops at an entry cap (`AGENT_SCHEDULE_MAX_ENTRIES`, default 25), a
  token ceiling (`AGENT_SCHEDULE_MAX_RUN_TOKENS`, default 100 000, checked mid-batch), and the
  firing instant (entries published while the run executes belong to the next firing). A
  truncated window resumes at the next firing.
- **Failure defers, never drops.** On error the cursor still points at the last successful
  entry, so the remainder of the window is retried at the next firing.
- **Claimed firings.** Each firing is claimed up front via compare-and-swap on the schedule's
  `nextRunAt`, so concurrent runners (overlapping cron ticks, a deploy mid-run) never
  double-run one. Missed runs (e.g. re-enabling a stale schedule) are skipped, never
  burst-replayed.

Every scheduled run goes through the same `AgentRunner` as on-publish agents (in-process or
Cloudflare Workflows) and is recorded in the agent ledger. `autoApply` is
per-schedule: off routes proposals to human review.

**Budget.** Scheduled runs are background spend. They count under a separate `agent:` counter
window on the per-space `CostGuardDO`, so batch spend can't exhaust the interactive budget; that
window enforces the `AI_AGENT_*` ceilings when set and the interactive `AI_*` ceilings otherwise.
Durable `AgentWorkflow` runs are metered the same way. See [Configuration](./configuration.md).

**Host.** The engine Worker runs due schedules on its 1-minute cron tick when `AGENTS_SCHEDULES=true`.

**Surfaces.** CRUD on both, backed by the same use-cases: the Management API
(`GET`/`POST …/agent-schedules`, `PATCH`/`DELETE …/agent-schedules/:id` — listing needs
`preview:read`, mutations `content:publish`; see the
[API reference](./api-reference.md#agent-schedules)) and the MCP tools
`agent_schedule_create` / `agent_schedule_list` / `agent_schedule_update` /
`agent_schedule_delete`.
