import {
  assetMimeChecks,
  authorizeContent,
  ConflictError,
  type ContentType,
  type ContentTypeChanges,
  type ContentTypeDraft,
  defineContentType,
  type EntryFields,
  type FieldDefinition,
  ForbiddenError,
  mimeTypeAllowed,
  NotFoundError,
  narrowsOverrides,
  type Principal,
  removedFields,
  removedFieldUses,
  removedVariants,
  removedVariantUses,
  reviseContentType,
  type Scope,
  singletonClaim,
  staleOverrideUses,
  uniqueClaims,
  validateEntryFields,
} from '@contentworker/domain';
import { type ContentStoreTx, TransactionConflictError } from '@contentworker/ports';
import type { AppContext } from './context';

/**
 * A field whose revision tightened a rule (`format`, `dateRange`, `assetMimeTypes`) that values
 * entries already hold now break. The save goes ahead; each such entry is refused on its next save
 * until the value is changed.
 */
export interface ContentTypeWarning {
  readonly field: string;
  /** How many entries (current versions, out of the trash) hold a value the new rule refuses. */
  readonly entries: number;
  readonly message: string;
}

/**
 * Blocks holding an override a revision (a catalog push, a type edit) makes stale (its breakpoint or prop removed, or its value narrowed out), for one
 * block, breakpoint and prop of a type. Reported, never refused: the overrides are dropped on each
 * entry's next save.
 */
export interface StaleOverrides {
  readonly contentTypeApiId: string;
  readonly block: string;
  readonly breakpoint: string;
  readonly prop: string;
  /** Blocks carrying the override, across the entries counted. */
  readonly blocks: number;
  readonly entries: number;
  /** False when the type had more entries than the count reads: the numbers are a lower bound. */
  readonly complete: boolean;
}

/** Entries read per type, at most, while counting stale overrides: as block usage counts. */
export const MAX_STALE_OVERRIDE_SCAN = 2000;

/** A saved content type, with what its revision means for the entries that hold it. */
export type SavedContentType = ContentType & { readonly warnings?: readonly ContentTypeWarning[] };

/**
 * Work no request's principal asks for in the moment: seeding, and an import or promotion already
 * authorized as a whole. The only value a content type save takes in place of a principal, so a
 * request handler can't skip the caller's checks by leaving its principal out: it has to name this.
 */
export const SYSTEM_CALLER: unique symbol = Symbol('contentworker.system-caller');

/** Who saves a content type: the request's principal, or {@link SYSTEM_CALLER}. */
export type ContentTypeCaller = Principal | typeof SYSTEM_CALLER;

/**
 * Refuses anything that is neither {@link SYSTEM_CALLER} nor shaped as a principal, before a save
 * reads anything: a caller the type system was talked out of (`as never`, an argument in the wrong
 * place, an untyped test) fails closed instead of skipping the caller's checks.
 */
export function assertContentTypeCaller(caller: ContentTypeCaller): void {
  if (caller === SYSTEM_CALLER) return;
  const shaped =
    typeof caller === 'object' &&
    caller !== null &&
    typeof caller.kind === 'string' &&
    Array.isArray(caller.scopes);
  if (!shaped) {
    throw new ForbiddenError('A content type is saved by a principal or the system caller');
  }
}

/**
 * A caller setting a type's preview URL decides where every preview link minted for its entries
 * sends its token, so it must be able to read those entries itself: `content:manage` alone isn't
 * enough when its grant leaves the type out. Clearing it, or sending back the stored one, needs
 * nothing more. Only {@link SYSTEM_CALLER} skips the check.
 */
export function authorizePreviewChange(
  caller: ContentTypeCaller,
  apiId: string,
  stored: ContentType['preview'],
  given: ContentTypeDraft['preview'],
): void {
  assertContentTypeCaller(caller);
  if (caller === SYSTEM_CALLER || !given) return;
  const template = typeof given.urlTemplate === 'string' ? given.urlTemplate.trim() : given;
  if (!template || template === stored?.urlTemplate) return;
  authorizeContent(caller, 'read', apiId);
}

