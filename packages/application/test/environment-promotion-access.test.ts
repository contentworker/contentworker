import {
  type ContentTypeGrant,
  ForbiddenError,
  NotFoundError,
  type Principal,
  SCOPES,
} from '@contentworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  approvePromotion,
  canReadPromotion,
  createContentType,
  createEntry,
  createEnvironment,
  createSpace,
  getPromotion,
  listPromotions,
  publishContentType,
  rejectPromotion,
  requestPromotion,
  SYSTEM_CALLER,
} from '../src/index';

/**
 * Who may request, approve and read a promotion, by their role's per-type grants and field rules.
 * A promotion copies entries whole (hidden and read-only fields included), with content types and
 * blocks, so requesting and approving one take `read`, `write` and `publish` on every type alike,
 * as a merge of entries or a snapshot import does; reading one takes `read` on every type it
 * names, with no field hidden.
 */

const spaceId = 's1';
const staging = { spaceId, environmentId: 'staging' };
const main = { spaceId, environmentId: 'main' };
const qa = { spaceId, environmentId: 'qa' };

const person = (subject: string, contentGrants?: readonly ContentTypeGrant[]): Principal => ({
  spaceId,
  kind: 'user',
  subject,
  scopes: [SCOPES.contentManage, SCOPES.contentPublish],
  ...(contentGrants ? { contentGrants } : {}),
});
const ada = person('ada');
const grace = person('grace');
/** Every type readable, but only `note` writable: it lacks write on `page`. */
const noteWriter = person('nina', [
  { contentTypeApiId: 'note', actions: ['read', 'write', 'publish'] },
  { contentTypeApiId: '*', actions: ['read'] },
]);
/** Every type alike, but `body` read-only. */
const readOnlyBody = person('rob', [
  { contentTypeApiId: '*', actions: ['read', 'write', 'publish'], readOnlyFields: ['body'] },
]);
/** Every type alike, but `body` hidden. */
const hiddenBody = person('hal', [
  { contentTypeApiId: '*', actions: ['read', 'write', 'publish'], deniedFields: ['body'] },
]);
/** One full `*` grant: every type alike, locking too, no field rules (the Manager preset's). */
const wide = person('wendy', [
  { contentTypeApiId: '*', actions: ['read', 'write', 'publish', 'lock'] },
]);
/** Every type alike, but no `lock` (the Editor preset's grant, without `content:manage`). */
const editor: Principal = {
  ...person('eddie', [{ contentTypeApiId: '*', actions: ['read', 'write', 'publish'] }]),
  scopes: [SCOPES.contentWrite, SCOPES.contentPublish],
};
const noLock = person('nora', [{ contentTypeApiId: '*', actions: ['read', 'write', 'publish'] }]);
const withLock = new ForbiddenError(
  'content:read+write+publish+lock:* (on every content type, every field)',
).message;
/** Reads `note` only. */
const noteReader = person('rita', [{ contentTypeApiId: 'note', actions: ['read'] }]);

const everyType = new ForbiddenError(
  'content:read+write+publish:* (on every content type, every field)',
).message;

let ctx: AppContext;
let store: InMemoryContentStore;

const def = (apiId: string) =>
  ({
    apiId,
    name: apiId,
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
      { apiId: 'body', name: 'Body', type: 'Text', localized: false, required: false, position: 1 },
    ],
  }) as Parameters<typeof createContentType>[3];

beforeEach(async () => {
  store = new InMemoryContentStore();
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('a') };
  await createSpace(ctx, { spaceId, name: 'S', defaultLocale: 'en-US' });
  await createEnvironment(ctx, spaceId, 'staging');
  await createEnvironment(ctx, spaceId, 'qa');
  for (const scope of [staging, main, qa]) {
    for (const apiId of ['note', 'page']) {
      await createContentType(ctx, SYSTEM_CALLER, scope, def(apiId));
      await publishContentType(ctx, scope, apiId);
    }
  }
});

async function draft(type: string, title: string) {
  const created = await createEntry(ctx, staging, {
    contentTypeApiId: type,
    fields: { title: { 'en-US': title }, body: { 'en-US': 'secret' } },
  });
  return created.entry.id;
}

