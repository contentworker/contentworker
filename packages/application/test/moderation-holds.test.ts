import {
  ConflictError,
  NotFoundError,
  type Principal,
  PublishGatedError,
  type Scope,
  WorkflowBuilder,
} from '@contentworker/domain';
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
  createWorkflowDraft,
  getEntry,
  holdEntryForModeration,
  keepHeldEntryUnpublished,
  listAgentRuns,
  listModerationHolds,
  publishEntry,
  publishWorkflowVersion,
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
/** A person signed in to the admin: the only one who may republish. */
const PERSON: Principal = {
  spaceId: 'blog',
  kind: 'user',
  subject: 'usr_editor',
  scopes: ['preview:read', 'content:write', 'content:publish'],
};
const by = { principal: PERSON };
const person = (subject: string) => ({ principal: { ...PERSON, subject } });
/** Tokens with every scope Republish needs, none of them a person signed in. */
const TOKENS: Record<string, Principal> = {
  'a CMA key': { spaceId: 'blog', kind: 'cma', scopes: PERSON.scopes, keyId: 'key-1' },
  'the admin token': { spaceId: '*', kind: 'admin', scopes: PERSON.scopes },
  'an OAuth token': {
    ...PERSON,
    issuance: 'oauth',
    clientId: 'client-1',
    keyId: 'key-2',
  },
  'a personal access token': { ...PERSON, issuance: 'pat', keyId: 'key-3' },
  'a setup credential': { ...PERSON, issuance: 'setup', keyId: 'key-4' },
};

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

  it('records the version that was live, never a draft past it', async () => {
    await updateEntry(ctx, scope, entryId, { title: { 'en-US': 'Draft after publish' } });
    await moderate({ ...HELD, judgedVersion: 2 });
    const [hold] = await openHolds();
    expect(hold?.entryVersion).toBe(1);
    // Republishing would put out the draft, which was never live: refused, nothing published.
    await expect(republishHeldEntry(ctx, scope, hold?.id ?? '', by)).rejects.toThrow(
      /edited after/,
    );
    expect((await getEntry(ctx, scope, entryId)).entry.publishedVersion).toBeNull();
    expect(await events('entry.published')).toHaveLength(1);
  });

  it('records the judged version when a publish landed while the classifier ran', async () => {
    await updateEntry(ctx, scope, entryId, { title: { 'en-US': 'Second' } });
    await publishEntry(ctx, scope, entryId);
    // The classifier read version 1; version 2 went live before the hold.
    expect(await holdEntryForModeration(ctx, scope, entryId, { flags: [], judgedVersion: 1 })).toBe(
      'held',
    );
    const [hold] = await openHolds();
    expect(hold?.entryVersion).toBe(1);
    await expect(republishHeldEntry(ctx, scope, hold?.id ?? '', by)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('retries only the hold when a concurrent write wins its commit', async () => {
    const run = vi.fn(async () => HELD);
    vi.spyOn(store, 'withTransaction').mockRejectedValueOnce(new TransactionConflictError());
    await runPublishAgents(ctx, { run }, scope, entryId, {
      enrich: false,
      moderate: true,
      autoApply: false,
    });
    // Moderation ran (and was billed) once; the hold landed on the retry.
    expect(run).toHaveBeenCalledTimes(1);
    expect(await openHolds()).toHaveLength(1);
    expect((await getEntry(ctx, scope, entryId)).entry.publishedVersion).toBeNull();
  });

  it('aborts its unit on a lost compare-and-set, as D1 does at commit', async () => {
    await moderate(HELD);
    const [hold] = await openHolds();
    const decision = { status: 'kept' as const, decidedAt: '2026-01-01T00:00:00.000Z' };
    await store.moderationHolds.decide(scope, hold?.id ?? '', { ...decision, decidedBy: 'a' });
    // Outside a unit the loss is an answer; inside one it aborts the unit and its other writes.
    expect(
      await store.moderationHolds.decide(scope, hold?.id ?? '', { ...decision, decidedBy: 'b' }),
    ).toBe(false);
    await expect(
      store.withTransaction(async (tx) => {
        await tx.outbox.append({
          id: 'evt-lost',
          type: 'entry.unpublished',
          scope,
          occurredAt: decision.decidedAt,
          entryId,
          contentTypeApiId: 'post',
        });
        await tx.moderationHolds.decide(scope, hold?.id ?? '', { ...decision, decidedBy: 'b' });
      }),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    expect((await store.outbox.readPending(500)).some((e) => e.id === 'evt-lost')).toBe(false);
  });

  it('closes as cleared when moderation passes a later published version', async () => {
    await moderate(HELD);
    await updateEntry(ctx, scope, entryId, { title: { 'en-US': 'Fixed' } });
    await publishEntry(ctx, scope, entryId);
    await moderate({ ...CLEAN, judgedVersion: 2 });
    expect(await openHolds()).toEqual([]);
    const [hold] = await listModerationHolds(ctx, scope);
    expect(hold).toMatchObject({ status: 'cleared', decidedBy: 'agent:moderate' });
  });

  it('stays open when a slow clean pass over an older version finishes after the hold', async () => {
    await moderate({ ...HELD, judgedVersion: 1 });
    await updateEntry(ctx, scope, entryId, { title: { 'en-US': 'Fixed' } });
    await publishEntry(ctx, scope, entryId);
    // The pass that judged version 1 clean, started before the flag, lands now: version 2 is
    // live, but it never read version 2.
    await moderate({ ...CLEAN, judgedVersion: 1 });
    expect(await openHolds()).toHaveLength(1);
    // The pass over version 2 clears it.
    await moderate({ ...CLEAN, judgedVersion: 2 });
    expect(await openHolds()).toEqual([]);
  });

  it('stays open on a clean verdict while nothing newer than the held version is live', async () => {
    await moderate(HELD);
    await moderate({ ...CLEAN, judgedVersion: 1 });
    expect(await openHolds()).toHaveLength(1);
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

  for (const [name, principal] of Object.entries(TOKENS)) {
    it(`is refused to ${name}, whatever its scopes, leaving the hold open`, async () => {
      const id = await holdId();
      await expect(republishHeldEntry(ctx, scope, id, { principal })).rejects.toMatchObject({
        code: 'forbidden',
        details: { reason: 'person_required' },
      });
      expect(await openHolds()).toHaveLength(1);
      expect((await getEntry(ctx, scope, entryId)).entry.publishedVersion).toBeNull();
    });
  }

  it('lets a token keep it unpublished, naming the key in the ledger', async () => {
    const result = await keepHeldEntryUnpublished(ctx, scope, await holdId(), {
      principal: TOKENS['an OAuth token'] as Principal,
    });
    expect(result.hold).toMatchObject({ status: 'kept', decidedBy: 'usr_editor' });
    const notes = (await listAgentRuns(ctx, scope)).flatMap((r) => r.decisions);
    expect(notes).toContain(
      'kept unpublished by usr_editor via OAuth client client-1 (flagged: hate)',
    );
  });

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

  it('is still refused by a workflow that gates publishing the type', async () => {
    const graph = new WorkflowBuilder()
      .n('start', 'trigger.manual', 'Submit')
      .n('publish', 'content.publish', 'Publish')
      .n('done', 'control.end', 'Done')
      .e('start', 'publish')
      .e('publish', 'done')
      .graph();
    const { workflow } = await createWorkflowDraft(ctx, scope, {
      name: 'Gate',
      contentTypes: ['post'],
      graph,
      gatesPublish: true,
    });
    await publishWorkflowVersion(ctx, scope, workflow.id);
    await expect(republishHeldEntry(ctx, scope, await holdId(), by)).rejects.toBeInstanceOf(
      PublishGatedError,
    );
    expect(await openHolds()).toHaveLength(1);
  });

  it('never names a field the decider can’t read in a refusal', async () => {
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'card',
      name: 'Card',
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
        {
          apiId: 'related',
          name: 'Related',
          type: 'Link',
          linkType: 'Entry',
          localized: false,
          required: false,
          position: 1,
        },
      ],
    });
    // The card links an entry that is later removed for good: the held version now dangles.
    const target = (
      await createEntry(ctx, scope, {
        contentTypeApiId: 'post',
        fields: { title: { 'en-US': 'T' } },
      })
    ).entry.id;
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'card',
      fields: {
        title: { 'en-US': 'Card' },
        related: { 'en-US': { id: target, linkType: 'Entry' } },
      },
    });
    await publishEntry(ctx, scope, entry.id);
    await moderate(HELD, entry.id);
    await store.entries.delete(scope, target);
    const held = (await listModerationHolds(ctx, scope, { entryId: entry.id }))[0];
    const err = await republishHeldEntry(ctx, scope, held?.id ?? '', {
      ...by,
      unreadable: ['related'],
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ issues: [{ code: 'hidden', hidden: 1 }] });
    expect(JSON.stringify(err)).not.toContain('related');
    expect(JSON.stringify(err)).not.toContain(target);
    // Without the denied field, the same refusal names it.
    await expect(republishHeldEntry(ctx, scope, held?.id ?? '', by)).rejects.toMatchObject({
      issues: [{ field: expect.stringMatching(/^related/) }],
    });
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
    await keepHeldEntryUnpublished(ctx, scope, id, person('usr_other'));
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

describe('a stale hold (a newer version is live)', () => {
  beforeEach(async () => {
    await moderate(HELD);
    // Moderation is off by now: someone edits and publishes version 2, and no pass clears it.
    await updateEntry(ctx, scope, entryId, { title: { 'en-US': 'Rewritten' } });
    await publishEntry(ctx, scope, entryId);
  });

  it('is listed as stale', async () => {
    expect(await openHolds()).toMatchObject([{ entryVersion: 1, stale: true }]);
  });

  it('closes on Republish without publishing or unpublishing anything', async () => {
    const [hold] = await openHolds();
    const published = (await events('entry.published')).length;
    const result = await republishHeldEntry(ctx, scope, hold?.id ?? '', by);
    expect(result).toMatchObject({
      published: false,
      hold: { status: 'cleared', decidedBy: 'usr_editor' },
    });
    expect(await events('entry.published')).toHaveLength(published);
    expect(await events('entry.unpublished')).toHaveLength(1);
    expect((await getEntry(ctx, scope, entryId)).entry.publishedVersion).toBe(2);
    expect(await openHolds()).toEqual([]);
    const notes = (await listAgentRuns(ctx, scope)).flatMap((r) => r.decisions);
    expect(notes).toContain('closed by usr_editor: version 2 is already live');
  });

  it('is still closed only by a signed-in person', async () => {
    const [hold] = await openHolds();
    await expect(
      republishHeldEntry(ctx, scope, hold?.id ?? '', {
        principal: TOKENS['a CMA key'] as Principal,
      }),
    ).rejects.toMatchObject({ details: { reason: 'person_required' } });
    expect(await openHolds()).toHaveLength(1);
  });

  it('is never taken down by Keep, which says a newer version is live', async () => {
    const [hold] = await openHolds();
    await expect(keepHeldEntryUnpublished(ctx, scope, hold?.id ?? '', by)).rejects.toThrow(
      /newer version \(2\) is live/,
    );
    expect((await getEntry(ctx, scope, entryId)).entry.publishedVersion).toBe(2);
    expect(await openHolds()).toHaveLength(1);
  });

  it('answers a lost race at commit with a 409, closing nothing', async () => {
    const [hold] = await openHolds();
    vi.spyOn(store, 'withTransaction').mockRejectedValueOnce(new TransactionConflictError());
    await expect(republishHeldEntry(ctx, scope, hold?.id ?? '', by)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(await openHolds()).toHaveLength(1);
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