/**
 * Holds a save to the type its caller read. A save sends the whole definition (every detail
 * field), so one built from a copy someone has since saved over would quietly put their `group`,
 * `description` or `agentInstructions` back; with the `version` it read, it is refused instead.
 * Absent, the save goes over whatever is stored, as it always has (`contentworker model apply`
 * and API clients that never read first).
 */
export interface ContentTypeSaveOptions {
  /**
   * The `version` the caller read, or 0 for a type it read as not existing: another is a
   * `ConflictError` (409) naming the stored `version` (0 when there is none), before any other
   * check and with nothing written.
   */
  readonly expectedVersion?: number;
}

function assertExpectedTypeVersion(
  apiId: string,
  stored: ContentType | null,
  options: ContentTypeSaveOptions,
): void {
  const expected = options.expectedVersion;
  const version = stored?.version ?? 0;
  if (expected === undefined || version === expected) return;
  const now = stored
    ? `is at version ${version}, not ${expected}`
    : `doesn't exist, so it isn't at version ${expected}`;
  throw new ConflictError(
    `Content type "${apiId}" ${now}: it changed after it was read. Read it again and make the ` +
      'change over the one stored.',
    { version, expectedVersion: expected },
  );
}

/**
 * Creates a new content type definition (status "draft", version 1), or revises the one with this
 * apiId. `caller` is held to `authorizePreviewChange`: the HTTP route and the MCP tool pass their
 * principal. `options.expectedVersion` holds either to what the caller read: 0 to create only.
 */
export async function createContentType(
  ctx: AppContext,
  caller: ContentTypeCaller,
  scope: Scope,
  draft: ContentTypeDraft,
  options: ContentTypeSaveOptions = {},
): Promise<SavedContentType> {
  assertContentTypeCaller(caller);
  // An existing type is revised, not defined afresh: a revision is checked against what is
  // stored, so a definition saved before a check existed can still be edited.
  const existing = await ctx.store.contentTypes.get(scope, draft.apiId);
  assertExpectedTypeVersion(draft.apiId, existing, options);
  if (existing) {
    return updateContentType(ctx, caller, scope, draft.apiId, draft, options);
  }
  authorizePreviewChange(caller, draft.apiId, undefined, draft.preview);
  const contentType = defineContentType(draft, { previewLoopback: ctx.previewLoopback === true });
  await ctx.store.contentTypes.save(scope, contentType);
  return contentType;
}

/**
 * Revises an existing content type, bumping its version. Refused (409) when it is no longer at
 * `options.expectedVersion`, when the caller gives one.
 */
export async function updateContentType(
  ctx: AppContext,
  caller: ContentTypeCaller,
  scope: Scope,
  apiId: string,
  changes: ContentTypeChanges,
  options: ContentTypeSaveOptions = {},
): Promise<SavedContentType> {
  assertContentTypeCaller(caller);
  const current = await ctx.store.contentTypes.get(scope, apiId);
  if (!current) throw new NotFoundError('ContentType', apiId);
  assertExpectedTypeVersion(apiId, current, options);
  authorizePreviewChange(caller, apiId, current.preview, changes.preview);
  const revised = reviseContentType(current, changes, {
    previewLoopback: ctx.previewLoopback === true,
  });
  await assertNoRemovedContentInUse(ctx, scope, current, revised);
  const warnings = [
    ...(await tightenedRulesInUse(ctx, scope, current, revised)),
    ...staleOverrideWarnings((await staleOverridesOf(ctx, scope, current, revised)).overrides),
  ];
  await saveContentTypeOver(ctx, scope, current, revised);
  return warnings.length > 0 ? { ...revised, warnings } : revised;
}

/**
 * Sets (or, with null, clears) a type's preview URL template and nothing else, so a caller
 * connecting a frontend never sends the whole definition back over someone's edit. Delivery never
 * serves the template, so it isn't a model change awaiting publish: a published type stays
 * published (with its `content_type.published` event, in the same unit), and a type with
 * unpublished changes keeps them as a draft. Held to the version it read, like every save: a
 * revision that lands first fails this one with a `ConflictError`.
 */
