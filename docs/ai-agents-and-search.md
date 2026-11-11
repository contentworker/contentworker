# AI, agents & search

ContentWorker treats AI as a first-class client. Everything here ultimately calls the **same
application use-cases** as the HTTP API, so generated and agent-authored content is validated and
authorized identically to human writes.

## AI provider port

`AIProvider` (`packages/ports/src/infra.ts`) is the generation seam. Callers pick a **tier**, not
a model:

```ts
type ModelTier = 'flagship' | 'balanced' | 'fast';

interface GenerateRequest {
  system?: string;
  prompt: string; // with `messages`, the final user turn when non-empty ('' sends `messages` alone)
  messages?: ChatMessage[]; // earlier turns, oldest first (user / assistant / tool)
  tools?: ToolSpec[]; // { name, description?, inputSchema } the model may call
  tier?: ModelTier; // default 'balanced'
  maxTokens: number;
  outputSchema?: Record<string, unknown>; // when set, provider returns JSON matching this schema
}
interface GenerateResult {
  text: string;
  object?: unknown; // parsed when outputSchema was supplied
  toolCalls?: ToolCall[]; // { id, name, input }; only when `tools` were offered
  usage: { inputTokens: number; outputTokens: number };
}
```

A `tool` message answers an assistant `ToolCall` by its `id`.

### The edge inference adapter

`@contentworker/adapters/ai-workers` is the only provider. It runs through the worker's `AI`
binding, so it needs no credentials, and maps tier → model (overridable per tier with
`WORKERS_AI_MODEL_FLAGSHIP` / `_BALANCED` / `_FAST`):

| Tier       | Default model                              |
| ---------- | ------------------------------------------ |
| `flagship` | `@cf/moonshotai/kimi-k2.6`                 |
| `balanced` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| `fast`     | `@cf/zai-org/glm-4.7-flash`                |

With `AI_GATEWAY_ID` set (the fleet renders one gateway per deployment), calls route through
the AI gateway via the binding's `gateway` option; the gateway applies its rate limit,
retries and, when `aiGatewayLogs` is on, request logging. Without the `AI` binding the stub
provider answers with placeholder values, which the fail-closed adapter guard refuses on a
persistent deployment. `AI_MODE=mock` (local dev, demos, tests) answers every `generateJson` from
its heuristic without calling a model. See [Configuration](./configuration.md) for
`AI_TIMEOUT_MS`.

### Decision models

Some AI work is a decision, not a text: which label, which route, is this unsafe, does this need a
person. That goes to a second port, `DecisionModel`. It takes a state (text or JSON) and up to 64
typed questions, and answers each with a probability for every allowed answer:
- `noul`: yes/no, answered with the probability of yes;
- `choice`: one of a set of options, answered with each option's probability and a confidence;
- `score`: a level on an ordered rubric, answered with a probability-weighted score.

There's no text to parse, so no schema to check and no off-menu answer. The probabilities are the
model's, not a number it writes, so they can carry thresholds. Hostile content in the state can
still sway an answer, but it can't make the model answer outside the options.

`createWorkersAIDecisionModel` runs the platform's Clef models over the same `AI` binding and AI
gateway settings as generation: `@cf/cloudflare/clef` for `flagship` and `balanced`, and
`@cf/cloudflare/clef-flash` (much faster and cheaper) for `fast`. Clef bills input tokens only.
Calls go through `decide()` (`ai-decide.ts`), with the same guarantees as `generateJson`:
- `decideWithBudget` meters input tokens against the space's AI budget;
- `AI_MODE=mock` and budget refusals answer with the caller's heuristic;
- a failure retries while the durable step can, then falls back;
- every call is an `ai_call` record with its provenance.