/** Nothing was written for a refused request: no record, and nothing in the target. */
async function nothingWritten(target = qa) {
  expect(await store.promotions.list(spaceId, {})).toEqual([]);
  expect(await store.entries.list(target, {})).toEqual([]);
}

describe('requesting a promotion', () => {
  it.each([
    ['lacking write on one type', noteWriter],
    ['with a read-only field', readOnlyBody],
    ['with a hidden field', hiddenBody],
  ])('refuses a role %s before anything is written', async (_, requester) => {
    // Only a `note`, which the first role may write: the promotion is still refused, as it
    // copies the entry whole and could carry types and blocks.
    const id = await draft('note', 'One');
    await expect(
      requestPromotion(ctx, requester, spaceId, { source: 'staging', target: 'qa', entries: [id] }),
    ).rejects.toThrow(everyType);
    await nothingWritten();
  });

  it('applies for an unrestricted person and for a role holding every type alike', async () => {
    const one = await draft('note', 'One');
    const two = await draft('page', 'Two');
    const first = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'qa',
      entries: [one],
    });
    expect(first.status).toBe('completed');
    const second = await requestPromotion(ctx, wide, spaceId, {
      source: 'staging',
      target: 'qa',
      entries: [two],
    });
    expect(second.status).toBe('completed');
    expect((await store.entries.list(qa, {})).map((r) => r.entry.id).sort()).toEqual(
      [one, two].sort(),
    );
  });
});