export async function setContentTypePreview(
  ctx: AppContext,
  caller: ContentTypeCaller,
  scope: Scope,
  apiId: string,
  urlTemplate: string | null,
): Promise<ContentType> {
  assertContentTypeCaller(caller);
  const current = await ctx.store.contentTypes.get(scope, apiId);
  if (!current) throw new NotFoundError('ContentType', apiId);
  const preview = urlTemplate === null ? null : { urlTemplate };
  authorizePreviewChange(caller, apiId, current.preview, preview);
  const revised = reviseContentType(
    current,
    { preview },
    { previewLoopback: ctx.previewLoopback === true },
  );
  // Published stays published only when the template is all that changed: a revision re-normalizes
  // the fields (pattern presets, blank guidance), and a definition stored before those rules would
  // otherwise go out as published without a publish.
  const rest = ({ preview: _p, version: _v, status: _s, ...t }: ContentType) =>
    JSON.stringify(t, (_k, v: unknown) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : v,
    );
  const next: ContentType =
    current.status === 'published' && rest(revised) === rest(current)
      ? { ...revised, status: 'published' }
      : revised;
  await saveContentTypeOver(ctx, scope, current, next);
  return next;
}

/** The rules a revision can tighten under values entries already hold, by field. */
const TIGHTENING = (f: FieldDefinition | undefined) =>
  JSON.stringify([
    f?.format,
    f?.items?.format,
    f?.validations?.dateRange,
    f?.items?.validations?.dateRange,
    f?.validations?.assetMimeTypes,
    f?.items?.validations?.assetMimeTypes,
  ]);

/**
 * The top-level fields whose `format`, `dateRange` or `assetMimeTypes` the revision adds or
 * changes, each with how many entries hold a value the new rule refuses and the old one took
 * (`ContentTypeWarning`). It never refuses: the rule is the author's to tighten, and the count says
 * what that costs, as `removedContentInUse` does for removals.
 *
 * Only reads when such a rule changed. Each field is judged alone (its other rules, `required`
 * and its conditional rules aside), against the current version of every entry out of the trash,
 * a page at a time; a page's linked assets are read together.
 */
export async function tightenedRulesInUse(
  ctx: AppContext,
  scope: Scope,
  current: ContentType,
  revised: ContentType,
): Promise<ContentTypeWarning[]> {
  const was = new Map(current.fields.map((f) => [f.apiId, f]));
  const tightened = revised.fields.filter(
    (f) => was.has(f.apiId) && TIGHTENING(f) !== TIGHTENING(was.get(f.apiId)),
  );
  if (tightened.length === 0) return [];
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) return [];
  const vctx = { defaultLocale: config.defaultLocale, locales: config.locales };
  // One field at a time, as a type of its own: nothing else it says can fail the value.
  const alone = (f: FieldDefinition): ContentType => ({
    ...revised,
    fields: [{ ...f, required: false, rules: undefined }],
  });
  const pairs = tightened.map((f) => ({
    apiId: f.apiId,
    before: alone(was.get(f.apiId) as FieldDefinition),
    after: alone(f),
  }));
  const failing = new Map<string, number>();
  for (let after = ''; ; ) {
    const page = await ctx.store.entries.list(scope, {
      contentTypeApiId: current.apiId,
      archived: false,
      limit: REMOVAL_SCAN_PAGE,
      afterEntryId: after,
    });
    const assetIds = new Set<string>();
    for (const e of page) {
      for (const p of pairs) {
        for (const c of assetMimeChecks(p.after, e.fields)) assetIds.add(c.assetId);
      }
    }
    const mimeOf = new Map(
      assetIds.size > 0
        ? (await ctx.store.assets.getMany(scope, [...assetIds])).map((a) => [
            a.id,
            a.file.contentType,
          ])
        : [],
    );
    const fails = (type: ContentType, values: EntryFields) =>
      validateEntryFields(type, values, vctx).length > 0 ||
      assetMimeChecks(type, values).some((c) => {
        const mime = mimeOf.get(c.assetId);
        return mime !== undefined && !mimeTypeAllowed(mime, c.allowed);
      });
    for (const e of page) {
      for (const p of pairs) {
        const values = { [p.apiId]: e.fields[p.apiId] ?? {} };
        if (fails(p.after, values) && !fails(p.before, values)) {
          failing.set(p.apiId, (failing.get(p.apiId) ?? 0) + 1);
        }
      }
    }
    if (page.length < REMOVAL_SCAN_PAGE) break;
    after = page[page.length - 1]?.entry.id ?? after;
  }
  return [...failing].map(([field, entries]) => ({
    field,
    entries,
    message:
      `${entries} ${entries === 1 ? 'entry holds' : 'entries hold'} a value for ${field} that ` +
      'its new rules refuse; each is refused on its next save until that value is changed.',
  }));
}

