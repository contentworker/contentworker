import {
  authorize,
  BLOCK_TYPE_KEY,
  blockVariants,
  ConflictError,
  type ContentType,
  type ContentTypeDraft,
  checkTemplateModel,
  DomainError,
  defineContentType,
  type FieldDefinition,
  type ImportScriptOutput,
  InvalidStateError,
  importScriptOutputIssues,
  MIGRATION_SOURCE_URL_FIELD,
  type MigrationArtifact,
  type MigrationPage,
  type MigrationRun,
  type MigrationScore,
  type MigrationTemplate,
  type MigrationTrySummary,
  NotFoundError,
  type Principal,
  SCOPES,
  type Scope,
  scoreImportOutput,
  stageForScore,
  ValidationError,
} from '@contentworker/domain';
import {
  type BlobStore,
  type ImportScriptContentType,
  type ImportScriptFieldSummary,
  type ImportScriptResult,
  type ImportScriptSandbox,
  TransactionConflictError,
} from '@contentworker/ports';
import { createContentType, publishContentType } from './content-types';
import type { AppContext } from './context';
import { jobStarterOf } from './job-starter';
import { migrationArtifactKey } from './site-migrations';
import { sha256Hex } from './token-crypto';

/**
 * Site migration, authoring a template: propose the content type its pages become, write its
 * import script, try the script on the sample pages, approve the template (which creates the
 * type), and transform the template's pages with the approved script.
 *
 * Everything but the approval is an author's or an agent's work and changes nothing outside the
 * run: a proposal is recorded on the template, a script is an artifact under the run, and a try
 * keeps only its summary. Only {@link approveTemplate} writes the space's model, as a person with
 * `content:manage`.
 *
 * Every template write rides with the run's version compare-and-set (`MigrationStore`), so two
 * writers can't interleave a run's templates. Each template's agent writes on its own, so a lost
 * race is expected: the write is read again and made over the newer run, a few times, then
 * reported as a `ConflictError`.
 *
 * Scripts run in the `ImportScriptSandbox` (an isolate each, no network, no bindings), at most
 * {@link SCRIPT_CONCURRENCY} at a time: Cloudflare allows a request four dynamic Workers in flight,
 * and a step or a tool call is one request.
 */

/** Pages one transform reads at most: one Workflow step's worth. */
export const MIGRATION_TRANSFORM_BATCH_MAX = 50;
const MIGRATION_TRANSFORM_BATCH_DEFAULT = 25;
/** The largest script a template keeps, as UTF-8 bytes: the sandbox's own limit. */
export const MIGRATION_SCRIPT_MAX_BYTES = 256 * 1024;
/** Sample pages one try runs at most. */
export const MIGRATION_TRY_MAX_PAGES = 5;
/** Wall-clock time one script run may take (the sandbox caps it, and CPU, lower still). */
const SCRIPT_TIMEOUT_MS = 10_000;
/** Script runs in flight at once, under the four dynamic Workers a request may hold. */
const SCRIPT_CONCURRENCY = 2;
/** A template write that loses the run's compare-and-set is made again this many times in all. */
const WRITE_ATTEMPTS = 4;
const MAX_ERROR_LENGTH = 500;
const MAX_TRY_PROBLEMS = 10;

export interface TemplateAuthoringDeps {
  readonly blob: BlobStore;
  readonly sandbox: ImportScriptSandbox;
}

export interface TemplateRef {
  readonly runId: string;
  readonly templateId: string;
}

// --- propose ----------------------------------------------------------------

export interface ProposeTemplateModelInput extends TemplateRef {
  readonly model: ContentTypeDraft;
}

/**
 * Records the content type a template's pages are proposed to become, checked as the type will
 * be created ({@link checkTemplateModel}: a `sourceUrl` field, one blocks field for the body, a
 * URL pattern), and moves the template to `authoring`, so clustering the run again can't discard
 * it. Nothing in the space's model changes until the template is approved.
 */
