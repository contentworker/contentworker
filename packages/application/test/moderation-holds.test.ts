import { ConflictError, NotFoundError, type Principal, type Scope } from '@contentworker/domain';
import { TransactionConflictError } from '@contentworker/ports';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AgentRunner,
  type AgentRunOutcome,
  type AppContext,
  countPendingApprovals,
  createContentType,
  createEntry,
  createSpace,
  getEntry,
  holdEntryForModeration,
  keepHeldEntryUnpublished,
  listAgentRuns,
  listModerationHolds,
  publishEntry,
  republishHeldEntry,
  runPublishAgents,
  SYSTEM_CALLER,
  updateEntry,
} from '../src/index';

const scope: Scope = { spaceId: 'blog', environmentId: 'main' };
const other: Scope = { spaceId: 'blog', environmentId: 'staging' };
const HELD: AgentRunOutcome = {
  status: 'held',
  decisions: ['flagged: hate'],
  usage: { inputTokens: 1, outputTokens: 1 },
  flags: ['hate'],
};
const CLEAN: AgentRunOutcome = {
  status: 'completed',
  decisions: ['clean'],
  usage: { inputTokens: 1, outputTokens: 1 },
};
const by = { decidedBy: 'usr_editor' };

let store: InMemoryContentStore;
let ctx: AppContext;
let entryId: string;

/** A runner whose moderation verdict the test sets. */
function runner(verdict: AgentRunOutcome): AgentRunner {
  return { run: async () => verdict };
}

const moderate = (verdict: AgentRunOutcome, id = entryId, s = scope) =>
  runPublishAgents(ctx, runner(verdict), s, id, {
    enrich: false,
    moderate: true,
    autoApply: false,
  });

async function post(s: Scope, title = 'Hello') {
  const { entry } = await createEntry(ctx, s, {
    contentTypeApiId: 'post',
    fields: { title: { 'en-US': title } },
  });
  await publishEntry(ctx, s, entry.id);
  return entry.id;
}

async function type(s: Scope, apiId = 'post') {
  await createContentType(ctx, SYSTEM_CALLER, s, {
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
    ],
  });
}

const events = async (type: string) =>
  (await store.outbox.readPending(500)).filter((e) => e.type === type);
const openHolds = (s = scope) => listModerationHolds(ctx, s, { status: 'open' });

beforeEach(async () => {
  store = new InMemoryContentStore();
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('m') };
  await createSpace(ctx, { spaceId: 'blog', name: 'Blog', defaultLocale: 'en-US' });
  await type(scope);
  entryId = await post(scope);
});

describe('a moderation hold', () => {
  it('opens when moderation flags a published entry, which it takes offline', async () => {
    await moderate(HELD);
    expect((await getEntry(ctx, scope, entryId)).entry.publishedVersion).toBeNull();
    const [hold, ...rest] = await openHolds();
    expect(rest).toEqual([]);
    expect(hold).toMatchObject({
      entryId,
      contentTypeApiId: 'post',
      entryVersion: 1,
      flags: ['hate'],
      status: 'open',
    });
    // The unpublish went out with its event, written as the agent.
    expect(await events('entry.unpublished')).toHaveLength(1);
    expect((await getEntry(ctx, scope, entryId)).entry.updatedBy).toBe('agent:moderate');
    const notes = (await listAgentRuns(ctx, scope)).flatMap((r) => r.decisions);
    expect(notes).toContain('retracted from delivery pending review');
    expect((await countPendingApprovals(ctx, scope)).moderationHolds).toBe(1);
  });

  it('is opened once when the pass runs again (a redelivered message)', async () => {
    await moderate(HELD);
    await moderate(HELD);
    expect(await openHolds()).toHaveLength(1);
    expect(await events('entry.unpublished')).toHaveLength(1);
  });

  it('is not opened for an entry already out of delivery', async () => {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'Draft' } },
    });
    expect(await holdEntryForModeration(ctx, scope, entry.id, { flags: [] })).toBe('not_published');
    expect(await holdEntryForModeration(ctx, scope, 'missing', { flags: [] })).toBe('gone');
    expect(await openHolds()).toEqual([]);
  });

  it('is refreshed, not duplicated, when a republished entry is flagged again', async () => {
    await moderate(HELD);
    const [first] = await openHolds();
    // Someone edits and publishes it from the entry; moderation flags the new version too.
    await updateEntry(ctx, scope, entryId, { title: { 'en-US': 'Hello again' } });
    await publishEntry(ctx, scope, entryId);
    await moderate({ ...HELD, flags: ['violence'] });
    const holds = await openHolds();
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ id: first?.id, entryVersion: 2, flags: ['violence'] });
  });

  it('closes as cleared when moderation passes a later published version', async () => {
    await moderate(HELD);
    await updateEntry(ctx, scope, entryId, { title: { 'en-US': 'Fixed' } });
    await publishEntry(ctx, scope, entryId);
    await moderate(CLEAN);
    expect(await openHolds()).toEqual([]);
    const [hold] = await listModerationHolds(ctx, scope);
    expect(hold).toMatchObject({ status: 'cleared', decidedBy: 'agent:moderate' });
  });

  it('stays in its own environment', async () => {
    await type(other);
    const elsewhere = await post(other);
    await moderate(HELD, elsewhere, other);
    expect(await openHolds()).toEqual([]);
    expect(await openHolds(other)).toHaveLength(1);
    expect((await countPendingApprovals(ctx, scope)).moderationHolds).toBe(0);
    const [hold] = await openHolds(other);
    await expect(republishHeldEntry(ctx, scope, hold?.id ?? '', by)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('is listed to a role only on the types it may read', async () => {
    await type(scope, 'page');
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': 'Page' } },
    });
    await publishEntry(ctx, scope, entry.id);
    await moderate(HELD);
    await moderate(HELD, entry.id);
    const postsOnly: Principal = {
      spaceId: 'blog',
      kind: 'user',
      scopes: ['preview:read'],
      contentGrants: [{ contentTypeApiId: 'post', actions: ['read'] }],
    };
    const listed = await listModerationHolds(ctx, scope, { status: 'open' }, postsOnly);
    expect(listed.map((h) => h.entryId)).toEqual([entryId]);
    expect((await countPendingApprovals(ctx, scope, postsOnly)).moderationHolds).toBe(1);
  });
});