/**
 * The overrides entries of `current` hold that the revision `next` makes stale, counted per
 * block, breakpoint and prop as block usage counts blocks: the current version of each entry
 * outside the trash, a page at a time, up to {@link MAX_STALE_OVERRIDE_SCAN}. Reads only when the
 * revision drops a breakpoint or a responsive prop, or changes one's values. `blocks` counts the
 * blocks with any stale override, each once. `skip` leaves out entries the caller is about to
 * replace (a promotion's copies).
 */
export async function staleOverridesOf(
  ctx: AppContext,
  scope: Scope,
  current: ContentType,
  next: ContentType,
  opts: { readonly skip?: (entryId: string) => boolean } = {},
): Promise<{ readonly overrides: StaleOverrides[]; readonly blocks: number }> {
  if (!narrowsOverrides(current.fields, next.fields)) return { overrides: [], blocks: 0 };
  const counts = new Map<string, { blocks: number; entries: Set<string> }>();
  let blocks = 0;
  let read = 0;
  let complete = true;
  for (let after = ''; ; ) {
    const page = await ctx.store.entries.list(scope, {
      contentTypeApiId: current.apiId,
      archived: false,
      limit: REMOVAL_SCAN_PAGE,
      afterEntryId: after,
    });
    for (const e of page) {
      if (opts.skip?.(e.entry.id)) continue;
      const uses = staleOverrideUses(current.fields, next.fields, e.fields);
      blocks += new Set(uses.map((u) => u.site)).size;
      for (const use of uses) {
        const id = `${use.block}\u0000${use.breakpoint}\u0000${use.prop}`;
        const held = counts.get(id) ?? { blocks: 0, entries: new Set<string>() };
        held.blocks += 1;
        held.entries.add(e.entry.id);
        counts.set(id, held);
      }
    }
    read += page.length;
    if (page.length < REMOVAL_SCAN_PAGE) break;
    if (read >= MAX_STALE_OVERRIDE_SCAN) {
      complete = false;
      break;
    }
    after = page[page.length - 1]?.entry.id ?? after;
  }
  const overrides = [...counts].map(([id, held]) => {
    const [block, breakpoint, prop] = id.split('\u0000') as [string, string, string];
    return {
      contentTypeApiId: current.apiId,
      block,
      breakpoint,
      prop,
      blocks: held.blocks,
      entries: held.entries.size,
      complete,
    };
  });
  return { overrides, blocks };
}

/**
 * A revision's stale overrides as warnings, one per block, breakpoint and prop, as a catalog push
 * reports them in `staleOverrides`: saved, never refused.
 */
function staleOverrideWarnings(stale: readonly StaleOverrides[]): ContentTypeWarning[] {
  return stale.map((s) => ({
    field: `${s.block}._responsive.${s.breakpoint}.${s.prop}`,
    entries: s.entries,
    message:
      `${s.blocks}${s.complete ? '' : '+'} ${s.blocks === 1 ? 'block overrides' : 'blocks override'} ` +
      `${s.block}.${s.prop} at ${s.breakpoint}, which this revision makes stale; each entry drops ` +
      'the override on its next save.',
  }));
}

/** Entry ids a refusal to make a type a singleton names; the details carry the same. */
const SINGLETON_NAMED = 10;

