import {
  type AuditDetail,
  capAuditDetail,
  type Principal,
  ValidationError,
} from '@contentworker/domain';
import type { AuditEntry } from '@contentworker/ports';
import type { AppContext } from './context';
import { clampCount, MAX_PAGE_LIMIT } from './entry-query';

/** Who an audit row names for a principal: the person, else the key kind (the admin token by name). */
export function auditActor(principal: Principal): string {
  if (principal.kind === 'admin') return 'admin-token';
  if (principal.kind === 'user' && principal.subject) return principal.subject;
  return principal.kind;
}

/** The fields a caller supplies; id + timestamp are filled from the context. */
export interface RecordAuditInput {
  readonly spaceId: string;
  readonly environmentId?: string;
  readonly actor: string;
  readonly action: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly status: number;
  /** What the action changed (`ChangeLog`), capped here so no row outgrows the limit. */
  readonly detail?: AuditDetail;
}

/**
 * Appends one entry to the append-only audit trail. IDs (UUIDv7) and the
 * timestamp come from the injected generators so the record is deterministic in
 * tests and time-ordered in the store.
 */
export async function recordAudit(ctx: AppContext, input: RecordAuditInput): Promise<AuditEntry> {
  const entry: AuditEntry = {
    id: ctx.ids.newId(),
    spaceId: input.spaceId,
    environmentId: input.environmentId,
    actor: input.actor,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    status: input.status,
    at: ctx.clock.now().toISOString(),
    ...(input.detail ? { detail: capAuditDetail(input.detail) } : {}),
  };
  await ctx.store.audit.append(entry);
  return entry;
}

/** What a caller may ask of the audit trail. Every filter is an exact match; all of them narrow. */
export interface AuditLogQuery {
  readonly environmentId?: string;
  readonly actor?: string;
  readonly action?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  /** The earliest time kept, inclusive: an ISO 8601 date (from its start, UTC) or date-time. */
  readonly from?: string;
  /** The latest time kept, inclusive: an ISO 8601 date (to its end, UTC) or date-time. */
  readonly to?: string;
  readonly limit?: number;
  /** `nextCursor` from the page before. */
  readonly cursor?: string;
}

export interface AuditLogPage {
  readonly items: AuditEntry[];
  /** Pass back as `cursor` for the next page; absent on the last one. */
  readonly nextCursor?: string;
}

const encodeCursor = (entry: AuditEntry): string =>
  btoa(encodeURIComponent(JSON.stringify([entry.at, entry.id])))
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

function decodeCursor(cursor: string): { at: string; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(atob(cursor.replace(/-/g, '+').replace(/_/g, '/'))));
  } catch {
    // Falls through to the refusal.
  }
  if (Array.isArray(parsed) && parsed.length === 2) {
    const [at, id] = parsed as unknown[];
    if (typeof at === 'string' && !Number.isNaN(Date.parse(at)) && typeof id === 'string' && id) {
      return { at, id };
    }
  }
  throw new ValidationError([{ field: 'cursor', message: 'cursor could not be read' }]);
}

const ISO_DATE_OR_TIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/**
 * A bound of the date range as an exact time. `Date.parse` alone would take far looser text and
 * roll 31 February over into March, so a range that can't mean what it says is refused instead.
 */
function rangeBound(field: 'from' | 'to', raw: string): string {
  const date = ISO_DATE_OR_TIME.exec(raw);
  const dateOnly = raw.length === 10;
  const ms = Date.parse(field === 'to' && dateOnly ? `${raw}T23:59:59.999Z` : raw);
  const [year, month, day] = (date ?? []).slice(1).map(Number) as [number, number, number];
  if (!date || Number.isNaN(ms) || new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) {
    throw new ValidationError([
      { field, message: `${field} must be an ISO 8601 date or a date-time with an offset` },
    ]);
  }
  return new Date(ms).toISOString();
}

/**
 * Reads a space's audit trail, newest first, a page at a time. Paging is a keyset on (`at`, `id`):
 * entries appended while a reader walks the log shift no page, and entries sharing a millisecond
 * are neither lost nor repeated at a page's edge.
 */
export async function listAuditLog(
  ctx: AppContext,
  spaceId: string,
  query: AuditLogQuery = {},
): Promise<AuditLogPage> {
  const from = query.from ? rangeBound('from', query.from) : undefined;
  const to = query.to ? rangeBound('to', query.to) : undefined;
  if (from && to && from > to) {
    throw new ValidationError([{ field: 'from', message: 'from must not be after to' }]);
  }
  const limit = clampCount(query.limit, MAX_PAGE_LIMIT, { min: 1 }) ?? MAX_PAGE_LIMIT;
  // An empty value is no filter, as an empty `?environment=` always was.
  const rows = await ctx.store.audit.list(spaceId, {
    environmentId: query.environmentId || undefined,
    actor: query.actor || undefined,
    action: query.action || undefined,
    targetType: query.targetType || undefined,
    targetId: query.targetId || undefined,
    from,
    to,
    after: query.cursor ? decodeCursor(query.cursor) : undefined,
    // One past the page: whether it comes back is whether there is a next page.
    limit: limit + 1,
  });
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    ...(rows.length > limit && last ? { nextCursor: encodeCursor(last) } : {}),
  };
}
