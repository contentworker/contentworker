import {
  assertWritableFields,
  authorizeContent,
  type ContentType,
  DomainError,
  type EntryFields,
  NotFoundError,
  type Principal,
  type Scope,
  type ValidationContext,
  ValidationError,
} from '@contentworker/domain';
import type { BulkItemFailure, BulkJob, BulkJobChunk } from '@contentworker/ports';
import { actingForJob, type BulkChunkOutcome, startBulkJob } from './bulk-jobs';
import type { AppContext } from './context';
import { saveEntryDraft } from './entries';

/**
 * Bulk field edit: one job that sets the same field values on many entries of one content type,
 * on the resumable bulk job machinery (`bulk-jobs.ts`). Each entry is saved as a new draft
 * through the same save a single edit makes (`saveEntryDraft`), so every rule an edit keeps holds
 * per entry: field validation and the type's field rules, `entry:beforeSave` plugins, an entry in
 * the trash refused. A refusal is that entry's failure in the job's report; the others are saved.
 */

/**
 * The values to set: field apiId → locale → value, as an entry's fields are written. Only the
 * locales named change; the field's other locales and every other field keep what they hold. A
 * `null` clears that locale.
 */
export type FieldValuesToSet = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export interface StartSetFieldsJobInput {
  readonly contentTypeApiId: string;
  readonly entryIds: readonly string[];
  readonly fields: FieldValuesToSet;
}

/** The largest `fields` a job carries, serialized: it is stored with the job. */
export const SET_FIELDS_MAX_BYTES = 64 * 1024;

/**
 * Refuses a principal who may not set `fields` on the entries of `contentTypeApiId`: `write` on
 * the type, and none of the fields denied or read-only to its role. One rule for both surfaces.
 * Reading the job's report afterwards also needs a role with no field rules on the type
 * (`authorizeBulkJobAccess`), as an import into one type does.
 */
export function authorizeSetFieldsJob(
  principal: Principal,
  contentTypeApiId: string,
  fields: FieldValuesToSet,
): void {
  authorizeContent(principal, 'write', contentTypeApiId);
  assertWritableFields(principal, contentTypeApiId, fields);
}

/**
 * Starts a `set_fields` job. The values are checked against the type here, before any entry is
 * touched: every field must be one of the type's top-level fields and every locale one of the
 * space's (only the default locale for a field that isn't localized). A unique field is refused:
 * one value on many entries can be held by only one. Whether a value is valid for its field is
 * judged per entry when it is saved, with that entry's other fields (rules can depend on them).
 */
export async function startSetFieldsJob(
  ctx: AppContext,
  scope: Scope,
  input: StartSetFieldsJobInput,
): Promise<BulkJob> {
  const contentType = await ctx.store.contentTypes.get(scope, input.contentTypeApiId);
  if (!contentType) throw new NotFoundError('ContentType', input.contentTypeApiId);
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);

  const issues: { field: string; locale?: string; message: string }[] = [];
  const names = Object.keys(input.fields);
  if (names.length === 0) issues.push({ field: 'fields', message: 'No fields to set' });
  for (const apiId of names) {
    const field = contentType.fields.find((f) => f.apiId === apiId);
    if (!field) {
      issues.push({ field: apiId, message: `"${contentType.apiId}" has no field "${apiId}"` });
      continue;
    }
    if (field.unique) {
      issues.push({
        field: apiId,
        message: 'A unique field can’t be set to one value on many entries',
      });
    }
    const locales = Object.keys(input.fields[apiId] ?? {});
    if (locales.length === 0) issues.push({ field: apiId, message: 'No locales to set' });
    for (const locale of locales) {
      if (!config.locales.includes(locale)) {
        issues.push({
          field: apiId,
          locale,
          message: `"${locale}" is not one of this space’s locales`,
        });
      } else if (!field.localized && locale !== config.defaultLocale) {
        issues.push({
          field: apiId,
          locale,
          message: `The field is not localized; only ${config.defaultLocale} is allowed`,
        });
      }
    }
  }
  if (new TextEncoder().encode(JSON.stringify(input.fields)).length > SET_FIELDS_MAX_BYTES) {
    issues.push({ field: 'fields', message: `Values exceed ${SET_FIELDS_MAX_BYTES} bytes` });
  }
  if (issues.length > 0) throw new ValidationError(issues);

  return startBulkJob(ctx, scope, {
    action: 'set_fields',
    entryIds: input.entryIds,
    config: { contentTypeApiId: contentType.apiId, fields: input.fields },
  });
}

