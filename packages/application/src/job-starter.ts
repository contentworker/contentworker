import {
  assertWritableFields,
  authorize,
  authorizeContent,
  type ContentAction,
  canRunEntryBulkJob,
  DomainError,
  ENTRY_BULK_JOB_KINDS,
  type EntryBulkJobKind,
  ForbiddenError,
  holdsOnEveryContentType,
  type PermissionScope,
  type Principal,
  SCOPES,
  type Scope,
  UnauthorizedError,
} from '@contentworker/domain';
import type { BulkJob } from '@contentworker/ports';
import { principalForApiKey } from './auth';
import type { AppContext } from './context';

/**
 * Who started a bulk job, by reference: enough to resolve their access again before each chunk,
 * never a credential. `key` is an API key row (an operator key, or a person's OAuth, personal or
 * setup token); `member` is a signed-in person's team membership in the job's space;
 * `deployment` is the deployment's own authority (the admin and MCP tokens, or a deployment
 * admin acting in a space whose team they are not on). Its jobs run to the end as the system's
 * do: no space can take the tokens away, and a deployment admin's role lives with the admin web
 * app's people, which this layer can't read (demoting one mid-job doesn't stop their job).
 */
export type JobStarter =
  | { readonly kind: 'key'; readonly keyId: string }
  | { readonly kind: 'member'; readonly memberId: string }
  | { readonly kind: 'deployment' };

/** The reference a job records for the principal starting it; undefined when it names none. */
export function jobStarterOf(principal: Principal): JobStarter | undefined {
  if (principal.keyId) return { kind: 'key', keyId: principal.keyId };
  if (principal.memberId) return { kind: 'member', memberId: principal.memberId };
  if (principal.kind === 'admin' || principal.kind === 'user') return { kind: 'deployment' };
  return undefined;
}

/** The starter `job` recorded as `config.startedBy` (`persistJob`), or undefined: the system's, or one from before. */
export function jobStarter(job: Pick<BulkJob, 'config'>): JobStarter | undefined {
  const raw = job.config?.startedBy as Partial<Record<string, unknown>> | undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  if (raw.kind === 'key' && typeof raw.keyId === 'string') return { kind: 'key', keyId: raw.keyId };
  if (raw.kind === 'member' && typeof raw.memberId === 'string') {
    return { kind: 'member', memberId: raw.memberId };
  }
  if (raw.kind === 'deployment') return { kind: 'deployment' };
  return undefined;
}

/** What a job is cancelled with (`config.cancelReason`) when its starter can no longer run it. */
export const STARTER_LOST_ACCESS = 'starter_lost_access';

/**
 * Whether whoever started `job` may still run it, asked before each of its chunks: null when they
 * may (or the job is the system's, or older than the record), else why not. One resolution of the
 * starter, from the store as it stands, the same way their next request would be resolved: a key
 * revoked, expired, re-roled or its role deleted; a person disabled, removed from the team or
 * re-roled; a delegated token's person gone; and then the start rule for the job's action, scopes
 * and content grants both. Reads only.
 */
export async function starterLostAccess(
  ctx: AppContext,
  scope: Scope,
  job: BulkJob,
): Promise<string | null> {
  // A starter install is the system's work for a new space, whoever asked for the space.
  if (job.action === 'starter_install') return null;
  const starter = jobStarter(job);
  if (!starter || starter.kind === 'deployment') return null;
  const principal = await resolveStarter(ctx, scope.spaceId, starter);
  if (!principal) {
    return starter.kind === 'key'
      ? 'The API key or token that started this job no longer works here'
      : 'The person who started this job is no longer on the team, or is disabled';
  }
  try {
    authorizeJobContinues(principal, job, scope.spaceId);
    return null;
  } catch (err) {
    if (err instanceof DomainError) {
      return `The ${starter.kind === 'key' ? 'key' : 'person'} that started this job may no longer run it (${err.message})`;
    }
    throw err;
  }
}