/**
 * Saves `next` over `current` (null when the type is new to the scope): the one save every path
 * that writes a definition over another goes through (a revision, a promotion), or its two halves
 * (`prepareContentTypeSave`) for one saving several types in one unit (an environment merge, a
 * block catalog push), so turning `singleton` on or off keeps its rule wherever it happens.
 *
 * Turning it on is refused while the type has more than one entry outside the trash, naming them;
 * with one, that entry takes the singleton's claim in the same unit as the save, guarded so an
 * entry created after the read fails the commit (409) rather than becoming a second one. Turning
 * it off gives the claim back the same way. A save that leaves the flag alone is the plain save.
 *
 * Every save over a stored definition is guarded on the singleton flag and the version it read,
 * so a save racing a turn on or off, or another revision, fails (409) rather than undoing it.
 *
 * Delivery serves the definition as last published, fields, URL pattern and singleton flag alike
 * (`deliveredContentType`), so a save of a published definition (a merge or a promotion copies
 * one) announces `content_type.published` in the same unit, which purges the scope's delivery
 * responses: one event per published save. A draft over a live type changes nothing Delivery
 * serves, so it needs no purge: the store keeps what the type was, and the change arrives with the
 * publish. A draft with nothing kept (never published, or revised before definitions were kept)
 * is served as it stands, and its save still reaches GraphQL unannounced, as it always has.
 */
export async function saveContentTypeOver(
  ctx: AppContext,
  scope: Scope,
  current: ContentType | null,
  next: ContentType,
): Promise<void> {
  const save = await prepareContentTypeSave(ctx, scope, current, next);
  try {
    await ctx.store.withTransaction(save.write);
  } catch (err) {
    if (!(err instanceof TransactionConflictError)) throw err;
    throw new ConflictError(save.conflict);
  }
}

/** A content type save read and ready: its writes, for a unit, and what a lost race means. */
export interface PreparedContentTypeSave {
  readonly write: (tx: ContentStoreTx) => Promise<void>;
  /** The message a `TransactionConflictError` from the unit turns into. */
  readonly conflict: string;
}

/**
 * The reads `saveContentTypeOver` makes before its unit, and the writes it puts in the unit, apart:
 * so a caller saving several types together (a block catalog push) puts every type's writes in one
 * unit, each with the guards and the event its own save would have.
 */
export async function prepareContentTypeSave(
  ctx: AppContext,
  scope: Scope,
  current: ContentType | null,
  next: ContentType,
): Promise<PreparedContentTypeSave> {
  const was = current?.singleton === true;
  const is = next.singleton === true;
  // Whose claims change (none while the flag stays as it was): on, the type's entries outside the trash (at most one, or the turn is
  // refused); off, whichever entry holds the claim.
  let holders: { id: string; fields: EntryFields }[] = [];
  if (was === is) {
    // The plain save: no claim changes hands.
  } else if (is) {
    const live = await ctx.store.entries.list(scope, {
      contentTypeApiId: next.apiId,
      limit: SINGLETON_NAMED + 1,
    });
    if (live.length > 1) {
      const ids = live.slice(0, SINGLETON_NAMED).map((e) => e.entry.id);
      const more = live.length > SINGLETON_NAMED ? ' and more' : '';
      throw new ConflictError(
        `"${next.apiId}" has more than one entry outside the trash (${ids.join(', ')}${more}), ` +
          'so it cannot be a singleton. Move all but one to the trash first.',
        { entries: ids },
      );
    }
    holders = live.map((e) => ({ id: e.entry.id, fields: e.fields }));
  } else {
    const [held] = await ctx.store.entries.findUniqueConflicts(scope, [singletonClaim(next.apiId)]);
    const found = held ? await ctx.store.entries.get(scope, held.entryId) : null;
    holders = found ? [{ id: found.entry.id, fields: found.fields }] : [];
  }
  return {
    conflict:
      is && !was
        ? `"${next.apiId}" gained an entry or changed while it was being made a singleton; try again`
        : `"${next.apiId}" changed while it was being saved; try again`,
    async write(tx) {
      // Every save over a stored definition is judged against the flag and version it read, so
      // one that raced a turn on or off, or another revision, fails rather than undoing it;
      // turning it on also against the entries it read.
      if (current) {
        await tx.contentTypes.guard(scope, next.apiId, {
          singleton: was,
          version: current.version,
          ...(is && !was ? { entries: holders.map((h) => h.id) } : {}),
        });
      }
      await tx.contentTypes.save(scope, next);
      // Rebuilt from the entry's fields, so its unique values keep their claims beside it.
      for (const h of holders) {
        await tx.entries.replaceUniqueClaims(scope, h.id, uniqueClaims(next, h.fields));
      }
      if (next.status === 'published') {
        await tx.outbox.append({
          id: ctx.ids.newId(),
          type: 'content_type.published',
          scope,
          occurredAt: ctx.clock.now().toISOString(),
          contentTypeApiId: next.apiId,
          version: next.version,
        });
      }
    },
  };
}