Without the `AI` binding the stub answers the first option, no, or the lowest level, and the
adapter guard refuses it on a persistent deployment. The platform binds it both to the workflow
node deps and to `ctx.decisions`, so use-cases reach it without another parameter. Beyond the nodes
below:
- The **moderation agent** asks the same questions as `ai.moderate` (see [moderate](#moderate)).
- **Tag suggestions** (`suggestEntryTags`, the `ai.suggest_tags` node, `entry_suggest_tags`) ask
  one yes/no per existing tag, 64 to a request, and take the tags at or above 0.5. A new tag name is
  writing, not choosing, so the generative model is asked for new names only when no existing tag
  fits. It doesn't get to overrule that decision by picking existing tags itself.

Workflow nodes that choose ask the decision model when one is bound (the platform always binds one),
and fall back to a generative model's JSON otherwise:

| Node          | Questions                                                                                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai.classify` | one `choice` over the node's labels; `output.probabilities` carries each label's                                                                                                                                      |
| `ai.router`   | one `choice` over the routes whose guards hold; the author's instructions are the question                                                                                                                            |
| `ai.moderate` | a `noul` per category (hate, violence, sexual, harassment, self-harm, anything else unsafe or illegal, plus house rules when set); a category at or above the node's `threshold` (between 0 and 1, default 0.5) flags |
| `ai.assess`   | the node's own questions, which already use this shape                                                                                                                                                                |

The entry is always the state and never the question, capped at 20,000 characters as the
generative prompts are, so the author's instructions and the house rules stay out of reach of the
content being judged. A router with one allowed route, or a classifier with one label, answers
without asking. Gating nodes fail closed exactly as before: an
answer the model couldn't give flags (moderation), takes the careful route (router) or goes to
`unsure` (assess).

Embeddings are a **separate port** (`EmbeddingsProvider`): edge inference
(`createWorkersAIEmbeddings`, `@cf/baai/bge-base-en-v1.5`, 768 dims by default), or the test-kit's
deterministic `LocalEmbeddingsProvider` (`EMBEDDINGS_PROVIDER=local`) for development.

### Which tier each use-case asks for

A use-case's `tier` input overrides these defaults; a space's tier for the capability (see
[AI settings per capability](#ai-settings-per-capability)) replaces the default when the request
names none.

| Use-case                                                      | Default tier                                                                                                                                                    |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content-ai`: `translateEntry`, `autofillField`               | `balanced`                                                                                                                                                      |
| `content-ai`: `summarizeEntry`, `suggestEntryTags`            | `fast`                                                                                                                                                          |
| `media-ai`: alt text, asset auto-tag                          | `fast`                                                                                                                                                          |
| `draftEntry`, `canvasToEntry` (`generation.ts`), `auditEntry` | `balanced`                                                                                                                                                      |
| `generateBlocks` (`layout-generation.ts`)                     | `flagship`                                                                                                                                                      |
| `ai-actions` (`runAIAction`)                                  | the action's own `tier` (default `balanced`)                                                                                                                    |
| `workflow-copilot` (`workflow_copilot`)                       | `balanced`                                                                                                                                                      |
| Workflow AI nodes (`workflow-nodes/ai.ts`)                    | `fast` for `ai.classify`, `ai.summarize`, `ai.suggest_tags`, `ai.moderate`, `ai.enrich`; `balanced` for `ai.router`, `ai.assess`, `ai.translate`, `ai.autofill` |
| Agent runtime activities (`generateFields`, `classify`)       | `fast`                                                                                                                                                          |
| Coworker (assistant)                                          | `flagship`, falling back to `fast`                                                                                                                              |

### AI settings per capability

A space's administrators decide, per **capability**, whether AI does that work at all, which tier
it runs on, and what guidance is added to its built-in prompt (`AiSettings` in
`packages/domain/src/ai/ai-settings.ts`, the use-cases in `packages/application/src/ai-settings.ts`).
A capability names a kind of work, not a surface, so turning one off stops it wherever it runs: the
admin, REST, MCP, Coworker and workflow nodes.

| Capability     | Covers                                                                                                                                                                     | Off                                                                                                                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drafting`     | `draftEntry`, `canvasToEntry`                                                                                                                                              | refused                                                                                                                                                                                                              |
| `layout`       | `generateBlocks` (the canvas, `entry_blocks_generate`, Coworker's block fills)                                                                                             | refused                                                                                                                                                                                                              |
| `assistant`    | Coworker's model turns                                                                                                                                                     | the turn answers that Coworker is off; pages' own edits still go through it                                                                                                                                          |
| `field-assist` | `autofillField`, `summarizeEntry`, `suggestEntryTags`, `runAIAction`                                                                                                       | refused; the `ai.summarize`, `ai.autofill` and `ai.suggest_tags` nodes record a no-op                                                                                                                                |
| `translation`  | `translateEntry` (editor, API, MCP, the `ai.translate` node)                                                                                                               | refused; the node records a no-op                                                                                                                                                                                    |
| `media`        | `generateAltText`, `autoTagAsset`, and the ingest steps that call them                                                                                                     | refused on request; ingest skips the steps                                                                                                                                                                           |
| `search`       | entry and asset embeddings, asset text extraction, `relatedEntries`, `findDuplicates`, `getEntryEmbedding`, management semantic search                                     | nothing new is embedded and a (re)published entry's or asset's vectors are dropped; the semantic tools refuse; `content_search` and asset search use the lexical leg only                                            |
| `agents`       | the on-publish enrich agent (inline and durable), agent schedules except moderation ones, `auditEntry`, the agent runtime's `generateFields`, the AI review of a promotion | publish enrich and schedule firings skip (a schedule's cursor waits); a run already under way generates nothing; an audit is refused; a promotion is assessed without the model, as where no decision model is bound |
| `workflows`    | `draftWorkflowGraph` (the copilot), `ai.classify`, `ai.router`, `ai.assess`, `ai.moderate`, `ai.enrich`                                                                    | the copilot is refused; each node answers with its heuristic, recorded as a `disabled` fallback (moderation's flags)                                                                                                 |

A request refused answers **409 `ai_capability_disabled`**, its body naming the capability and its
message saying an administrator can turn it on in Settings → AI. 409, like `last_admin` and
`publish_gated`, is a conflict with how the space is configured: not 503 (`AiUnavailableError`,
the model failing, retryable as it stands) and not 403 (the caller's permissions are fine). Work
nobody is waiting on (ingest, queue consumers, schedules, workflow steps) skips instead, so turning a
capability off never fails a run or makes a step retry; such a fallback is logged at info, not as a
warning. Moderation is the deployment's control (`AGENTS_MODERATE`, `AGENTS_MODERATE_BLOCKING`, and
moderation schedules) and no space setting reaches it: the on-publish pass runs moderation even when
its enrich step fails.

In the admin, a capability that is off hides what it powers: Generate with AI and Draft from prose on
an entry (`drafting`), Draft with AI and Change with AI on workflows (`workflows`), and Coworker's
composer and suggestions (`assistant`), which become a note naming Settings → AI. Other entry points
stay and show the API's refusal. Nothing is hidden while the settings load or can't be read: the
API is what refuses. The drafting and canvas dialogs default to **Space default**, which sends no
tier.

**Search** stops on both sides: the point of turning it off is that content stops going to the
embeddings model. Delivery's `/search` and GraphQL `search` don't read the setting, so the public
read path takes no extra statement; they serve what the index still holds (until the reindex below
deletes it), and their semantic leg still embeds the reader's query. Turning search off also stops
reading the text of uploaded documents and recordings, so new ones are found by their name and
metadata only.

**Turning search on or off reindexes it** (`packages/application/src/search-reindex.ts`). A set that
changes `search.enabled` appends one `search.toggled` per environment of the space, in the same unit
as the settings row (`tx.aiSettings.save` with `tx.outbox.appendMany`), so the setting and its
reindex commit together or not at all. The event is routed to the bulk topic; its consumer starts
the environment's `search_reindex` bulk job over every published entry (`entry:<id>`, up to
`MAX_REINDEX_ENTRIES`) and every asset (`asset:<id>`, as many), in chunks of
`SEARCH_REINDEX_CHUNK_SIZE` (100). Off, a chunk deletes each entry's vectors and both of each
asset's corpora; on, it embeds the chunk's published entries together (`indexEntriesEmbeddings`:
every entry's chunks in every locale in one `embed` call, which the adapter sends 100 texts at a
time, so a chunk is a few embeddings requests rather than one per entry and locale; the account's
embeddings rate limit is shared by every deployment on it) and each asset again
(`embedAssetForSearch`), never a draft. A failed embeddings or vector call fails the chunk, which is
released and retried whole (it is idempotent) and failed for good after its attempts. Each chunk reads
the setting in force when it runs, not the one that started the job, so a chunk of an overtaken job
can only bring the index nearer the setting. The lexical leg isn't touched: it never reaches a
model.

- **Superseding.** A toggle while a job runs cancels it (`cancelBulkJob`) and starts another. An
  event a later toggle overtook (the setting no longer what it asked for) starts nothing, and a
  redelivered one finds the job it started (by `config.settingsVersion`).
- **Whose job.** The system's: no starter is recorded, so its chunks don't re-check anyone's access
  (`starterLostAccess`). It realizes the space's setting, which stays in force whoever set it; were
  it stopped when that person lost access, the index would be left half way between on and off.
  Who turned it is on the job as `config.actor`, and in the settings' audit row. Cancelling one
  takes `space:admin` besides the cancel route's `content:publish` (`authorizeBulkJobAccess`: the
  bulk job cancel route and `bulk_job_cancel` answer 403 to anyone else), so a lesser role can't leave a setting half
  applied; its report takes `content:manage`, as following it does.
- **Following it.** `GET …/search/reindex-job` and MCP `search_reindex_job` (`content:manage`)
  answer the environment's latest one (looked up by action, however many other jobs ran since); its
  report and cancel are the bulk job routes'. The admin's Settings → AI
  says "Reindexing search: 40%" on the search row while it runs.
- **Cost.** Embeddings aren't metered by `CostGuardDO` (they never were: they run on every publish,
  at a fraction of a generation's cost), and search has no tier, so neither the budget nor
  `AI_MAX_TIER` bounds this job; its size is bounded instead, as above. Assets uploaded while search
  was off had no text read from them: the job embeds their name and metadata, and a reindex of the
  assets (`POST …/assets/reindex` with `all`) reads their text, running ingest's other steps (alt
  text and tags, under `media`) again too.
- **Not covered.** A deployment with no vectors bound (no `EMBEDDINGS_PROVIDER`) starts no job.
  Entries beyond `MAX_REINDEX_ENTRIES` in one environment wait for their next publish (or `POST
  …/search/reindex`).

**Tier.** `policy.tier(callSiteDefault, requested)` answers the request's own tier, else the space's,
else the call site's default ([the table above](#which-tier-each-use-case-asks-for)), held to the
deployment's cap (below). The tier then goes through the AI adapter's tier → model mapping
(`WORKERS_AI_MODEL_BY_TIER`, the `WORKERS_AI_MODEL_*` overrides) and AI Gateway like any other call,
and `CostGuardDO` meters it the same; Coworker maps it with the same table, with the fast tier
behind it. An AI action names its own tier, which stands under the cap.

**The deployment's tier cap.** `CostGuardDO` counts requests and tokens, not price, so a space that
pins background work (agents, workflows, media) to `flagship` would cost several times what it did
at `fast` without tripping anything. `AI_MAX_TIER` (`balanced` or `fast`; `flagship` or empty is no
cap; anything else fails at boot; the registry's `aiMaxTier`) is the deployment's price ceiling per
call: the effective tier of every generation and decision call is the lower of the cap and the tier it resolved to
(`capModelTier`, order `fast` < `balanced` < `flagship`). It is one cap for every capability, not a
split by interactive and background work: the space's per-capability tiers already express that
split, the budget windows already separate background spend (`AI_AGENT_*`), and a second var would
only be a second place to forget. It applies to every source of a tier alike: a request's own
`tier`, the space's setting, and the call site's default, including the `flagship` defaults of page
layouts and Coworker (a cap with exceptions isn't a ceiling; layouts on `balanced` are still
validated against their schema and fall back as before). It is applied in `policy.tier` and in the
non-policy branches of `generateJson` and `decide`, so a result's provenance names the tier that
answered, and once more at the budget wrappers (`generateWithBudget`, `decideWithBudget`) for a
call site that names its tier outright. Embeddings have no tier, so the cap doesn't reach them.

A space's tier above the cap is **accepted and kept**, not refused: a cap lowered after a space chose
its tiers would otherwise refuse every later save of the settings until each tier was lowered by
hand, and the choice comes back if the cap is raised. `GET`/`PUT …/ai-settings` and the MCP tools
report `maxTier` and, per capability, `effectiveTier` (the tier held to the cap; null when the tier
is the call site's default). The admin's tier select disables the tiers above the cap and says
"Capped at Balanced by this deployment"; a row set above it says what it runs on.

**Guidance** is plain text, at most `AI_GUIDANCE_MAX_CHARS` (2 000) characters after line endings
are normalized and the ends trimmed. It is written by a space administrator but runs in other
people's requests, so it is treated as untrusted: `guidanceForModel` (`ai-prompt.ts`) appends it
after the built-in system prompt inside `<space_guidance>` tags, strips every delimiter tag
(`space_guidance` and `user_content`, nested spellings too), caps it, and tells the model it may
shape tone, style, terminology and emphasis only, never the task, the answer's schema, the tools or
the rules above it. Output schemas and tool lists are set by code, so no wording can widen them.
Classifiers and decision models (moderation, `ai.classify`, `ai.router`, `ai.assess`, tag picking,
promotion review) take no guidance; neither does search, which has no prompt.

**Storage.** One row per space in `space_ai_settings` (0043), a JSON document rewritten whole at
each set; `version` is the compare-and-set (`expectedVersion` on `PUT`, 409 naming the version in
force when stale or beaten). A space with no row reads as every capability on, at its call sites'
tiers, with no guidance. The settings are the space's, not an environment's: they govern what may be
asked of the models, so a branch or a promotion never carries them. Every AI call reads the row once
by primary key before it calls the model (an asset ingest reads it once per AI step, layout
generation once more per image search); nothing is written on that path. A set's audit row names the parts it changed
(`translation.tier`, `drafting.guidance`), never the guidance text.

**Surfaces.** `GET /spaces/:space/ai-settings` (`preview:read`, so the admin can hide what is off
from every editor) and `PUT` (`space:admin`); MCP `ai_settings_get` and `ai_settings_set`; the
management SDK's `aiSettings.get()` and `aiSettings.set()`. A personal access token or OAuth token
holding `space:admin` may set them: they are configuration and give nobody access that outlives the
token. They are not among Coworker's tools.

### Budget and untrusted content

Every interactive AI call goes through `generateWithBudget` (`packages/application/src/ai-budget.ts`),
so the HTTP API, MCP and agents are metered the same way. It consults the per-space `CostGuardDO`
before the call (`consume`: a request against `AI_MAX_REQUESTS_PER_WINDOW`, default 60, and
`AI_MAX_TOKENS_PER_WINDOW`, default 200 000, per `AI_BUDGET_WINDOW_SECONDS`, default 60), throws a
`RateLimitedError` (HTTP 429, with a retry-after hint) when the space is over a ceiling, then
`settle`s the observed tokens. Setting either ceiling to `0` turns metering off, and without the
binding nothing is metered. Background agent spend has its own `AI_AGENT_*` window (see
[Agent schedules](#agent-schedules)); the Coworker meters each model step against the interactive
budget. `AI_MODE=mock` skips the model and the budget. See [Configuration](./configuration.md).

Entry field values are untrusted: any writer, or an agent, can set them, yet they flow into
prompts. Prompt builders wrap them with `wrapUntrusted` (a `<user_content>` span; a closing tag in
the content is stripped) and add `UNTRUSTED_CONTENT_GUARD` to the system prompt, telling the model
to treat that span only as data (`packages/application/src/ai-prompt.ts`). The assistant wraps
tool results the same way. It blunts instruction hijacks, notably a moderation classifier being
talked into `flagged: false`; moderation additionally fails closed (see [moderate](#moderate)).

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
  **scalar** fields (`Symbol`, `Text`, `Integer`, `Number`, `Boolean`, `Date`:
  `draftableFieldSchema` in the domain) and its **top-level blocks fields** (`blocksFieldSchema`,
  below), asks the provider for structured output, then **validates the result against the
  content model** with the same `validateEntryFields` path as human writes, and its blocks against
  the block config as a create's are (`assertBlockConfigAllows`). Fields it doesn't fill (rich
  text, links, slugs, locations) aren't judged required (`ValidationContext.unfilled`): a draft is
  a proposal, and the save that follows judges them. A draft with a blocks field gets
  `LAYOUT_MAX_TOKENS` (8192) instead of 4096. Each property's
  `description` is `describeFieldForModel(field)`: the name, then the field's guidance as one
  capped line, labelled as describing the field and wrapped in `<user_content>` (delimiter tags in
  it, spaced or nested, are stripped until none is left: `stripDelimiters`; the system prompt
  carries `UNTRUSTED_CONTENT_GUARD`). Its validations become JSON Schema constraints (`in` as an
  `enum` of option values). Its conditional `rules` are named in words inside the same delimited
  span (`describeFieldRules`), since a rule quotes author values. Autofill, the `ai.enrich` node and
  the agent runtime describe fields the same way.
- Values for fields the draft's own values hide or disable are left out of the result
  (`withoutClosedFields`, settled to a fixed point), so a draft never fills a field nobody sees or
  one that is read-only. Autofill refuses such a field; `ai.enrich`, translation and the agent
  runtime skip them.
- Generated values are wrapped in the space's default locale.
- Returns `{ contentTypeApiId, fields, unresolvedImages, issues, usage }`. Pair it with `createEntry` to
  actually author. `canvasToEntry` is the same with prose as the source, delimited as data.

### Layout-aware generation

`generateBlocks(ctx, ai, scope, input, options)` (`packages/application/src/layout-generation.ts`)
composes blocks for one place: an entry's blocks field (`entryId`), a slot of one of its blocks
(`parent: { key, slot }`), or a new entry's field (`contentTypeApiId`). REST
`POST …/entries/blocks/generate`, MCP `entry_blocks_generate` (audited, not `readOnlyHint`: it
spends a flagship call), SDK `entries.generateBlocks`; gated like the patch
(`authorizeBlockGeneration`).

- **The schema** (`blocksSchemaFor`, `packages/domain/src/content-type/blocks-schema.ts`): one
  variant per block the place takes once the block config is laid over the catalog
  (`effectiveBlockRules`; the content model's variants when no catalog targets the type), each an
  object with `_type` as a `const`, its scalar fields, and its slots recursing with their own
  allowed children down to `MAX_BLOCK_DEPTH` (6). The schema is written fully inline, a repeated
  shape included, while it stays within `INLINE_SCHEMA_BUDGET` (32,000 characters of JSON): whether
  Workers AI's guided decoding follows a local `$ref` is unconfirmed. Only past the budget (a wide
  six-deep catalog, whose paths multiply with depth) is a shape that occurs more than once written
  once under the schema's `$defs` and referenced with `$ref`, so the schema grows with the distinct
  shapes instead. A name holds only `[A-Za-z0-9_]`: the field's apiId after its length, the
  block's, and a count for its second shape (`f4_body__card`, `f4_body__card__2`). A draft lifts
  each blocks field's `$defs` to its own root, and `conforms` and the `AI_MODE=mock` sampler follow
  the references. A
  slot is located by the steps down to it from
  the outline (each ancestor's `_type` and slot), so a block that sits at two depths is judged
  where it is. `min` and `max` (the rules' and the field's `size`, less the blocks the place
  holds) become `minItems` and `maxItems`. No `_key`: the patch mints them. Block descriptions,
  field guidance and every name (type, field, block) are author text: delimited or stripped of
  delimiters and capped (`describeBlockForModel`, `describeFieldForModel`, `nameForModel`).
- **What isn't offered:** rich text, entry links, lists of links, plain components and
  repeaters, JSON and locations inside blocks, a slot the rules lock, and an image the field's
  MIME rule doesn't take (`acceptsImages`). A block that _requires_ one of them, or a required
  slot that offers nothing, is not offered at all, so every block in a schema can pass a save.
- **Images:** a block's single `Link` to an `Asset` that takes images is asked for as
  `{ "$asset": { "query": "a lighthouse at dusk" } }`, only for a caller that may read the
  library (`assets:read`, which `preview:read` implies: `imageSearchFor`); without it no image is asked for, and a block whose
  image is required isn't offered. Requests are found by walking the answer with the content
  model (`assetRequestSites`); at most 20 lookups (`MAX_IMAGE_REQUESTS`, one cap for a whole
  draft), four at a time, within the call's remaining time. Each runs `searchAssets` with
  `kind: image` and takes the first hit the field's MIME rule allows; a request with none leaves
  the field out and is listed in `unresolvedImages` by path.
- **A required image unresolved** doesn't refuse the answer: it comes back with
  `required: true` in `unresolvedImages`, an `image_required` issue at its path, and
  `ready: false`. Choose an image (`assets_search`) and set it in that op's block before patching.
- **Locks, before the model:** a place the rules lock, one that is full, or one inside a locked
  region (a probe insert judged by `blockConfigIssues` for `slot_locked`, `region_locked`,
  `region_frozen`) is refused with `422` and no model call.
- **The call:** `flagship` tier by default, `LAYOUT_MAX_TOKENS`, through `generateWithBudget`
  (budget, `AI_MODE=mock`) with its cap inside the budget wrapper: `max(AI_TIMEOUT_MS, 60 s)`.
  Past it, the space is charged `maxTokens` (an abandoned call settles nothing, and may still
  bill) and the call fails with `AiUnavailableError`, HTTP `503 ai_unavailable`, retryable. An
  answer that doesn't `conforms` to the schema (`anyOf`, `oneOf` and `const` included) is a
  `422 bad_generation`.
- **Judged as the patch:** the blocks become one `insert` op each, at the end of the place, and
  go through `checkEntryBlocks` (for a new entry, a create's `validateEntry`). An issue in the
  field refuses the answer (`422`); issues elsewhere in the entry (a new entry's other required
  fields; fields the caller can't read only counted) come back in `issues`. Since a save stops at
  its first refusal, whenever issues elsewhere are kept the block config (`blockConfigIssues`)
  and the asset MIME rules (`assertAssetMimeTypes`) judge the generated field too, and refuse it
  as they would a save.
- Returns `{ contentTypeApiId, entryId, expectedVersion, locale, ready, ops, fields,
  unresolvedImages, issues, usage }`; `ready` is true when the ops (or the new entry's field)
  save as they are. Nothing is saved. Each call records an agent run (`workflow: 'generate'`),
  `completed`, or `failed` with its usage when the answer is refused after the call.

Drafts and Canvas share the schema, the image lookup and the timeout: a draft with a blocks field
is held to the same cap and `LAYOUT_MAX_TOKENS`. Each answered field is checked against the
schema it was sent (`conforms`): a key the schema didn't ask for is dropped, and a value outside
it (a block naming an asset id instead of asking for an image) refuses the draft. Blocks are
held to the block config and asset MIME rules as a create's are, a required image unresolved
comes back as an `image_required` issue in the draft's `issues`, and a refused draft is a
`failed` run.

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

The `VectorStore` is the vector index (`@contentworker/adapters/vector-vectorize`, bound via
`VECTORIZE`; 768 dimensions, cosine, metadata-indexed on `spaceId` and `environmentId`). The index
applies mutations asynchronously, so search-after-publish lags by a few seconds, and caps a query
at 50 matches (`MAX_TOP_K`, honored by the over-fetch). Without a `VECTORIZE` binding, or with
`VECTOR_STORE=memory`, the worker uses a per-isolate, non-durable in-memory vector store. The local
stack sets `VECTOR_STORE=kv` instead: vectors live in `KV_CACHE`, which every worker in the dev
session shares, so what the engine embeds the api can search (brute-force cosine; dev scale only).
The fail-closed adapter guard refuses both on a persistent deployment unless `ALLOW_FAKE_ADAPTERS`
includes `vectors`.

**Hybrid search** (`hybridSearch(deps, ctx, scope, query, { topK = 10 })`) fuses two legs with
Reciprocal Rank Fusion (`score = Σ 1/(60 + rank)`; rank-based, so the legs' incomparable
scores never need calibrating):

- **Semantic**: `semanticSearch` above.
- **Lexical**: the `SearchIndex` port, implemented by `SearchShardDO`
  (`packages/platform/src/do/search-shard.ts`): FTS5 in stateful edge objects, `SEARCH_SHARDS`
  (default 8) objects per space:environment, keyed `${spaceId}:${environmentId}:${n}`. An entry
  lives on the shard its id hashes to; a query asks every shard for its best `topK` and merges. The
  tokenizer folds accents (`unicode61 remove_diacritics 2`) with 2- and 3-character prefix indexes;
  a `versions` table makes indexing idempotent and order-independent. BM25 is per shard, which RRF
  tolerates. The events consumer keeps the shards fresh on publish and unpublish, and reindex slices
  refresh them in bulk. Keeping FTS out of the database keeps search writes off its single writer
  (and a database holding a virtual table cannot be exported). If a shard query fails, or no
  `SEARCH` binding exists, the leg falls back to `EntryRepo.searchPublished`, a bounded
  term-prefiltered scan of the published read model. The in-memory test-kit store mirrors the
  semantics so hybrid search is testable.

Lexical-only hits derive their snippet from the published fields. Exposed at
`GET /delivery/:space/:env/search` (hybrid by default; `?mode=semantic` / `?mode=lexical`
selects one leg), the GraphQL `search` resolver, and the `content_search` MCP tool.

## Asset search

Assets are searched apart from entries (`packages/application/src/asset-search.ts`), in two corpora
(`AssetSearchCorpus`): the library, every asset as it is now, and the published assets, their
published snapshots. Ingest writes one vector per asset and corpus into a vector-index namespace of
the corpus's own (`VectorStore.upsertAsset`, metadata `kind: 'asset'`, `spaceId`, `environmentId`,
`assetId`) and one document into that corpus's shards of `SearchShardDO` (`space:env:assets:<n>`,
`RagDeps.assetSearchIndex`; `space:env:pubassets:<n>`, `RagDeps.publishedAssetSearchIndex`), so
`semanticSearch`, `relatedEntries` and RAG answers never return an asset or its text, and Delivery's
candidates are published assets only. The indexed text is the file name, title, description, alt
text, tag names and an excerpt of the text ingest extracted from the snapshot's own file version
(1,500 characters embedded, 100,000 indexed). The published corpus is written on `asset.published`
and by ingest of a published asset, and emptied for the asset on `asset.unpublished`. Embedding
(documents and queries) happens only with `EMBEDDINGS_PROVIDER` set, decided once in `wireEdge`
(`EdgeWired.assetSearch`).

`searchAssets` (Management `GET …/assets/search`, scope `assets:read`) and
`searchDeliveredAssets` (Delivery `GET …/assets?q=`) take `q` (1–256 characters), `limit`
(default 20, at most 100) and the filters `kind`, `tag`, `folder` and, for the library, `status`.
Each leg contributes up to 100 candidates, fused by RRF; the response is `{ items, total,
facets }`, with `facets.kind`, `facets.tag` and `facets.folder` each counted under every filter
but its own. Delivery returns published assets only, in the delivered shape, and needs
`search:read` as well as `delivery:read`; a key with content grants gets an empty result. MCP's
`assets_search` runs either (`delivered: true` for Delivery's, with the same scopes). Without a
bound index the lexical leg scans the 500 most recent assets.

Extracted text and model output are untrusted. Text from a file is only stored, embedded and
indexed; it never reaches a generation prompt (alt text and tags are generated from the file name,
title and description, each wrapped with `wrapUntrusted` under `UNTRUSTED_CONTENT_GUARD`). Text
extraction is a model call metered by the space's AI budget (`runWithBudget`). What a model returns is written only where the field is empty, through
`applyAssetMetadata`, as one line of at most 300 characters, and tags only from the space's
existing vocabulary: ingest never creates a tag.

## MCP server

The api worker serves MCP at `/mcp`, with 248 tools and published agent skills. Transport, auth,
connecting a client, the tool catalog and skills are in [MCP server](./mcp.md). The assistant in the
admin calls the same tools in-process (see [Coworker](#coworker-the-admins-assistant)).

## Coworker: the admin's assistant

`AssistantAgent` (`packages/http/src/assistant/agent.ts`) is the chat panel in the admin, one
stateful edge object per person hosted by the engine (binding `ASSISTANT_AGENT`, reached at
`/agents/assistant-agent/<person>` through the web worker and the api). It is built on
`AIChatAgent`, so the conversation lives in the object's SQLite and a reply keeps streaming if the
tab goes away. User-facing behaviour is in the
[Coworker guide](https://docs.contentworker.app/guides/coworker/).

- **Model.** `assistantModel` (`model.ts`) uses edge inference's `flagship` tier (through the AI
  gateway when `AI_GATEWAY_ID` is set), falls back to `fast`, and behind both sits a deterministic
  mock that speaks the same tool protocol. The mock answers every turn when `AI_MODE=mock` or the
  `AI` binding is absent, and takes over a turn when the models error or say nothing within 20 s.
  Gateway requests carry `NO_LOG_PAYLOAD`, so the gateway keeps no prompt or answer.
- **Tools are MCP tools, run in-process as the person** (`tools.ts`): each call is a JSON-RPC
  request to the handler `/mcp` serves, authenticated as the person's own principal and pinned to
  the page's space and environment, so the assistant can never do what an MCP client with their
  access couldn't. Only the tools named in `ASSISTANT_TOOLS` (`packages/domain/src/assistant`) are
  offered. Reads run directly, and every write a model proposes waits for the person's confirm
  (`needsApproval`). A page edit made through `act` confirms only actions (publish,
  unpublish, trash, purge, restore a version, bulk change, schedule, publish a release), which stop
  at a confirm card; plain edits (save a draft, create, tag, comment) run at once. A confirm on `entries_publish`, `entries_unpublish` or
  `entries_restore_version` is held to the entry's version when the card was made, so a newer
  draft makes it a 409.
- **No space yet.** With no space, the panel (and setup's second step, `/setup/space`) sends
  `SETUP_SCOPE` (space and environment `*`). Only a deployment admin's turn runs there, as their
  deployment-wide principal, with `SETUP_TOOLS` (`space_starters_list`, `space_create`) and a
  system prompt that asks what the space is for and proposes one `space_create`. `offeredIn` holds
  every call to its scope: setup tools never run in a space, and a space's tools never run in setup.
  The AI budget meters setup turns under the `*` scope.
- **Page edits skip the model.** `act` runs the exact tool call for what was pressed and joins the
  conversation as a tool call of its own (`direct_` ids); `resolve` answers its confirm card.
- **Filling a slot.** The canvas's Ask Coworker to fill this sends one message whose entry page
  carries `fill` (`AssistantFill`, `packages/domain/src/assistant/fill.ts`): the field, locale and
  place, the block types the slot takes there (narrowed by the block config) with their text
  fields, its bounds and the names of the blocks around it. `readAssistantFill` cuts it to
  `FILL_LIMITS`; the system prompt quotes it with `wrapUntrusted` and asks for one
  `entry_blocks_patch` that only inserts there. Every model call of the turn is recorded with the
  fill turn (`fillTurnOf`: the entry and the fill), and its run is refused with `fillRefusal`'s
  words when it goes outside: a patch of that entry whose every step keeps to the slot
  (`outsideFill`: inserts only, of the types offered, holding only text in their listed fields, at
  the place) runs, and any other write (another tool, another entry) never does, whatever a client
  shows or answers. The turn's message metadata carries the same fill turn, and the card says the
  same refusal before any dry run, Confirm off; the dry run then holds an allowed patch to the
  block config and the entry's locks.
  The ask's own words (the person's message, unquoted) name the slot by schema names only. The mock
  answers `Fill …` with an outline, then one block of the first type at the place (`mockFill`).
- **Trust.** The object verifies the principal the web worker signed for its path (the
  `ASSISTANT_PRINCIPAL_KEY`, see [Auth & RBAC](./auth-and-rbac.md)), re-checks the person (enabled,
  session live) on every frame, turn and `act`, and runs only tool calls it made itself (`model:`
  records) or `act` made (`direct:`). Tool results and page labels are wrapped with `wrapUntrusted`.
- **Limits.** At most 30 page edits and turns per person per minute (`ASSISTANT_RATE`); each model
  step is one request against the space's interactive AI budget, a refused step aborts the turn,
  and mock steps are not metered. A conversation untouched for 30 days is deleted
  (`RETENTION_MS`); an unanswered confirm card lapses after a day.

## Agent runtime

`packages/agent-runtime` runs durable agent **workflows** behind an engine-agnostic facade.
Editorial workflow definitions (the graphs authored in the admin) run on a different path: the
graph interpreter `runGraph` in the same package, hosted by `EditorialWorkflow`; see
[Architecture](./architecture.md#editorial-workflow-runs).

```ts
type WorkflowName = 'enrich' | 'moderate' | 'curate' | 'repurpose' | 'review';
interface AgentRuntime {
  run(workflow, input): Promise<AgentRunResult>;
}
```

On-publish hooks (`AGENTS_ENRICH`, `AGENTS_MODERATE`) run `enrich` then `moderate`. `curate` and
`repurpose` are available for on-demand orchestration (API, MCP, and agent schedules). `review` is
the detached watcher that waits for a human decision (see
[Human-in-the-loop reviews](#human-in-the-loop-reviews)); it is not recorded in the agent ledger.

`AGENT_RUNTIME=cloudflare-workflows` (with the `AGENT_WF` workflow binding) routes on-publish and
scheduled agent runs through `CloudflareWorkflowsAgentRuntime` (`packages/platform/src/workflows.ts`),
which starts instances of the durable `AgentWorkflow` (`apps/engine/src/workflows/agent-workflow.ts`). When
`AGENTS_QUEUE` is bound, the events consumer forwards each `entry.published` to the
`contentworker-agents` queue; that consumer starts one workflow instance per chunk of up to 25
entries and acks without waiting on the result. Otherwise, and whenever the binding is absent,
agents run on `InProcessAgentRuntime` (non-durable).

The crucial seam is `Activities` — the side-effecting operations (`loadEntry`, `generateFields`,
`applyFields`, `classify`, `record`, `createReview`, `armReview`, `recordRun`, `retractEntry`,
`settleReview`). Workflow functions are **pure orchestration** over
`Activities`, so the _same_ workflow code runs:

- **`InProcessAgentRuntime`** — directly in the calling isolate (dev, tests, and every
  synchronous on-demand action from the API or MCP, which need the result in the response). Not
  durable (no crash replay).
- **Durable workflows** (production) — `AgentWorkflow` hosts `enrich`/`moderate`/`curate`/
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
2. `classify` the concatenated text. With a decision model (`ctx.decisions`, always bound on the
   platform) it asks the same per-category questions as the `ai.moderate` node (`moderation.ts`),
   with the text as the state, capped at 20,000 characters. A category at or above 0.5 flags, and
   a question left unanswered counts as flagged. Without one, it asks the `fast` generative model
   for a strict `{ flagged, categories }` schema, where only an explicit `flagged: false` passes
   and anything else holds the entry as `unclassified`.
3. If flagged → `record` a hold → `held`; else → `completed`. A failed call throws, so the
   workflow step retries; content is never waved through.

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
  status: 'completed' | 'needs_review' | 'held' | 'skipped' | 'rejected';
  decisions: string[]; // audit trail
  usage: { inputTokens: number; outputTokens: number };
  proposed?: EntryFields; // present when needs_review
  reviewId?: string; // the persisted review awaiting a decision (when needs_review)
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
  A key whose role grants only some content types sees only the reviews of entries it may read,
  with denied fields masked out of `proposed`. `GET …/approvals/count` counts what waits
  (pending reviews and workflow tasks) without listing it.
- MCP: `agent_review_list`, `agent_review_approve`, `agent_review_reject`, `approvals_count`.

Approval applies the proposed values as a new draft version through the normal update
use-case (validated, versioned) — **exactly once**, guarded by a CAS apply marker.

On durable runtimes the decision travels as a real signal: after a `needs_review` outcome
the runtime arms a detached **review-watcher workflow** (instance id `review-<reviewId>`)
that parks — for up to 7 days — until the decision arrives as a **durable workflow event**
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
durable workflows) and is recorded in the agent ledger. `autoApply` is
per-schedule: off routes proposals to human review.

**Budget.** Scheduled runs are background spend. They count under a separate `agent:` counter
window on the per-space `CostGuardDO`, so batch spend can't exhaust the interactive budget; that
window enforces the `AI_AGENT_*` ceilings when set and the interactive `AI_*` ceilings otherwise.
Durable `AgentWorkflow` runs are metered the same way. See [Configuration](./configuration.md).

**Host.** The engine worker runs due schedules on its 1-minute cron tick when
`AGENTS_SCHEDULES=true`.

**Surfaces.** CRUD on both, backed by the same use-cases: the Management API
(`GET`/`POST …/agent-schedules`, `PATCH`/`DELETE …/agent-schedules/:id` — listing needs
`preview:read`, mutations `content:publish`; see the
[API reference](./api-reference.md#agent-schedules)) and the MCP tools
`agent_schedule_create` / `agent_schedule_list` / `agent_schedule_update` /
`agent_schedule_delete`.