describe('approving a promotion', () => {
  async function waiting() {
    const id = await draft('page', 'Into main');
    // Into main: it waits for someone else.
    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'main',
      entries: [id],
    });
    expect(p.status).toBe('awaiting_approval');
    return { id, p };
  }

  it.each([
    ['lacking write on one type', noteWriter],
    ['with a read-only field', readOnlyBody],
    ['with a hidden field', hiddenBody],
  ])('refuses an approver %s, leaving it waiting and the target as it was', async (_, approver) => {
    const { id, p } = await waiting();
    await expect(approvePromotion(ctx, approver, spaceId, p.id)).rejects.toThrow(everyType);
    await expect(rejectPromotion(ctx, approver, spaceId, p.id)).rejects.toThrow(everyType);
    expect((await store.promotions.get(spaceId, p.id))?.status).toBe('awaiting_approval');
    expect(await store.entries.get(main, id)).toBeNull();
  });

  it("applies on the approver's grants: another person, or a role holding every type", async () => {
    const first = await waiting();
    const done = await approvePromotion(ctx, wide, spaceId, first.p.id);
    expect(done).toMatchObject({ status: 'completed', decidedBy: 'wendy' });
    expect(await store.entries.get(main, first.id)).not.toBeNull();
    const second = await waiting();
    expect((await approvePromotion(ctx, grace, spaceId, second.p.id)).status).toBe('completed');
  });

  it("takes `lock` to copy entries over the target's locked regions, not to decide otherwise", async () => {
    // Requesting with entries: refused before anything is written.
    const id = await draft('note', 'Locked');
    await expect(
      requestPromotion(ctx, noLock, spaceId, { source: 'staging', target: 'qa', entries: [id] }),
    ).rejects.toThrow(withLock);
    await nothingWritten();
    // Approving one with entries: refused, left waiting. Rejecting it writes nothing: allowed.
    const { p } = await waiting();
    await expect(approvePromotion(ctx, editor, spaceId, p.id)).rejects.toThrow(withLock);
    expect((await store.promotions.get(spaceId, p.id))?.status).toBe('awaiting_approval');
    expect((await rejectPromotion(ctx, editor, spaceId, p.id)).status).toBe('rejected');
    // A content type alone copies no entry: no `lock` needed.
    const types = await requestPromotion(ctx, noLock, spaceId, {
      source: 'staging',
      target: 'qa',
      contentTypes: ['note'],
    });
    expect(types.status).toBe('completed');
  });

  it('takes content:manage to reject, as to approve, one carrying content types', async () => {
    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'main',
      contentTypes: ['page'],
    });
    expect(p.status).toBe('awaiting_approval');
    await expect(rejectPromotion(ctx, editor, spaceId, p.id)).rejects.toThrow(
      'Rejecting a promotion with content types or blocks takes content:manage',
    );
    await expect(approvePromotion(ctx, editor, spaceId, p.id)).rejects.toThrow(
      'Approving a promotion with content types or blocks takes content:manage',
    );
    expect((await store.promotions.get(spaceId, p.id))?.status).toBe('awaiting_approval');
    expect((await rejectPromotion(ctx, wide, spaceId, p.id)).status).toBe('rejected');
  });

  it('lets its requester withdraw it without decide rights, while it waits', async () => {
    // Carrying a content type and an entry: deciding it takes content:manage and every type.
    const id = await draft('page', 'Withdrawn');
    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'main',
      contentTypes: ['page'],
      entries: [id],
    });
    expect(p.status).toBe('awaiting_approval');
    // Ada's role narrows since: she reads both types, writes neither, and lost content:manage.
    const narrowed: Principal = {
      ...person('ada', [{ contentTypeApiId: '*', actions: ['read'] }]),
      scopes: [SCOPES.contentPublish],
    };
    // Anyone else with that role is held to deciding's checks, and it keeps waiting.
    const other: Principal = { ...narrowed, subject: 'olga' };
    await expect(rejectPromotion(ctx, other, spaceId, p.id)).rejects.toThrow(everyType);
    await expect(rejectPromotion(ctx, editor, spaceId, p.id)).rejects.toThrow(
      'Rejecting a promotion with content types or blocks takes content:manage',
    );
    // Approving her own stays refused; withdrawing it doesn't.
    await expect(approvePromotion(ctx, narrowed, spaceId, p.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect((await store.promotions.get(spaceId, p.id))?.status).toBe('awaiting_approval');
    const withdrawn = await rejectPromotion(ctx, narrowed, spaceId, p.id);
    expect(withdrawn).toMatchObject({ status: 'rejected', requestedBy: 'ada', decidedBy: 'ada' });
    expect(await store.entries.get(main, id)).toBeNull();
    // Only while it waits.
    await expect(rejectPromotion(ctx, narrowed, spaceId, p.id)).rejects.toThrow(
      'not awaiting approval',
    );
    // Not through an application acting for her: who withdraws is a person, as who decides.
    const q = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'main',
      entries: [await draft('page', 'Via app')],
    });
    await expect(
      rejectPromotion(ctx, { ...ada, clientId: 'agent' }, spaceId, q.id),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('still applies when its requester has lost access since: the approver answers for it', async () => {
    // Requested while unrestricted; the requester's role narrows afterwards. Nothing re-reads it:
    // the record names whoever asked (an API key only by its kind), and the approver, held to
    // every type, approves exactly the pinned versions.
    const { id, p } = await waiting();
    const done = await approvePromotion(ctx, grace, spaceId, p.id);
    expect(done).toMatchObject({ status: 'completed', requestedBy: 'ada', decidedBy: 'grace' });
    expect(await store.entries.get(main, id)).not.toBeNull();
  });
});

describe('reading promotions', () => {
  async function both() {
    const notes = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'qa',
      entries: [await draft('note', 'N')],
    });
    const pages = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'qa',
      entries: [await draft('page', 'P')],
    });
    return { notes, pages };
  }

  it('shows a role limited to some types only the promotions of types it can read', async () => {
    const { notes, pages } = await both();
    expect((await listPromotions(ctx, noteReader, spaceId)).map((p) => p.id)).toEqual([notes.id]);
    expect((await getPromotion(ctx, noteReader, spaceId, notes.id)).id).toBe(notes.id);
    // Not found, as the list leaves it out: a refusal would say it exists.
    await expect(getPromotion(ctx, noteReader, spaceId, pages.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(canReadPromotion(noteReader, pages)).toBe(false);
  });

  it('hides every promotion naming a type whose fields the role may not all read', async () => {
    const { notes } = await both();
    expect(await listPromotions(ctx, hiddenBody, spaceId)).toEqual([]);
    await expect(getPromotion(ctx, hiddenBody, spaceId, notes.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    // A read-only field is still read: that role sees them all.
    expect(await listPromotions(ctx, readOnlyBody, spaceId)).toHaveLength(2);
  });

  it('shows every promotion to an unrestricted principal', async () => {
    await both();
    expect(await listPromotions(ctx, ada, spaceId)).toHaveLength(2);
  });
});