/** Entries read per page while looking for content a revision would strand. */
const REMOVAL_SCAN_PAGE = 100;
/** Entry ids named per location in the error message; the details carry them all. */
const REMOVAL_SCAN_NAMED = 10;

/** What a revision removes that entries in `scope` still hold, by kind. */
export interface RemovedContentInUse {
  readonly variantsInUse: readonly { variant: string; entries: readonly string[] }[];
  readonly fieldsInUse: readonly { field: string; entries: readonly string[] }[];
}

/**
 * The block variants and fields `revised` removes from `current` that entries in `scope` still
 * hold: a block of a removed variant, or a value (anything but absent or null) for a removed
 * field, at any depth.
 *
 * Every copy of an entry that could be served or saved again is checked: its current version
 * (drafts and live entries), the trash (restorable), and the published snapshot, which can differ
 * from the current version when an entry has unpublished changes. Older history versions are
 * not: restoring one goes through `updateEntry`, which validates it against the type as it is
 * then.
 *
 * Only reads when something is actually removed, so ordinary edits cost nothing. Keyset pages by
 * entry id keep each read to one bounded statement (the type is a single bound parameter,
 * whatever the entry count).
 */
export async function removedContentInUse(
  ctx: AppContext,
  scope: Scope,
  current: ContentType,
  revised: Pick<ContentType, 'fields'>,
): Promise<RemovedContentInUse> {
  const variants = removedVariants(current.fields, revised.fields);
  const fields = removedFields(current.fields, revised.fields);
  if (variants.size === 0 && fields.size === 0) return { variantsInUse: [], fieldsInUse: [] };

  const variantUses = new Map<string, Set<string>>();
  const fieldUses = new Map<string, Set<string>>();
  const note = (into: Map<string, Set<string>>, key: string, entryId: string) => {
    const ids = into.get(key) ?? new Set<string>();
    ids.add(entryId);
    into.set(key, ids);
  };
  const check = (entryId: string, values: EntryFields) => {
    for (const use of removedVariantUses(current.fields, values, variants))
      note(variantUses, use, entryId);
    for (const use of removedFieldUses(current.fields, values, fields))
      note(fieldUses, use, entryId);
  };
  for (const archived of [false, true]) {
    for (let after = ''; ; ) {
      const page = await ctx.store.entries.list(scope, {
        contentTypeApiId: current.apiId,
        archived,
        limit: REMOVAL_SCAN_PAGE,
        afterEntryId: after,
      });
      for (const e of page) check(e.entry.id, e.fields);
      if (page.length < REMOVAL_SCAN_PAGE) break;
      after = page[page.length - 1]?.entry.id ?? after;
    }
  }
  for (let after = ''; ; ) {
    const page = await ctx.store.entries.listPublished(scope, {
      contentTypeApiId: current.apiId,
      limit: REMOVAL_SCAN_PAGE,
      afterEntryId: after,
    });
    for (const p of page) check(p.entryId, p.fields);
    if (page.length < REMOVAL_SCAN_PAGE) break;
    after = page[page.length - 1]?.entryId ?? after;
  }
  const sorted = (m: Map<string, Set<string>>) =>
    [...m].map(([at, ids]) => [at, [...ids].sort()] as const);
  return {
    variantsInUse: sorted(variantUses).map(([variant, entries]) => ({ variant, entries })),
    fieldsInUse: sorted(fieldUses).map(([field, entries]) => ({ field, entries })),
  };
}

/** `location (entries a, b and 3 more)`, for a refusal or a risk reason. */
export function describeRemovedInUse(at: string, entries: readonly string[]): string {
  const named = entries.slice(0, REMOVAL_SCAN_NAMED).join(', ');
  const more =
    entries.length > REMOVAL_SCAN_NAMED ? ` and ${entries.length - REMOVAL_SCAN_NAMED} more` : '';
  return `${at} (${entries.length === 1 ? 'entry' : 'entries'} ${named}${more})`;
}