export async function proposeTemplateModel(
  ctx: AppContext,
  scope: Scope,
  input: ProposeTemplateModelInput,
): Promise<MigrationTemplate> {
  const model = checkTemplateModel(input.model, { previewLoopback: ctx.previewLoopback === true });
  return writeTemplate(ctx, scope, input, (template, at) => {
    assertAuthorable(template);
    return { ...template, proposal: model, status: 'authoring', updatedAt: at };
  });
}

// --- script -----------------------------------------------------------------

export interface SetImportScriptInput extends TemplateRef {
  /** The script: an ES module exporting `default` (or `transform`): `(page, ctx) => output`. */
  readonly script: string;
}

/**
 * Stores a new version of the template's import script as an artifact under the run
 * (content-addressed, so the same script is the same object) and moves the template to
 * `authoring`. The script isn't run here; {@link tryImportScript} runs it.
 */
export async function setImportScript(
  ctx: AppContext,
  deps: Pick<TemplateAuthoringDeps, 'blob'>,
  scope: Scope,
  input: SetImportScriptInput,
): Promise<MigrationTemplate> {
  const script = checkScript(input.script);
  // Checked before anything is written: an approved template's script is the one it loads by.
  assertAuthorable(await requireTemplate(ctx, scope, input.runId, input.templateId));
  const sha256 = sha256Hex(script);
  const key = migrationArtifactKey(scope, input.runId, 'script', sha256);
  await deps.blob.put(key, script, 'text/javascript; charset=utf-8');
  const artifact: MigrationArtifact = { key, sha256, bytes: utf8Bytes(script) };
  return writeTemplate(ctx, scope, input, (template, at) => {
    assertAuthorable(template);
    return { ...template, script: artifact, status: 'authoring', updatedAt: at };
  });
}

/** The template's current script, or null before one is written. */
export async function getImportScript(
  ctx: AppContext,
  deps: Pick<TemplateAuthoringDeps, 'blob'>,
  scope: Scope,
  ref: TemplateRef,
): Promise<string | null> {
  const template = await requireTemplate(ctx, scope, ref.runId, ref.templateId);
  return template.script ? readScript(deps.blob, template.script) : null;
}

// --- try --------------------------------------------------------------------

export interface TryImportScriptInput extends TemplateRef {
  /** A script to try in place of the stored one; it isn't stored. */
  readonly script?: string;
  /** Pages of the template to try it on, at most {@link MIGRATION_TRY_MAX_PAGES}; absent, its samples. */
  readonly pageIds?: readonly string[];
}

/** One page's try: the output (as the script returned it), its score, and what's wrong. */
export interface ImportScriptTry {
  readonly pageId: string;
  readonly url: string;
  /** The script ran and returned an output of the right shape for the content type. */
  readonly ok: boolean;
  readonly output?: ImportScriptOutput;
  readonly score?: MigrationScore;
  /** The output's shape and model problems; empty when it has none. */
  readonly issues: readonly string[];
  /** Why the script produced no output (it threw, timed out, didn't parse). */
  readonly error?: string;
  readonly logs: readonly string[];
}

export interface TryImportScriptResult {
  readonly results: readonly ImportScriptTry[];
  readonly summary: MigrationTrySummary;
}

/**
 * Runs the template's script (or `input.script`) on its sample pages, checks each output's shape
 * and its fit to the template's content type (the approved one, else the proposal), and scores it
 * against the page. Nothing is written but the try's summary on the template.
 */
