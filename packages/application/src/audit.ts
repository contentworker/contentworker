import type { Principal } from '@contentworker/domain';
import type { AuditEntry } from '@contentworker/ports';
import type { AppContext } from './context.js';

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
  };
  await ctx.store.audit.append(entry);
  return entry;
}

/** Reads a space's audit trail, newest first. */
export async function listAuditLog(
  ctx: AppContext,
  spaceId: string,
  query: { environmentId?: string; limit?: number } = {},
): Promise<AuditEntry[]> {
  return ctx.store.audit.list(spaceId, query);
}