/**
 * Refuses a revision that removes a blocks variant some entry still uses, or a field some entry
 * still holds a value for (`removedContentInUse`), naming each and its entries. There is no
 * override: change or clear those values first (and republish an entry whose published snapshot
 * holds them, or purge it from the trash).
 *
 * It reads before the save rather than inside one unit with it: an entry written with the removed
 * content in the moment between would fail its next save with a message naming it, which is the
 * outcome this guard exists to make explicit, not a silent loss.
 */
async function assertNoRemovedContentInUse(
  ctx: AppContext,
  scope: Scope,
  current: ContentType,
  revised: ContentType,
): Promise<void> {
  const { variantsInUse, fieldsInUse } = await removedContentInUse(ctx, scope, current, revised);
  if (variantsInUse.length === 0 && fieldsInUse.length === 0) return;
  const parts: string[] = [];
  if (variantsInUse.length) {
    const listed = variantsInUse.map((v) => describeRemovedInUse(v.variant, v.entries));
    parts.push(`Cannot remove block variants that entries still use: ${listed.join('; ')}.`);
  }
  if (fieldsInUse.length) {
    const listed = fieldsInUse.map((f) => describeRemovedInUse(f.field, f.entries));
    parts.push(`Cannot remove fields that entries still hold values for: ${listed.join('; ')}.`);
  }
  parts.push('Change or clear those values first.');
  throw new ConflictError(parts.join(' '), {
    ...(variantsInUse.length ? { variantsInUse } : {}),
    ...(fieldsInUse.length ? { fieldsInUse } : {}),
  });
}

export async function getContentType(
  ctx: AppContext,
  scope: Scope,
  apiId: string,
): Promise<ContentType> {
  const ct = await ctx.store.contentTypes.get(scope, apiId);
  if (!ct) throw new NotFoundError('ContentType', apiId);
  return ct;
}

export async function listContentTypes(ctx: AppContext, scope: Scope): Promise<ContentType[]> {
  return ctx.store.contentTypes.list(scope);
}

/** How many entries a content type holds, by status. `total` counts the live ones (not the trash). */
export interface ContentTypeEntryCounts {
  readonly contentType: string;
  readonly total: number;
  readonly draft: number;
  readonly changed: number;
  readonly published: number;
  readonly archived: number;
}

/**
 * Entry counts for every content type in the scope, from one grouped count: what the content
 * overview shows beside each type. A type with no entries reads as zeros, so every defined type is
 * listed, in the content model's order.
 */
export async function countEntriesByContentType(
  ctx: AppContext,
  scope: Scope,
): Promise<ContentTypeEntryCounts[]> {
  const [types, groups] = await Promise.all([
    ctx.store.contentTypes.list(scope),
    ctx.store.entries.countByStatus(scope),
  ]);
  const zero = (contentType: string) => ({
    contentType,
    total: 0,
    draft: 0,
    changed: 0,
    published: 0,
    archived: 0,
  });
  const byType = new Map(types.map((t) => [t.apiId, zero(t.apiId)]));
  for (const g of groups) {
    const row = byType.get(g.contentType);
    // Entries of a type that no longer exists have nowhere to be shown.
    if (!row) continue;
    row[g.status] += g.count;
    if (g.status !== 'archived') row.total += g.count;
  }
  return [...byType.values()];
}

/** Marks a content type published and emits a content_type.published event. */
export async function publishContentType(
  ctx: AppContext,
  scope: Scope,
  apiId: string,
): Promise<ContentType> {
  return ctx.store
    .withTransaction(async (tx) => {
      const current = await tx.contentTypes.get(scope, apiId);
      if (!current) throw new NotFoundError('ContentType', apiId);
      const published: ContentType = { ...current, status: 'published' };
      // Published as read: a turn on or off committed since fails this unit rather than being
      // published over with the stale flag.
      await tx.contentTypes.guard(scope, apiId, { singleton: current.singleton === true });
      await tx.contentTypes.save(scope, published);
      await tx.outbox.append({
        id: ctx.ids.newId(),
        type: 'content_type.published',
        scope,
        occurredAt: ctx.clock.now().toISOString(),
        contentTypeApiId: apiId,
        version: published.version,
      });
      return published;
    })
    .catch((err: unknown) => {
      if (!(err instanceof TransactionConflictError)) throw err;
      throw new ConflictError(`"${apiId}" changed while it was being published; try again`);
    });
}