/** The principal `starter` acts as in `spaceId` now, or null when it no longer acts there. */
async function resolveStarter(
  ctx: AppContext,
  spaceId: string,
  starter: Exclude<JobStarter, { kind: 'deployment' }>,
): Promise<Principal | null> {
  if (starter.kind === 'key') {
    // By space and id: a key of another space is not found, as its token would be refused here.
    const key = await ctx.store.auth.get(spaceId, starter.keyId);
    if (!key) return null;
    try {
      return await principalForApiKey(ctx, key);
    } catch (err) {
      if (err instanceof UnauthorizedError) return null;
      throw err;
    }
  }
  const member = await ctx.store.members.get(spaceId, starter.memberId);
  if (!member || member.disabled || !member.roleId) return null;
  const role = await ctx.store.roles.get(spaceId, member.roleId);
  if (!role) return null;
  return {
    spaceId,
    kind: 'user',
    ...(member.subject ? { subject: member.subject } : {}),
    scopes: role.scopes,
    ...(role.contentGrants ? { contentGrants: role.contentGrants } : {}),
    memberId: member.id,
  };
}

/**
 * Refuses `principal` the rest of `job` unless it could start the job now: the scopes its start
 * route asks for, and the content grants its start checks (`authorizeBulkJob`,
 * `authorizeSetFieldsJob`, a snapshot's every-type check). A job over entries of any type needs
 * the action on every type, so a grant narrowed for any type the chunk holds refuses it; a job
 * into one type (a field edit, an import) needs `write` there.
 */
export function authorizeJobContinues(principal: Principal, job: BulkJob, spaceId: string): void {
  for (const scope of scopesToRun(job)) authorize(principal, scope, spaceId);
  if ((ENTRY_BULK_JOB_KINDS as readonly string[]).includes(job.action)) {
    if (!canRunEntryBulkJob(principal, job.action as EntryBulkJobKind)) {
      throw new ForbiddenError(
        `bulk ${job.action} jobs (a role holding them on every content type)`,
      );
    }
    return;
  }
  const config = job.config ?? {};
  switch (job.action) {
    case 'content_type_delete':
      // As `authorizeBulkJob` for a job that isn't over entries: no per-type grants at all.
      if (principal.contentGrants) throw new ForbiddenError('bulk content_type_delete jobs');
      return;
    case 'set_fields': {
      const type = String(config.contentTypeApiId ?? '');
      authorizeContent(principal, 'write', type);
      const fields = config.fields;
      if (fields && typeof fields === 'object') {
        assertWritableFields(principal, type, fields as Record<string, unknown>);
      }
      return;
    }
    case 'import': {
      const type = config.contentTypeApiId;
      if (typeof type === 'string') {
        authorizeContent(principal, 'write', type);
        // The fields its records set, as a field edit's are (`config.fieldNames`, from the start).
        const names = Array.isArray(config.fieldNames) ? (config.fieldNames as unknown[]) : [];
        assertWritableFields(
          principal,
          type,
          Object.fromEntries(names.filter((n) => typeof n === 'string').map((n) => [n, true])),
        );
        return;
      }
      // A snapshot or clone reaches every type: the start's every-type check, with publishing
      // for its publishing phase.
      const actions: ContentAction[] =
        config.phase === 'publish' ? ['write', 'publish'] : ['read', 'write'];
      if (!holdsOnEveryContentType(principal, actions)) {
        throw new ForbiddenError('the import of every content type');
      }
      return;
    }
    default:
      // Asset jobs go by scopes alone, as their start routes do.
      return;
  }
}

/** The scopes the start route of `job`'s action asks for (HTTP and MCP alike). */
function scopesToRun(job: BulkJob): readonly PermissionScope[] {
  switch (job.action) {
    case 'publish':
    case 'unpublish':
    case 'trash':
    case 'restore':
    case 'purge':
    case 'asset_publish':
    case 'asset_unpublish':
    case 'asset_archive':
      return [SCOPES.contentPublish];
    case 'content_type_delete':
      return [SCOPES.contentManage, SCOPES.contentWrite, SCOPES.contentPublish];
    case 'set_fields':
      return [SCOPES.contentWrite];
    case 'import':
      return [
        (job.config as { kind?: unknown } | undefined)?.kind === 'snapshot'
          ? SCOPES.contentManage
          : SCOPES.contentWrite,
      ];
    case 'asset_move':
    case 'asset_tag':
    case 'asset_reindex':
      return [SCOPES.assetsWrite];
    case 'search_reindex':
      return [SCOPES.spaceAdmin];
    default:
      return [];
  }
}