export async function tryImportScript(
  ctx: AppContext,
  deps: TemplateAuthoringDeps,
  scope: Scope,
  input: TryImportScriptInput,
): Promise<TryImportScriptResult> {
  const run = await requireRun(ctx, scope, input.runId);
  const template = await requireTemplate(ctx, scope, run.id, input.templateId);
  const contentType = await templateModel(ctx, scope, template);
  const script =
    input.script !== undefined
      ? checkScript(input.script)
      : template.script
        ? await readScript(deps.blob, template.script)
        : null;
  if (script === null) throw new InvalidStateError('The template has no import script to try');
  const ids = input.pageIds?.length ? [...new Set(input.pageIds)] : template.samplePageIds;
  if (ids.length > MIGRATION_TRY_MAX_PAGES) {
    throw new ValidationError([
      { field: 'pageIds', message: `at most ${MIGRATION_TRY_MAX_PAGES} pages per try` },
    ]);
  }
  const pages: MigrationPage[] = [];
  for (const id of ids) {
    const page = await ctx.store.migrations.getPage(scope, run.id, id);
    if (!page || page.templateId !== template.id) {
      throw new NotFoundError('Migration page in this template', id);
    }
    pages.push(page);
  }
  const summaryOf = importScriptContentType(contentType);
  const results = await mapLimit(pages, SCRIPT_CONCURRENCY, async (page) => {
    const html = page.html ? await deps.blob.get(page.html.key) : null;
    if (html === null) {
      return {
        pageId: page.id,
        url: page.url,
        ok: false,
        issues: [],
        error: 'The page has no fetched HTML',
        logs: [],
      } satisfies ImportScriptTry;
    }
    const ran = await runScript(deps.sandbox, scope, script, page, html, summaryOf);
    const checked = checkOutput(ran, contentType);
    return {
      pageId: page.id,
      url: page.url,
      ok: checked.ok,
      ...(checked.output ? { output: checked.output } : {}),
      ...(checked.output && checked.ok ? { score: scoreImportOutput(html, checked.output) } : {}),
      issues: checked.issues,
      ...(checked.error ? { error: checked.error } : {}),
      logs: ran.logs,
    } satisfies ImportScriptTry;
  });
  const scored = results.flatMap((r) => (r.score ? [r.score.overall] : []));
  const at = ctx.clock.now().toISOString();
  const summary: MigrationTrySummary = {
    at,
    scriptSha256: sha256Hex(script),
    pages: results.length,
    ok: results.filter((r) => r.ok).length,
    passed: scored.filter((s) => s >= run.threshold).length,
    meanScore: scored.length ? round(scored.reduce((a, b) => a + b, 0) / scored.length) : 0,
    problems: results
      .flatMap((r) => [
        ...(r.error ? [`${r.url}: ${r.error}`] : []),
        ...r.issues.map((i) => `${r.url}: ${i}`),
        ...(r.score?.issues ?? []).map((i) => `${r.url}: ${i}`),
      ])
      .slice(0, MAX_TRY_PROBLEMS)
      .map((p) => clip(p, MAX_ERROR_LENGTH)),
  };
  // Its own column, outside the run's compare-and-set: a summary isn't something reviewed (it isn't
  // in the digest), and a busy agent trying again and again mustn't starve an approval's writes.
  await ctx.store.migrations.saveTemplateTry(scope, run.id, template.id, summary);
  return { results, summary };
}

// --- approve ----------------------------------------------------------------

export interface ApproveTemplateInput extends TemplateRef {
  /**
   * The {@link templateReviewDigest} of the template as the person reviewed it. The template's
   * agent may still be writing while someone reviews; an approval holds only for what they read.
   */
  readonly reviewed: string;
}

/**
 * What a person approves: the proposal and the script version, as one SHA-256. A try's summary
 * or a status change doesn't change it; a new proposal or script does.
 */
export function templateReviewDigest(template: MigrationTemplate): string {
  return sha256Hex(
    JSON.stringify({ proposal: template.proposal, script: template.script?.sha256 ?? null }),
  );
}

/**
 * Approves a template: creates its content type from the proposal (or revises the one of that
 * apiId the run's templates already hold), publishes it, and moves the template to `approved`
 * with `contentTypeId` and `approvedBy` (the approver, whom its pages are loaded as). Needs
 * `content:manage`, as any change to the model does; the type is saved as `principal`. Refused
 * (`ConflictError`) unless the template is still what `input.reviewed` says the person read.
 *
 * A type of the proposal's apiId that no template of the run holds is someone's own model, and is
 * refused rather than revised; the save is held to the type's version as read, so one created or
 * changed meanwhile is refused too.
 *
 * The approval holds the template while it writes the type: one write checks the digest again and
 * moves the template to `approving` with the apiId claimed, which refuses every authoring write
 * (a proposal or script committed after that can't slip under the approval), and the final write
 * approves it only while that claim is still the one this call made. A failed type save releases
 * the claim. A claim left by an approval that stopped part-way (a crash) can be taken over once it
 * is {@link APPROVAL_LEASE_MS} old, and a second call then finishes it.
 */