/** `stored` with `set` laid over it, locale by locale; `null` removes a locale. */
export function withFieldValues(stored: EntryFields, set: FieldValuesToSet): EntryFields {
  const out: EntryFields = { ...stored };
  for (const [apiId, values] of Object.entries(set)) {
    const localized: Record<string, unknown> = { ...(stored[apiId] ?? {}) };
    for (const [locale, value] of Object.entries(values)) {
      if (value === null) delete localized[locale];
      else localized[locale] = value;
    }
    if (Object.keys(localized).length > 0) out[apiId] = localized;
    else delete out[apiId];
  }
  return out;
}

/** Whether `stored` already holds every value of `set` (so saving it again would change nothing). */
function alreadySet(stored: EntryFields, set: FieldValuesToSet): boolean {
  return Object.entries(set).every(([apiId, values]) =>
    Object.entries(values).every(([locale, value]) => {
      const held = stored[apiId]?.[locale];
      return value === null ? held === undefined : JSON.stringify(held) === JSON.stringify(value);
    }),
  );
}

/** A validation error names its fields, so the report says what to fix. */
const failureMessage = (err: DomainError): string =>
  err instanceof ValidationError && err.issues.length
    ? err.issues
        .map((i) =>
          i.field ? `${i.field}${i.locale ? ` (${i.locale})` : ''}: ${i.message}` : i.message,
        )
        .join('; ')
    : err.message;

/**
 * The chunk runner for `set_fields` jobs. Safe to run twice (a redelivery, the stall sweep): an
 * entry that already holds every value counts as a success and is not saved again, so a re-run
 * leaves no second version and reports the same totals.
 */
export function entryFieldsChunkRunner(
  ctx: AppContext,
): (scope: Scope, job: BulkJob, chunk: BulkJobChunk) => Promise<BulkChunkOutcome> {
  return async (scope, job, chunk) => {
    const acting = actingForJob(ctx, job);
    const typeApiId = String(job.config?.contentTypeApiId ?? '');
    const set = (job.config?.fields ?? {}) as FieldValuesToSet;
    const failAll = (error: string): BulkChunkOutcome => ({
      succeeded: 0,
      failures: chunk.entryIds.map((id) => ({ id, error })),
    });

    // Read once per chunk: the type as it is now (it may have changed since the job started; each
    // save is judged against what the type is when it runs, as any edit is), and the locales.
    const contentType: ContentType | null = await ctx.store.contentTypes.get(scope, typeApiId);
    if (!contentType) return failAll(`Content type "${typeApiId}" not found`);
    const config = await ctx.store.spaces.getConfig(scope);
    if (!config) return failAll(`Space "${scope.spaceId}" not found`);
    const vctx: ValidationContext = {
      defaultLocale: config.defaultLocale,
      locales: config.locales,
    };

    const found = new Map(
      (await ctx.store.entries.getMany(scope, chunk.entryIds)).map((e) => [e.entry.id, e]),
    );
    const failures: BulkItemFailure[] = [];
    for (const id of chunk.entryIds) {
      const current = found.get(id);
      if (!current) {
        failures.push({ id, error: 'Entry not found' });
        continue;
      }
      if (current.entry.contentTypeApiId !== typeApiId) {
        failures.push({
          id,
          error: `Entry is a "${current.entry.contentTypeApiId}", not a "${typeApiId}"`,
        });
        continue;
      }
      if (alreadySet(current.fields, set)) continue;
      try {
        await saveEntryDraft(
          acting,
          scope,
          current.entry,
          contentType,
          { ...vctx, previous: current.fields },
          withFieldValues(current.fields, set),
          current.fields,
        );
      } catch (err) {
        // A rule's refusal is this entry's outcome; anything else (the database) fails the chunk,
        // which is released and retried whole.
        if (!(err instanceof DomainError)) throw err;
        failures.push({ id, error: failureMessage(err) });
      }
    }
    return { succeeded: chunk.entryIds.length - failures.length, failures };
  };
}
