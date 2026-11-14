# AI projects

Status: **decided** 2026-11-11, **backend built** (M5, "AI projects" in `ROADMAP.md`), **admin
shipped** 2026-11-12 (#281), ahead of the evaluation by the owner's call. The owner took all ten proposals under Decisions, added re-extraction (11), and the same day approved the
security and AI reviews' changes: pinned references, the default held to `space:admin`, a
narrower re-extraction gate, agents, reads at `content:write`, budgets and fencing by context
window, translation without references, and an evaluation gate (amendments dated under
Decisions). The evaluation (see Evaluation) is still to run on a dev deployment.
This file sits in `docs/specs/`, which the docs embed does not read (it takes `docs/*.md` only),
so MCP clients never mistake it for a description of shipped behaviour.

## What it is

An AI project is a named, reusable context for AI work: instructions, a writer persona (who is
writing, in what voice), a reader persona (who it is for), and reference assets (a brand guide, a
product sheet, a recorded interview) whose extracted text the model may consult. Someone picks a
project when they generate an entry, compose blocks on the canvas, talk to Coworker, or set up an
agent, and every model call in that work carries it.

It answers "everything we write for the Northwind launch sounds like Northwind, speaks to
procurement leads and gets the product facts from the spec sheet" without pasting the same brief
into every Generate dialog. Space guidance (#265) can't say that: it is one text per capability for
the whole space, and it has no audience, no voice and no files.

## What is already in place

- **AI settings per capability** (`packages/domain/src/ai/ai-settings.ts`,
  `packages/application/src/ai-settings.ts`): one versioned document per space
  (`space_ai_settings`, compare-and-set on `version`), nine capabilities (`drafting`, `layout`,
  `assistant`, `field-assist`, `translation`, `media`, `search`, `agents`, `workflows`), each with
  `enabled`, `tier` and up to 2,000 characters of `guidance`. Every AI use-case asks
  `requireAiCapability` (or `aiCapability`, in the background) first and builds its prompt with
  `policy.system(base)` and its tier with `policy.tier(default, requested)`. Reading takes
  `preview:read`, setting `space:admin`; the audit row names what changed, never the text.
- **Guidance fencing** (`ai-prompt.ts` `guidanceForModel`): the guidance goes after the built-in
  system prompt inside `<space_guidance>`, every delimiter tag (its own and `<user_content>`)
  stripped in a loop, capped, with the rule that it may shape tone, style, register, terminology,
  length and emphasis, never the task, the output schema, the tools or the rules above. Content
  goes in the user turn through `wrapUntrusted` (`<user_content>`), paired with
  `UNTRUSTED_CONTENT_GUARD`; names through `nameForModel`.
- **The tier cap** (#272): `capModelTier` holds every call to `AI_MAX_TIER`, both in the policy and
  again in `generateWithBudget`, the one choke point.
- **Budgets** (`ai-budget.ts`): `generateWithBudget`, `decideWithBudget` and `runWithBudget` consult
  `ctx.costGuard` (`CostGuardDO`) per space before the call and settle the tokens after; defaults
  60 requests and 200,000 tokens per 60 s window (`AI_MAX_*_PER_WINDOW`), and a separate window for
  background agents when `AI_AGENT_*` is set. A timeout settles `maxTokens`. Text extraction
  settles an estimate (the text's length / 4), not what the model used.
- **The model calls** a project would reach. All are one structured call except Coworker:
  `draftEntry` and `canvasToEntry` (`generation.ts`, `drafting`), `generateBlocks`
  (`layout-generation.ts`, `layout`, flagship, the canvas's compose and Coworker's
  `entry_blocks_generate`), `translateEntry`, `summarizeEntry`, `autofillField` (`content-ai.ts`),
  `runAIAction` (`ai-actions.ts`, `field-assist`, a stored `promptTemplate` and `tier` per
  environment), `auditEntry` (`agent-actions.ts`, `agents`), the agent workflows' enrich step
  (`agent-runtime/src/activities.ts`, `agents`), scheduled agents (`agent-schedules.ts`, per
  environment, run with no principal) and on-publish enrichment (a deployment flag,
  `AGENTS_ENRICH`, not a space setting). Change summaries (#273) are `field-assist` too. Calls are
  recorded as `AiCallRecord` (`ai-provenance.ts`: source, tier, prompt id, ms, tokens).
- **Tools.** The AI port takes `tools` (`GenerateRequest.tools`, `ports/src/infra.ts`), but only
  Coworker runs a tool loop: its tools are MCP tools on an allowlist (`ASSISTANT_TOOLS`,
  `http/src/assistant/tools.ts`), each result fenced by `forModel` (`wrapUntrusted`, cut at 24,000
  characters), writes behind the person's confirm, at most six steps a turn. Earlier turns keep
  only a tool result's `KEPT_OUTPUT` scalars.
- **Extracted text.** Ingest's `extract-text` step (`asset-ingest.ts` `extractText`) reads a
  document's or recording's text (Markdown conversion, transcription) into R2 beside the file at
  `assetTextKey` (`{space}/{env}/{asset}/v{version}/text.md`), never into D1 and never anywhere
  the media origin serves; at most 500,000 characters, files over 20 MB (10 MB audio) skipped,
  metered by the AI budget, and **only while `search` is on**, for the asset's current version.
  Each version's text stays until the asset is deleted. Search embeds the first 1,500 characters
  (`ASSET_EMBED_EXCERPT_CHARS`: one vector per asset, no passages) and indexes 100,000 lexically.
  No route or tool returns the text today. `reingestAsset` reruns ingest (`assetIngestInstanceId(…,
  { rerun })`) unless one is `pending` or `processing`.
- **Asset access.** `assets:read` and `assets:write` (#241), implied by `preview:read` and
  `content:write`; per environment. Attribute-based asset grants (#239, ROADMAP M4) are planned,
  with actions `read` and `download` (of the original) decided by one `assetAccess(principal,
  asset, action)`.

## Options considered

**A. More guidance.** Widen AI settings: several guidance texts per capability, and a file. Cheap,
but it is still one context for the whole space, and the person working can't choose.

**B. Per-request briefs.** Let every call take a free-text `context` and asset ids. Flexible, but
nothing is reusable, every surface grows its own fields, and reference access is checked once per
call site instead of in one place.

**C. Projects (chosen).** A stored, versioned record per environment, picked per request or
stored on an AI action or schedule, resolved by one use-case into a fenced prompt part and a
bounded set of reference excerpts. The rest of this spec describes C.

## The model

```ts
interface AiProject {
  readonly id: string; // ctx.ids.newId()
  readonly name: string; // 1–100 characters, unique in the environment (case-insensitive)
  readonly description: string | null; // ≤ 500, shown in pickers; never sent to a model
  /** What to do and avoid, terminology, facts to prefer. ≤ 4,000, normalized as guidance. */
  readonly instructions: string | null;
  readonly writer: AiPersona | null; // the voice the work is written in
  readonly reader: AiPersona | null; // the audience it is written for
  /** In order of importance. At most 10. */
  readonly references: readonly AiReference[];
  readonly isDefault: boolean; // at most one per environment
  readonly version: number; // compare-and-set, as AI settings
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
}

interface AiPersona {
  readonly name: string; // ≤ 100: "Northwind product team", "Procurement lead"
  /** Who they are, what they know and care about, how they speak or read. ≤ 1,000. */
  readonly description: string;
}

/** A reference pinned to one file version: a replaced file changes nothing until moved to. */
interface AiReference {
  readonly assetId: string;
  readonly version: number;
}
```

- **A persona is a name and a description**, nothing typed beyond that. Reading level, formality,
  locale and jargon tolerance are things people write in prose. One of each per project
  (decision 3).
- **Per environment** (decision 1), in a new `ai_projects` table keyed `(space_id,
  environment_id, id)`, like `ai_actions`, `agent_schedules` and the assets the references name;
  a partial unique index holds one `is_default = 1` per environment. Expand-only migration
  (`0045_ai_projects`, which also adds `ai_reference_extractions` and the two `project_id`
  columns), mirrored in `schema.ts`. References are a JSON column, checked on save in one
  `selectChunked` read (ten ids, well under the 100-parameter cap).
- **References are pinned** (amendment A). A reference names an asset and a file version, which
  must be a document or recording (`assetKind` `document` or `audio`) in the environment, not
  trashed (422 `reference_not_text`, naming the index). Adding one pins the asset's current
  version. A newer file shows the reference as `update available`; moving to it is a project
  update (`content:manage`, or `space:admin` on the default), audited like any other. So a
  replaced file can't change what every caller's prompt says without someone choosing it.
- **Text status**, derived on read from R2 and `ai_reference_extractions`, never from the project
  row: `ready`; `pending` (ingest or an extraction for the pinned version hasn't finished); or
  `none` with a reason: `too_large` or `unsupported` (final), `media_off`, `budget`, `failed`,
  or `not_extracted` (no text yet, nothing has asked for it; amendment C). Plus the flag
  `updateAvailable`.
- **Versioned by compare-and-set.** Each update sends `expectedVersion` (409 naming the version in
  force otherwise); setting what is in force again writes nothing. Setting the default clears the
  previous one in the same unit of work, so a lost race is a `TransactionConflictError` mapped to
  409.
- **Audit**: create, update, delete and default changes are audit events naming the parts changed
  (`instructions`, `writer`, `reader`, `references`, `isDefault`) and the references added,
  removed or moved (asset id, from and to version), never the text. Deleting the default is
  audited as a default change too.
- **Provenance** (amendment A): every call that took a project records the project's id and
  version and each reference's asset id, version and character ranges used, in the answer's
  `project.references[]`, in `recordAgentRun`, in `AiCallRecord` (`projectId`, `projectVersion`,
  `excerptChars`; never text), and in the AI Gateway request metadata.

## Enforcement

### Resolution

One use-case, `resolveAiProject(ctx, scope, caller, { capability, projectId, task })`, called
after the capability check and before the prompt is built, answers a `ProjectContext` with the
fenced system part, the reference excerpts and a report of what was used:

1. `projectId` given: that project (404 if it isn't in the scope). `null`: no project. Absent:
   the environment's default, if any. A stored `projectId` (an AI action's, a schedule's) that
   no longer resolves **refuses the run** (404, recorded on the run), never falls back to the
   default (amendment D).
2. The capability must take projects (decision 6): `drafting`, `layout`, `assistant`,
   `field-assist`, `translation` and `agents` do; `media`, `search`, `workflows`, moderation,
   change summaries and promotion reviews don't. An explicit `projectId` there is a 422.
   **Translation** takes the instructions (for terminology) and the reader persona only: no
   writer persona, which would rewrite the source's voice, and no references (amendment G).
3. References are filtered **as the caller may read them** (see Access) and read at their pinned
   version. Each one left out is reported with why (`forbidden`, `no_text`, `pending`, `gone`,
   `budget`), so the answer says what the model did and didn't see. The project is never dropped
   silently: an overflow trims references and reports `budget`, never the project's own text.

Disabled capability first, project second: a capability that is off still refuses with 409
`ai_capability_disabled`. Projects carry no tier (decision 7).

### Reference text extraction

Ingest reads a file's text only while `search` is on, so a reference uploaded while search was
off has none. Decided 2026-11-11 (decision 11), narrowed the same day (amendment C):

- **When.** Only when a call whose capability is on resolves the project and finds a readable
  reference with `none (not_extracted)` at its pinned version, that version is the asset's
  current one, and `reingestAsset`'s check finds no ingest `pending` or `processing`. Saving a
  project starts nothing. Never for `too_large` or `unsupported`, which no rerun changes. An old
  pinned version without text stays `none` and shows `update available`: extraction only reads
  the current file.
- **Where.** In the ingest Workflow, as a rerun (`assetIngestInstanceId(scope, assetId, version,
  { rerun })`, the rerun id naming the extraction) that runs the `extract-text` step alone: no
  hash, alt text, tags, embed or index. The call that found it goes on without the text and
  reports the reference `pending`; the request never extracts. It writes the same `assetTextKey`
  and keeps the step's rules: size caps, the 500,000-character cap, the current-version checks.
- **Who.** The trigger needs `assets:write` from the caller. A caller without it (an editor with
  only `content:write` on a narrowed key, a background run) starts it as an audited system
  action naming who, or what, triggered it.
- **The record.** `ai_reference_extractions` (`space_id`, `environment_id`, `asset_id`,
  `file_version`, `status` `pending` | `done` | `skipped`, `reason`, `triggered_by`,
  `updated_at`), one row per asset version. A redelivered start or retried step finds the row
  `done` (or the text in R2) and does nothing; a second call while it is `pending` starts
  nothing. Rows go with the asset's derived files.
- **`media` governs it.** Reading a file's text for a reference is asset AI work, which `media`
  covers ("alt text and tags for assets" gains "and reading the text of project references").
  With `media` off nothing starts, the row is `skipped` with `media_off`, and no text reaches any
  model. Turning `media` back on doesn't sweep; the next call that finds the reference (or
  **Retry**) starts it. With `search` on, ingest reads the text anyway, as now.
- **Real usage.** The step settles what the model used, not an estimate: the `toMarkdown`
  conversion's tokens and Whisper's audio minutes (converted to the guard's token unit), charged
  to the agent window when `AI_AGENT_*` is set. This applies to every extraction, ingest's too.
  A spent budget skips the step (`budget`).
- **Hygiene.** PDF conversion passes `conversionOptions.pdf.metadata: false`, and a `## Metadata`
  section is stripped from PDF text, so author and producer fields never reach a prompt.
- Text written for a reference also feeds search if search is turned on later, as any extracted
  text does.

### Ordering and fencing

```
system:  built-in prompt
         UNTRUSTED_CONTENT_GUARD (names every delimiter below)
         <ai_project>  instructions, writer persona, reader persona  </ai_project>
         <space_guidance>  the capability's guidance  </space_guidance>
user:    Reference 1: <title> (asset …, version n, characters a–b of m)
         <reference asset="…">  excerpt  </reference>
         … (references 4–10: title and length only)
         <user_content>  the entry's content, as now  </user_content>
         the task, last
```

- **Project text is fenced like space guidance**, in `<ai_project>`, by a `projectForModel`
  beside `guidanceForModel`: it may shape tone, style, register, terminology, length, emphasis
  and audience, and say which facts to prefer. The fence says plainly that the guarantees are the
  code's (JSON mode, `conforms` and the validators, the tool allowlist, the person's confirm), and
  that it is data: it may not change the task, the schema or the rules, and may not ask for any
  tool call. The wording is best-effort; the code is what holds.
- **Space guidance comes last and wins** (decision 8): set by `space:admin`, it is the space's
  policy; the fence says to follow it where the two disagree.
- **References are the least trusted text**: files anyone with `assets:write` uploaded. Each one
  is in its own `<reference asset="…">` span, wrapped separately; its header (title, id, version,
  range) sits outside the span, built with `nameForModel`. They never go in the system prompt, a
  schema or a tool description.
- **Delimiters**: `stripDelimiters` strips `user_content`, `space_guidance`, `ai_project` and
  `reference` tags in a loop, from every fenced text and from reference text, so none can close
  its span or pose as another.
- **Order in the user turn**: references first, the entry's content next, the task last, so the
  stable part is a prefix. Calls set `x-session-affinity` to a hash of the project id and version
  and the references' versions, so Workers AI's prefix caching can reuse it.
- **Caching**: any cache of a call that takes a project (change summaries' KV cache is the
  pattern) keys on a hash of the whole assembled prompt, never on ids, so an edited project or a
  moved reference can't serve an old answer.

### Token budgeting

References reach the model two ways (decision 4, amended F):

- **Inline excerpts, on every call that takes a project.** The budget per call is the smaller of
  12,000 characters and a share of the tier's spare context: the model's context window less the
  system prompt, the task, the entry's content and the call's `maxTokens`, estimated in tokens per
  script (Latin, CJK and others count differently). The adapter reports it:
  `AIProvider.limits(tier) → { contextTokens }`, from the model catalog's `context_window`,
  honouring the `WORKERS_AI_MODEL_*` overrides. Only the **first three references** are
  excerpted, weighted 50 / 30 / 20 (a share one can't use passes on); the rest are listed by
  title and length. A reference the budget can't reach is reported `budget`.
- **What an excerpt is.** About a quarter is the text's head; the rest is the top paragraphs by
  BM25 against the task's terms (the brief, the field names, the entry's title), kept in document
  order, from a ranged read of the first 100,000 characters. Transcripts with no paragraph breaks
  fall back to sentence boundaries. Deterministic, no extra model call.
- **Ranged reads.** `BlobStore` gains `getRange(key, offset, length)`; offsets are UTF-8 bytes,
  rounded to a character boundary on both ends. Ten references cost a few small reads, never the
  whole 500,000 characters.
- **`ai_project_reference_read`, for callers that loop.** Coworker gets it as a read-only tool
  (`projectId`, `assetId`, `offset`, `limit`: default 6,000 characters, at most 12,000), answering
  a page with `total` and `nextOffset`, fenced by `forModel`. At most 24,000 reference characters
  a turn, less on a small-context tier. `assetId`, `offset` and `nextOffset` join `KEPT_OUTPUT`,
  so a later turn can resume; earlier pages are kept as stubs, not text. Coworker's list of the
  project's references goes in the user turn, filtered to those the person may read, titles
  through `nameForModel`. MCP clients call the same tool themselves.

Everything a project adds is input tokens the call settles through `generateWithBudget`.

### Access

- **Reading projects takes `content:write`** (amendment E), the scope the AI calls take, so a
  Preview (`cpa`) or Delivery (`cda`) key can't list projects or read their references.
- **Reference text is read as the caller**: `assets:read` in the environment today; once asset
  grants land (#239), `assetAccess(caller, asset, 'download')`, since the text is the original's
  content. One the caller can't read is left out, reported `forbidden` by id only, never title.
- **Saving checks the saver's read** (amendment E): adding a reference needs the saver to be able
  to read that asset, and a denied asset answers the same 404 as a missing one. `download` is
  checked at use, every time, for whoever calls.
- **The default is `space:admin`'s** (amendment B): only `space:admin` sets or clears it, and only
  `space:admin` may update or delete the project that is the default (`content:manage` gets 403
  on its `PUT` and `DELETE`). It reaches everyone's calls, as space guidance does.
- **Background runs have no caller** (amendment D): scheduled agents, on-publish enrichment and
  an audit run by the system use a reference only if its pinned version is **published** and
  unrestricted (no grant or space deny rule names it, once asset grants land), since what they
  write is read by every entry reader. On-publish enrichment can only use the environment default.
- **Stored project ids** on AI actions and schedules must name a project in the same environment,
  checked on save (422) and again at run time (refused when gone).
- **The tool** answers 404 for a reference the caller can't read and for an asset that isn't one
  of the project's references, so it can't read arbitrary asset text.

## Surfaces

Both surfaces, as AGENTS.md requires, one use-case each in `packages/application/src/ai-projects.ts`:

| Operation            | REST (`/spaces/:space/environments/:env/…`)          | MCP                            | Takes                                    |
| -------------------- | ---------------------------------------------------- | ------------------------------ | ---------------------------------------- |
| List                 | `GET ai-projects`                                    | `ai_projects_list`             | `content:write`                          |
| Read                 | `GET ai-projects/{id}` (with reference status)       | `ai_project_get`               | `content:write`                          |
| Create               | `POST ai-projects`                                   | `ai_project_create`            | `content:manage`                         |
| Update               | `PUT ai-projects/{id}` (`expectedVersion`)           | `ai_project_update`            | `content:manage`; default: `space:admin` |
| Delete               | `DELETE ai-projects/{id}`                            | `ai_project_delete`            | `content:manage`; default: `space:admin` |
| Set or clear default | `PUT ai-projects/default` (`{ projectId }`, or null) | `ai_project_default_set`       | `space:admin`                            |
| Retry a text         | `POST ai-projects/{id}/references/{assetId}/extract` | `ai_project_reference_extract` | `content:write` (see Who)                |
| Read a reference     | `GET ai-projects/{id}/references/{assetId}/text`     | `ai_project_reference_read`    | `content:write` + asset read             |

- **Selection on the AI calls**: an optional `projectId` (string, or `null` for none) on
  `POST …/entries/generate`, `…/entries/canvas`, `…/entries/blocks/generate`, translate,
  summarize, autofill, `…/entries/{id}/audit` and `…/ai-actions/{id}/run`, and on the matching
  MCP tools (`generate_draft`, `entry_from_canvas`, `entry_blocks_generate`, `entry_audit`,
  `ai_action_run`, …). Each answer gains `project: { id, version, references: [{ assetId,
  version, used, ranges?, reason? }] } | null`.
- **Stored selection**: `projectId` on AI actions and agent schedules (nullable columns; null is
  the default at run time). On-publish enrichment uses the default.
- **Coworker**: the turn's context body gains `projectId`, checked each turn; `ai_projects_list`,
  `ai_project_get` and `ai_project_reference_read` join `ASSISTANT_TOOLS` as reads. Coworker can't
  create, change or delete a project, or retry an extraction.
- **SDK**: `cma.aiProjects.{list,get,create,update,delete,setDefault,readReference,extract}`, and
  `projectId` on the generation methods.
- **Deleting** a project an AI action or schedule names is refused, 409 `project_in_use` listing
  them (decision 5); deleting the default clears it in the same unit, audited.
- **Snapshots and clones** carry projects with their ids and pins (snapshots keep asset ids).
  **Space export** remaps references to the imported assets, pinned to the version imported, and
  drops any it couldn't import. **Promotions** don't carry them (decision 10).
- **Docs**: the AI guide on the docs site, the API reference from OpenAPI, the MCP tools page.
  No new vars.

## The admin

- **Settings → Automation → AI projects**, beside AI and AI actions: a list (name, default badge,
  reference count, updated by and when), and a project page with name, description, instructions,
  writer and reader, and references picked from the asset library (documents and recordings
  only). Each reference shows its pinned version, its text status, **Use the new file** when an
  update is available, **Retry** for `media_off`, `budget` and `failed`, and a link to the asset.
  Save, Discard and AI settings' stale-save handling. Read-only without `content:manage`, and on
  the default without `space:admin`. Settings, not Build: projects configure AI, like AI actions.
- **The picker says what happens**: adding a reference with no text says "This file will be read
  by a model the first time the project is used" (and "…but Media is off in Settings → AI" when
  it is).
- **Project pickers**: a select ("Default (Northwind launch)" first, then the others, then "None")
  in the Generate dialog, the canvas's compose, the AI assist panel, the AI action run dialog and
  the schedule form. Coworker's panel shows the project in its header, chosen per conversation.
- **What was used**: the result names the project and lists references left out and why ("2
  references weren't used: one you can't open, one is still being read").
- An e2e scan of the new page in `accessibility.spec.ts`.

## Evaluation

Amendment H: the rollout is gated on this.

- **A golden set in the repo**: two synthetic projects, one in a language other than English,
  each with planted facts and banned terms in its references and instructions, run against every
  capability that takes a project, on each tier's model, with and without the project. On a dev
  deployment only, never a production install.
- **Checks**: schema conformance and the heuristic fallback rate; planted-fact recall; banned-term
  violations; adversarial references (instructions planted in a file, delimiter forgery);
  project versus space guidance on conflict; overflow on `balanced`.
- **Production signal**, per `projectId` and never with content: whether a proposal was accepted
  unchanged, edited (a size bucket) or discarded.
- **Tests with the change**, beyond the usual: replace a referenced file and the old version's
  text is still what is read; a reference the caller can't download is reported, not used; a
  redelivered extraction start runs once; a stored `projectId` that is gone refuses the run;
  `content:manage` gets 403 on the default.

## Decisions

Made by the owner on 2026-11-11, each as proposed, with one addition (11). Amended the same day
from the security and AI reviews (A–H above):

1. **Scope: per environment.** Considered: per space, with references resolved in whichever
   environment the call runs in.
2. **Who: `content:manage` creates, edits and deletes; `space:admin` sets the default.**
   Amended 2026-11-11 (B): only `space:admin` updates or deletes the project that is the default;
   deleting it clears the default, audited. Considered: `content:manage` for the default too.
3. **Personas: one writer and one reader per project, each a name and a description.**
   Considered: a persona library per environment, referenced by id.
4. **References: inline excerpts for every call, plus `ai_project_reference_read` for Coworker
   and MCP clients.** Amended 2026-11-11 (A, F): references are pinned to a file version; the
   budget is the smaller of 12,000 characters and the tier's spare context; three references
   excerpted (head plus BM25 paragraphs), the rest listed; tool pages 6,000 by default, 12,000
   at most, 24,000 a turn. Considered: a model-written digest per reference.
5. **Delete while referenced: refused with 409 `project_in_use`.** Considered: allowing it, with
   those falling back to the default.
6. **Capabilities that take a project: `drafting`, `layout`, `assistant`, `field-assist`,
   `translation`.** Amended 2026-11-11 (D, G): `agents` too; translation takes instructions and
   the reader persona only. Considered: every guided capability.
7. **No tier on a project.** Considered: an optional project tier.
8. **Precedence: both apply; space guidance after the project, and it wins on conflict.**
   Considered: the project last and winning.
9. **Background runs use a reference only while it is unrestricted.** Amended 2026-11-11 (D):
   and only its published version; a stored project that is gone refuses the run, never falls
   back. Considered: no reference text in background runs.
10. **Promotions don't carry projects in this step**; snapshots, clones and space export do.
    Considered: projects as a promotable kind.
11. **A reference without text gets it read** (owner's addition), by the extraction step alone,
    writing the same `assetTextKey`, governed by `media`. Amended 2026-11-11 (C): only when a call
    with its capability on finds it, never on save, never for `too_large` or `unsupported`, not
    while ingest is pending; in the ingest Workflow as a rerun; `assets:write` or an audited
    system action; real usage settled. Considered for the gate: `search`.

## Open questions

- Does any install run with `AI_MAX_TIER=balanced`? If so, the context-window budget
  (F) is blocking for it: the balanced model's window is the one overflow tests target.
- What does Workers AI return when a prompt overflows the context window: an error, or a silent
  truncation? Check on a dev deployment with #268's checks before `limits(tier)` is trusted.

## Out of scope

- Embedding-ranked passages (a chunked vector index per reference), and references to entries
  rather than files.
- Tool loops in the structured use-cases (`draftEntry`, `generateBlocks`, agents): excerpts only.
- Text for images and video, and extracting an old pinned version's file.
- Projects in workflow AI nodes, the workflow copilot, alt text and tags, moderation and
  promotion reviews.
- Per-project budgets and project-level tiers.
- Delivery: projects and reference text are never returned by the Delivery or Preview APIs.