export async function approveTemplate(
  ctx: AppContext,
  principal: Principal,
  scope: Scope,
  input: ApproveTemplateInput,
): Promise<MigrationTemplate> {
  authorize(principal, SCOPES.contentManage, scope.spaceId);
  const approvedBy = jobStarterOf(principal);
  if (!approvedBy) {
    throw new InvalidStateError('This caller can’t be recorded as a template’s approver');
  }
  const ref = { runId: input.runId, templateId: input.templateId };
  const template = await requireTemplate(ctx, scope, ref.runId, ref.templateId);
  if (template.status === 'approved') return template;
  if (!template.proposal) throw new InvalidStateError('The template has no proposed model');
  if (!template.script) throw new InvalidStateError('The template has no import script');
  const stale = () =>
    new ConflictError(
      'The template’s model or script changed after it was reviewed: review it again',
    );
  if (templateReviewDigest(template) !== input.reviewed) throw stale();
  const proposal = template.proposal;
  const apiId = proposal.apiId;
  const existing = await ctx.store.contentTypes.get(scope, apiId);
  if (existing) {
    const held = (await ctx.store.migrations.listTemplates(scope, ref.runId)).some(
      (t) => t.contentTypeId === apiId,
    );
    if (!held) {
      throw new ConflictError(
        `A content type "${apiId}" already exists and isn't this migration's: propose another apiId`,
      );
    }
  }
  const before = template.contentTypeId;
  const claim = await writeTemplate(ctx, scope, ref, (current, at) => {
    if (current.status === 'approved') return current;
    if (templateReviewDigest(current) !== input.reviewed) throw stale();
    if (
      current.status === 'approving' &&
      Date.parse(at) - Date.parse(current.updatedAt) < APPROVAL_LEASE_MS
    ) {
      throw new ConflictError('The template is being approved; try again in a moment');
    }
    return { ...current, status: 'approving', contentTypeId: apiId, updatedAt: at };
  });
  if (claim.status === 'approved') return claim;
  const ours = (current: MigrationTemplate) =>
    current.status === 'approving' && current.updatedAt === claim.updatedAt;
  try {
    await createContentType(ctx, principal, scope, proposal, {
      expectedVersion: existing?.version ?? 0,
    });
    await publishContentType(ctx, scope, apiId);
  } catch (err) {
    // Released, so the template can be authored and approved again; the apiId goes back to what
    // it was, so a type this call never wrote isn't left looking like the run's.
    await writeTemplate(ctx, scope, ref, (current, at) =>
      ours(current)
        ? { ...current, status: 'authoring', contentTypeId: before, updatedAt: at }
        : current,
    ).catch(() => undefined);
    throw err;
  }
  return writeTemplate(ctx, scope, ref, (current, at) => {
    if (!ours(current)) {
      throw new ConflictError('The template’s approval was taken over: review it again');
    }
    return { ...current, status: 'approved', contentTypeId: apiId, approvedBy, updatedAt: at };
  });
}

/** How long an approval holds its template before another may take it over. */
export const APPROVAL_LEASE_MS = 5 * 60_000;

// --- transform --------------------------------------------------------------

export interface TransformTemplatePagesInput extends TemplateRef {
  /** Pages this call reads, at most {@link MIGRATION_TRANSFORM_BATCH_MAX}. */
  readonly batchSize?: number;
  /** The `next` of the call before: where this one goes on from. */
  readonly after?: string;
}

export interface MigrationTransformFailure {
  readonly pageId: string;
  readonly url: string;
  readonly error: string;
}

export interface TransformTemplatePagesResult {
  /** Pages the script ran on in this call. */
  readonly transformed: number;
  readonly validated: number;
  readonly needsFix: number;
  /** Pages whose run produced no usable output: now `needs-fix`, with the reason as `error`. */
  readonly failed: readonly MigrationTransformFailure[];
  /** Where the next call goes on from; absent when this one reached the end. */
  readonly next?: string;
  /** Whether pages are still to be read: a Workflow loops while it is true. */
  readonly more: boolean;
}