describe('republishHeldEntry', () => {
  beforeEach(async () => {
    await moderate(HELD);
  });
  const holdId = async () => (await openHolds())[0]?.id ?? '';

  it('publishes the held version again, closing the hold with who and why', async () => {
    const id = await holdId();
    const result = await republishHeldEntry(ctx, scope, id, { ...by, note: 'Quoted in a report' });
    expect(result.published).toBe(true);
    expect(result.hold).toMatchObject({
      status: 'republished',
      decidedBy: 'usr_editor',
      note: 'Quoted in a report',
    });
    expect((await getEntry(ctx, scope, entryId)).entry.publishedVersion).toBe(1);
    // The publish's event rode in the same unit as the hold's close.
    expect(await events('entry.published')).toHaveLength(2);
    expect(await openHolds()).toEqual([]);
    expect((await countPendingApprovals(ctx, scope)).moderationHolds).toBe(0);
    const notes = (await listAgentRuns(ctx, scope)).flatMap((r) => r.decisions);
    expect(notes).toContain('republished by usr_editor over moderation (flagged: hate)');
    expect(notes).toContain('reason: Quoted in a report');
  });

  it('is not undone by the moderation pass its own republish starts', async () => {
    await republishHeldEntry(ctx, scope, await holdId(), by);
    await moderate(HELD);
    expect((await getEntry(ctx, scope, entryId)).entry.publishedVersion).toBe(1);
    expect(await openHolds()).toEqual([]);
    const notes = (await listAgentRuns(ctx, scope)).flatMap((r) => r.decisions);
    expect(notes).toContain('left published: a person republished this version over moderation');
  });

  it('is refused once decided, by anyone', async () => {
    const id = await holdId();
    await keepHeldEntryUnpublished(ctx, scope, id, { decidedBy: 'usr_other' });
    await expect(republishHeldEntry(ctx, scope, id, by)).rejects.toBeInstanceOf(ConflictError);
    expect((await getEntry(ctx, scope, entryId)).entry.publishedVersion).toBeNull();
  });

  it('is refused when the entry was edited after it was held', async () => {
    const id = await holdId();
    await updateEntry(ctx, scope, entryId, { title: { 'en-US': 'Rewritten' } });
    await expect(republishHeldEntry(ctx, scope, id, by)).rejects.toThrow(/edited after/);
    expect((await getEntry(ctx, scope, entryId)).entry.publishedVersion).toBeNull();
    expect(await openHolds()).toHaveLength(1);
  });

  it('only closes the hold when someone already published the entry again', async () => {
    const id = await holdId();
    await publishEntry(ctx, scope, entryId);
    const before = (await events('entry.published')).length;
    const result = await republishHeldEntry(ctx, scope, id, by);
    expect(result.published).toBe(false);
    expect(await events('entry.published')).toHaveLength(before);
    expect(await openHolds()).toEqual([]);
  });

  it('answers a lost race at commit with a 409, publishing nothing', async () => {
    const id = await holdId();
    // Another writer wins between the reads and the commit.
    vi.spyOn(store, 'withTransaction').mockRejectedValueOnce(new TransactionConflictError());
    await expect(republishHeldEntry(ctx, scope, id, by)).rejects.toBeInstanceOf(ConflictError);
    expect(await openHolds()).toHaveLength(1);
    expect(await events('entry.published')).toHaveLength(1);
  });
});

describe('keepHeldEntryUnpublished', () => {
  beforeEach(async () => {
    await moderate(HELD);
  });

  it('closes the hold, leaving the entry offline', async () => {
    const [hold] = await openHolds();
    const result = await keepHeldEntryUnpublished(ctx, scope, hold?.id ?? '', by);
    expect(result.hold).toMatchObject({ status: 'kept', decidedBy: 'usr_editor' });
    expect((await getEntry(ctx, scope, entryId)).entry.publishedVersion).toBeNull();
    expect(await openHolds()).toEqual([]);
    expect(await events('entry.published')).toHaveLength(1);
    const notes = (await listAgentRuns(ctx, scope)).flatMap((r) => r.decisions);
    expect(notes).toContain('kept unpublished by usr_editor (flagged: hate)');
  });

  it('is refused when the entry was published again since, leaving the hold open', async () => {
    const [hold] = await openHolds();
    await publishEntry(ctx, scope, entryId);
    await expect(keepHeldEntryUnpublished(ctx, scope, hold?.id ?? '', by)).rejects.toThrow(
      /published again/,
    );
    expect(await openHolds()).toHaveLength(1);
  });

  it('is refused a second time, and 404s for a hold that never was', async () => {
    const [hold] = await openHolds();
    await keepHeldEntryUnpublished(ctx, scope, hold?.id ?? '', by);
    await expect(keepHeldEntryUnpublished(ctx, scope, hold?.id ?? '', by)).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(keepHeldEntryUnpublished(ctx, scope, 'nope', by)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