/**
 * Runs an approved template's script on its next batch of pages, in id order after `after`. Each
 * output is kept as the script returned it (its JSON is an artifact under the run, and the page's
 * `output.sha256` is that JSON's, which the load checks), scored against the page, and the page
 * moves to `validated` or `needs-fix` at the run's threshold with its last error cleared. A page
 * the script fails on, or whose output doesn't fit the content type, goes to `needs-fix` with the
 * reason.
 *
 * Safe to run again: a page already transformed by this script version (`outputScript`) is
 * skipped, as are pages loaded or published, and pages with no HTML. A new script version takes
 * every page again on the next pass.
 */
export async function transformTemplatePages(
  ctx: AppContext,
  deps: TemplateAuthoringDeps,
  scope: Scope,
  input: TransformTemplatePagesInput,
): Promise<TransformTemplatePagesResult> {
  const run = await requireRun(ctx, scope, input.runId);
  const template = await requireTemplate(ctx, scope, run.id, input.templateId);
  if (template.status !== 'approved' || !template.script || !template.contentTypeId) {
    throw new InvalidStateError(
      `A template's pages are transformed once it is approved; this one is ${template.status}`,
    );
  }
  const contentType = await ctx.store.contentTypes.get(scope, template.contentTypeId);
  if (!contentType) {
    throw new InvalidStateError(
      `The template's content type "${template.contentTypeId}" doesn't exist in this environment`,
    );
  }
  const scriptSha = template.script.sha256;
  const script = await readScript(deps.blob, template.script);
  const limit = Math.max(
    1,
    Math.min(input.batchSize ?? MIGRATION_TRANSFORM_BATCH_DEFAULT, MIGRATION_TRANSFORM_BATCH_MAX),
  );
  const pages = await ctx.store.migrations.listPages(scope, run.id, {
    templateId: template.id,
    limit,
    ...(input.after ? { after: input.after } : {}),
  });
  const due = pages.filter(
    (p) =>
      p.html !== null &&
      p.outputScript !== scriptSha &&
      p.stage !== 'loaded' &&
      p.stage !== 'published',
  );
  const summaryOf = importScriptContentType(contentType);
  const at = ctx.clock.now().toISOString();
  const failed: MigrationTransformFailure[] = [];
  const updated = await mapLimit(due, SCRIPT_CONCURRENCY, async (page): Promise<MigrationPage> => {
    const base = { ...page, outputScript: scriptSha, updatedAt: at };
    const fail = (error: string): MigrationPage => {
      const reason = clip(error, MAX_ERROR_LENGTH);
      failed.push({ pageId: page.id, url: page.url, error: reason });
      return { ...base, stage: 'needs-fix', output: null, score: null, error: reason };
    };
    const html = page.html ? await deps.blob.get(page.html.key) : null;
    if (html === null) return fail('The page’s HTML is missing from storage');
    const ran = await runScript(deps.sandbox, scope, script, page, html, summaryOf);
    const checked = checkOutput(ran, contentType);
    if (!checked.ok || !checked.output) {
      return fail(checked.error ?? checked.issues.join('; '));
    }
    const raw = JSON.stringify(checked.output);
    const sha256 = sha256Hex(raw);
    const key = migrationArtifactKey(scope, run.id, 'output', sha256);
    await deps.blob.put(key, raw, 'application/json');
    const score = scoreImportOutput(html, checked.output);
    return {
      ...base,
      stage: stageForScore(score, run.threshold),
      output: { key, sha256, bytes: utf8Bytes(raw) },
      score,
      error: null,
    };
  });
  // Pages are whole and their step is safe to repeat: no compare-and-set needed.
  if (updated.length > 0) await ctx.store.migrations.savePages(scope, run.id, updated);
  const more = pages.length === limit;
  const next = more ? pages.at(-1)?.id : undefined;
  return {
    transformed: updated.length,
    validated: updated.filter((p) => p.stage === 'validated').length,
    needsFix: updated.filter((p) => p.stage === 'needs-fix').length,
    failed,
    ...(next ? { next } : {}),
    more,
  };
}

// --- the content type as a script sees it -----------------------------------

/** The part of a content type an import script fills: names, types and shapes, nested. */
export function importScriptContentType(
  contentType: Pick<ContentType, 'apiId' | 'name' | 'fields'>,
): ImportScriptContentType {
  return {
    apiId: contentType.apiId,
    name: contentType.name,
    // The load sets the source URL itself; a script has nothing to put there.
    fields: contentType.fields.filter((f) => f.apiId !== MIGRATION_SOURCE_URL_FIELD).map(summarize),
  };
}

function summarize(field: FieldDefinition): ImportScriptFieldSummary {
  const variants = blockVariants(field);
  return {
    apiId: field.apiId,
    name: field.name,
    type: field.type,
    required: field.required,
    ...(field.linkType ? { linkType: field.linkType } : {}),
    ...(field.fields ? { fields: field.fields.map(summarize) } : {}),
    ...(field.items
      ? {
          items: {
            type: field.items.type,
            ...(field.items.linkType ? { linkType: field.items.linkType } : {}),
            ...(field.items.fields ? { fields: field.items.fields.map(summarize) } : {}),
            ...(variants
              ? {
                  variants: variants.map((v) => ({
                    apiId: v.apiId,
                    name: v.name,
                    fields: v.fields.map(summarize),
                  })),
                }
              : {}),
          },
        }
      : {}),
  };
}

// --- helpers ----------------------------------------------------------------

/**
 * Whether an output fits the content type: its top-level fields are the type's (not the blocks
 * field, which its blocks fill, nor `sourceUrl`, which the load sets), and each block names one of
 * the blocks field's variants.
 */
function modelIssues(contentType: ContentType, output: ImportScriptOutput): string[] {
  const issues: string[] = [];
  const blocksField = contentType.fields.find((f) => blockVariants(f) !== undefined);
  const fields = new Set(
    contentType.fields
      .filter((f) => f !== blocksField && f.apiId !== MIGRATION_SOURCE_URL_FIELD)
      .map((f) => f.apiId),
  );
  const unknown = Object.keys(output.fields).filter((k) => !fields.has(k));
  if (unknown.length > 0) {
    issues.push(`fields not on "${contentType.apiId}": ${unknown.slice(0, 10).join(', ')}`);
  }
  const variants = new Set(
    (blocksField ? blockVariants(blocksField) : undefined)?.map((v) => v.apiId),
  );
  const strays = [...new Set(output.blocks.map((b) => b.variant).filter((v) => !variants.has(v)))];
  if (strays.length > 0) {
    issues.push(`blocks of no variant of the blocks field: ${strays.slice(0, 10).join(', ')}`);
  }
  if (output.blocks.some((b) => BLOCK_TYPE_KEY in b.fields)) {
    issues.push(`a block's fields must not set ${BLOCK_TYPE_KEY}: its variant names it`);
  }
  return issues;
}

function checkOutput(
  ran: ImportScriptResult,
  contentType: ContentType,
): { ok: boolean; output?: ImportScriptOutput; issues: string[]; error?: string } {
  if (!ran.ok) return { ok: false, issues: [], error: `${ran.error.kind}: ${ran.error.message}` };
  const shape = importScriptOutputIssues(ran.output);
  if (shape.length > 0) return { ok: false, issues: shape };
  const output = ran.output as ImportScriptOutput;
  const issues = modelIssues(contentType, output);
  return { ok: issues.length === 0, output, issues };
}

/**
 * One page's run. A run the sandbox refuses (a page over its size limit) fails that page alone;
 * a sandbox that can't run at all (a domain error: no Worker Loader) fails the call.
 */
async function runScript(
  sandbox: ImportScriptSandbox,
  scope: Scope,
  script: string,
  page: MigrationPage,
  html: string,
  contentType: ImportScriptContentType,
): Promise<ImportScriptResult> {
  try {
    return await sandbox.run({
      scope,
      script,
      page: { url: page.url, html },
      contentType,
      timeoutMs: SCRIPT_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof DomainError || !(err instanceof RangeError)) throw err;
    return {
      ok: false,
      error: { kind: 'invalid-output', message: `the sandbox refused the page: ${err.message}` },
      logs: [],
    };
  }
}

/** The type a template's pages are scripted against: the approved one, else the proposal. */
async function templateModel(
  ctx: AppContext,
  scope: Scope,
  template: MigrationTemplate,
): Promise<ContentType> {
  if (template.status === 'approved' && template.contentTypeId) {
    const stored = await ctx.store.contentTypes.get(scope, template.contentTypeId);
    if (stored) return stored;
  }
  if (!template.proposal) {
    throw new InvalidStateError('Propose the template’s model before trying its script');
  }
  return defineContentType(template.proposal, { previewLoopback: ctx.previewLoopback === true });
}

function assertAuthorable(template: MigrationTemplate): void {
  if (template.status === 'approved') {
    throw new InvalidStateError('The template is approved: its model and script are settled');
  }
  if (template.status === 'approving') {
    throw new InvalidStateError('The template is being approved: its model and script are held');
  }
}

function checkScript(script: unknown): string {
  if (typeof script !== 'string' || !script.trim()) {
    throw new ValidationError([{ field: 'script', message: 'must be the script’s source' }]);
  }
  if (utf8Bytes(script) > MIGRATION_SCRIPT_MAX_BYTES) {
    throw new ValidationError([
      { field: 'script', message: `must be at most ${MIGRATION_SCRIPT_MAX_BYTES} bytes` },
    ]);
  }
  return script;
}

async function readScript(blob: BlobStore, artifact: MigrationArtifact): Promise<string> {
  const script = await blob.get(artifact.key);
  // The record names the bytes it was written with; other bytes under the key aren't those.
  if (script === null || sha256Hex(script) !== artifact.sha256) {
    throw new InvalidStateError('The template’s import script is missing from storage');
  }
  return script;
}

/**
 * Writes one template at the run's compare-and-set: reads the run and the template, applies
 * `change`, and writes both in one unit; a lost race reads again and goes on from the newer run.
 */
async function writeTemplate(
  ctx: AppContext,
  scope: Scope,
  ref: TemplateRef,
  change: (template: MigrationTemplate, at: string) => MigrationTemplate,
): Promise<MigrationTemplate> {
  for (let attempt = 1; ; attempt++) {
    const run = await requireRun(ctx, scope, ref.runId);
    // A stopped run's driver has given up, but its templates can still be taken on by hand.
    if (run.status !== 'clustered' && run.status !== 'stopped') {
      throw new InvalidStateError(
        `Templates are authored once a run is clustered; it is ${run.status}`,
      );
    }
    const template = await requireTemplate(ctx, scope, run.id, ref.templateId);
    const at = ctx.clock.now().toISOString();
    const changed = change(template, at);
    if (changed === template) return template;
    const next: MigrationTemplate = { ...changed, version: template.version + 1, updatedAt: at };
    try {
      await ctx.store.withTransaction(async (tx) => {
        await tx.migrations.saveTemplate(scope, run.id, next);
        await tx.migrations.saveRun(
          scope,
          { ...run, version: run.version + 1, updatedAt: at },
          run.version,
        );
      });
      return next;
    } catch (err) {
      if (!(err instanceof TransactionConflictError)) throw err;
      if (attempt >= WRITE_ATTEMPTS) {
        throw new ConflictError(
          'The migration run kept changing while its template was saved; try again',
        );
      }
    }
  }
}

async function requireRun(ctx: AppContext, scope: Scope, id: string): Promise<MigrationRun> {
  const run = await ctx.store.migrations.getRun(scope, id);
  if (!run) throw new NotFoundError('Migration run', id);
  return run;
}

async function requireTemplate(
  ctx: AppContext,
  scope: Scope,
  runId: string,
  id: string,
): Promise<MigrationTemplate> {
  const template = await ctx.store.migrations.getTemplate(scope, runId, id);
  if (!template) throw new NotFoundError('Migration template', id);
  return template;
}

/** `fn` over `items`, at most `limit` at a time, results in input order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const utf8Bytes = (s: string) => new TextEncoder().encode(s).byteLength;
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const round = (n: number) => Math.round(n * 1000) / 1000;
