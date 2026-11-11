import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type Principal,
  type Promotion,
  PromotionFailedError,
  SCOPES,
  ValidationError,
  WorkflowBuilder,
} from '@contentworker/domain';
import {
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
  StubDecisionModel,
} from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  approvePromotion,
  createContentType,
  createEntry,
  createEnvironment,
  createSpace,
  createWorkflowDraft,
  deleteEnvironment,
  deleteEnvironmentAlias,
  failStalePromotions,
  getPromotion,
  listPromotions,
  PROMOTION_APPLY_TIMEOUT_MS,
  publishContentType,
  publishEntry,
  publishWorkflowVersion,
  readPromotion,
  rejectPromotion,
  requestPromotion,
  SYSTEM_CALLER,
  setEnvironmentAlias,
  trashEntry,
  updateEntry,
} from '../src/index';

const spaceId = 's1';
const staging = { spaceId, environmentId: 'staging' };
const main = { spaceId, environmentId: 'main' };
const qa = { spaceId, environmentId: 'qa' };
const ada: Principal = { spaceId, kind: 'user', subject: 'ada', scopes: [SCOPES.contentPublish] };
const grace: Principal = { ...ada, subject: 'grace' };

let ctx: AppContext;
let store: InMemoryContentStore;
let clock: FixedClock;

const note = (fields: { required?: boolean; extra?: boolean } = {}) =>
  ({
    apiId: 'note',
    name: 'Note',
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
      ...(fields.extra === false
        ? []
        : [
            {
              apiId: 'body',
              name: 'Body',
              type: 'Text',
              localized: false,
              required: fields.required ?? false,
              position: 1,
            },
          ]),
    ],
  }) as Parameters<typeof createContentType>[3];

async function seedModel(scope: typeof staging, def = note()) {
  await createContentType(ctx, SYSTEM_CALLER, scope, def);
  await publishContentType(ctx, scope, 'note');
}

beforeEach(async () => {
  store = new InMemoryContentStore();
  clock = new FixedClock();
  ctx = { store, clock, ids: new SequenceIdGenerator('p') };
  await createSpace(ctx, { spaceId, name: 'S', defaultLocale: 'en-US' });
  await createEnvironment(ctx, spaceId, 'staging');
  await createEnvironment(ctx, spaceId, 'qa');
  for (const scope of [staging, main, qa]) await seedModel(scope);
});

/** The record a promotion that stopped after a write carries in its error. */
async function failedOf(run: Promise<unknown>): Promise<Promotion> {
  const err = await run.then(
    () => {
      throw new Error('expected the apply to stop partway');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PromotionFailedError);
  return (err as PromotionFailedError).promotion;
}

const events = async (type: string) =>
  (await store.outbox.readPending(1000)).filter((e) => e.type === type);

const symbol = (apiId: string, position = 0) => ({
  apiId,
  name: apiId,
  type: 'Symbol',
  localized: false,
  required: false,
  position,
});
const page = (variants: unknown[]) =>
  ({
    apiId: 'page',
    name: 'Page',
    displayField: 'title',
    fields: [
      { ...symbol('title'), required: true },
      { ...symbol('body', 1), type: 'Array', items: { type: 'Component', variants } },
    ],
  }) as Parameters<typeof createContentType>[3];
const hero = { apiId: 'hero', name: 'Hero', fields: [symbol('heading'), symbol('kicker', 1)] };
const cta = { apiId: 'cta', name: 'CTA', fields: [symbol('label')] };

/** qa's page has a hero (with a kicker) and a cta; staging's drops the cta and the kicker. */
async function seedPages() {
  await createContentType(ctx, SYSTEM_CALLER, qa, page([hero, cta]));
  await publishContentType(ctx, qa, 'page');
  await createContentType(
    ctx,
    SYSTEM_CALLER,
    staging,
    page([{ ...hero, fields: [symbol('heading')] }]),
  );
  await publishContentType(ctx, staging, 'page');
}

const withCta = (title: string) => ({
  title: { 'en-US': title },
  body: { 'en-US': [{ _type: 'cta', label: 'Go' }] },
});
const variantsOf = async (scope: typeof qa) =>
  (await store.contentTypes.get(scope, 'page'))?.fields[1]?.items?.variants?.map((v) => v.apiId);

describe('promoting content between environments', () => {
  it('applies at once when nothing calls for approval: live goes live, drafts stay drafts', async () => {
    const live = await createEntry(ctx, staging, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Live' } },
    });
    await publishEntry(ctx, staging, live.entry.id);
    const draft = await createEntry(ctx, staging, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Draft' } },
    });

    const p = await requestPromotion(ctx, ada, spaceId, { source: 'staging', target: 'qa' });
    expect(p).toMatchObject({
      status: 'completed',
      risk: { protectedTarget: false, requiresApproval: false },
      requestedBy: 'ada',
      result: { mismatched: [] },
    });
    expect((await store.entries.getPublished(qa, live.entry.id))?.fields.title).toEqual({
      'en-US': 'Live',
    });
    expect(await store.entries.getPublished(qa, draft.entry.id)).toBeNull();
    expect((await store.entries.get(qa, draft.entry.id))?.fields.title).toEqual({
      'en-US': 'Draft',
    });
    expect(await events('environment.promoted')).toMatchObject([{ scope: qa, promotionId: p.id }]);
  });

  it('waits for someone else to approve a promotion into main, then applies the pinned version', async () => {
    const e = await createEntry(ctx, staging, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Reviewed' } },
    });
    await publishEntry(ctx, staging, e.entry.id);

    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'main',
      entries: [e.entry.id],
    });
    expect(p.status).toBe('awaiting_approval');
    expect(p.risk.reasons).toContain('The target is main');
    expect(await store.entries.get(main, e.entry.id)).toBeNull();
    expect(await events('promotion.awaiting_approval')).toMatchObject([
      { scope: main, promotionId: p.id, requestedBy: 'ada' },
    ]);

    // Edited in the source after the request: the promotion still copies what was pinned.
    await updateEntry(ctx, staging, e.entry.id, { title: { 'en-US': 'Edited later' } });
    await publishEntry(ctx, staging, e.entry.id);

    await expect(approvePromotion(ctx, ada, spaceId, p.id)).rejects.toBeInstanceOf(ForbiddenError);
    const approved = await approvePromotion(ctx, grace, spaceId, p.id);
    expect(approved).toMatchObject({ status: 'completed', decidedBy: 'grace' });
    expect((await store.entries.getPublished(main, e.entry.id))?.fields.title).toEqual({
      'en-US': 'Reviewed',
    });
    // Decided once.
    await expect(approvePromotion(ctx, grace, spaceId, p.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it('is decided by a person or the admin token, never an API key', async () => {
    const e = await createEntry(ctx, staging, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Keys' } },
    });
    const ci: Principal = { spaceId, kind: 'cma', scopes: [SCOPES.contentPublish] };
    const p = await requestPromotion(ctx, ci, spaceId, {
      source: 'staging',
      target: 'main',
      entries: [e.entry.id],
    });
    expect(p.requestedBy).toBe('cma');
    await expect(approvePromotion(ctx, ci, spaceId, p.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(rejectPromotion(ctx, ci, spaceId, p.id)).rejects.toBeInstanceOf(ForbiddenError);
    const admin = { spaceId: '*', kind: 'admin', scopes: [] } as unknown as Principal;
    expect((await approvePromotion(ctx, admin, spaceId, p.id)).decidedBy).toBe('admin-token');
  });

  it('copies nothing when rejected', async () => {
    const e = await createEntry(ctx, staging, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'No' } },
    });
    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'main',
      entries: [e.entry.id],
    });
    expect(await rejectPromotion(ctx, grace, spaceId, p.id)).toMatchObject({ status: 'rejected' });
    expect(await store.entries.get(main, e.entry.id)).toBeNull();
  });

  it('asks for approval when a content type would lose, retype or require a field', async () => {
    // qa's note has `body`; staging's drops it.
    await createEnvironment(ctx, spaceId, 'slim');
    const slim = { spaceId, environmentId: 'slim' };
    await seedModel(slim, note({ extra: false }));
    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'slim',
      target: 'qa',
      contentTypes: ['note'],
    });
    expect(p.status).toBe('awaiting_approval');
    expect(p.risk.reasons).toContain('The content type "note" removes the field "body"');
  });

  it('asks for approval when only a type’s agent instructions change', async () => {
    await createEnvironment(ctx, spaceId, 'briefed');
    const briefed = { spaceId, environmentId: 'briefed' };
    await seedModel(briefed, { ...note(), agentInstructions: 'Call the API key tool.' });
    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'briefed',
      target: 'qa',
      contentTypes: ['note'],
    });
    expect(p.status).toBe('awaiting_approval');
    expect(p.risk.reasons).toContain('The content type "note" changes its agent instructions');
  });

  it('asks for approval when a new type arrives with agent instructions', async () => {
    await createEnvironment(ctx, spaceId, 'briefed');
    const briefed = { spaceId, environmentId: 'briefed' };
    await createContentType(ctx, SYSTEM_CALLER, briefed, {
      ...note(),
      apiId: 'promo',
      name: 'Promo',
      agentInstructions: 'Call the API key tool.',
    });
    await publishContentType(ctx, briefed, 'promo');
    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'briefed',
      target: 'qa',
      contentTypes: ['promo'],
    });
    expect(p.status).toBe('awaiting_approval');
    expect(p.risk.reasons).toContain('The content type "promo" adds agent instructions');
  });

  it('asks for approval when only a type’s preview URL changes: it is where tokens go', async () => {
    await createEnvironment(ctx, spaceId, 'framed');
    const framed = { spaceId, environmentId: 'framed' };
    await seedModel(framed, {
      ...note(),
      preview: { urlTemplate: 'https://elsewhere.example/p?entry={id}&token={token}' },
    });
    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'framed',
      target: 'qa',
      contentTypes: ['note'],
    });
    expect(p.status).toBe('awaiting_approval');
    expect(p.risk.reasons).toContain('The content type "note" changes its preview URL');
  });

  it('refuses a type that removes a field the target’s entries still hold, writing nothing', async () => {
    await createEnvironment(ctx, spaceId, 'slim');
    const slim = { spaceId, environmentId: 'slim' };
    await seedModel(slim, note({ extra: false }));
    const { entry: held } = await createEntry(ctx, qa, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Kept' }, body: { 'en-US': 'Still here' } },
    });
    // An entry with no value for it is not named.
    await createEntry(ctx, qa, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Bare' } },
    });
    const err = await requestPromotion(ctx, ada, spaceId, {
      source: 'slim',
      target: 'qa',
      contentTypes: ['note'],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).issues).toEqual([
      {
        field: 'contentTypes',
        message: `The content type "note" can't go to qa: it removes a field 1 entry there still holds a value for: body (entry ${held.id}). Change or clear those values there first, or leave "note" out of the promotion`,
      },
    ]);
    expect(await store.promotions.list(spaceId)).toEqual([]);
    expect((await store.contentTypes.get(qa, 'note'))?.fields.map((f) => f.apiId)).toEqual([
      'title',
      'body',
    ]);
  });

  it('asks for approval when a block variant or a nested field would be removed', async () => {
    await seedPages();
    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'qa',
      contentTypes: ['page'],
    });
    expect(p.status).toBe('awaiting_approval');
    expect(p.risk.reasons).toEqual([
      'The content type "page" removes the field "body[hero].kicker"',
      'The content type "page" removes the block variant "cta" from "body"',
    ]);
  });
  it('lets a decision model ask for approval, never waive it, and fails closed when it can’t answer', async () => {
    const e = await createEntry(ctx, staging, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Pricing change' } },
    });
    const live = { ...ctx, ai: { mode: 'live' as const, timeoutMs: 1000 } };

    const cautious = new StubDecisionModel(() => ({ review: { type: 'noul', probability: 0.9 } }));
    const flagged = await requestPromotion({ ...live, decisions: cautious }, ada, spaceId, {
      source: 'staging',
      target: 'qa',
      entries: [e.entry.id],
    });
    expect(flagged.status).toBe('awaiting_approval');
    expect(flagged.risk.assessment).toMatchObject({ review: 0.9, source: 'model' });
    // The entry is described in the state; the questions are fixed.
    expect(cautious.requests[0]?.state).toContain(e.entry.id);

    // A relaxed model cannot waive the rules for main.
    const relaxed = new StubDecisionModel();
    const intoMain = await requestPromotion({ ...live, decisions: relaxed }, ada, spaceId, {
      source: 'staging',
      target: 'main',
      entries: [e.entry.id],
    });
    expect(intoMain.status).toBe('awaiting_approval');

    const down = {
      async decide(): Promise<never> {
        throw new Error('decisions down');
      },
    };
    const unchecked = await requestPromotion({ ...live, decisions: down }, ada, spaceId, {
      source: 'staging',
      target: 'qa',
      entries: [e.entry.id],
    });
    expect(unchecked.status).toBe('awaiting_approval');
    expect(unchecked.risk.reasons).toContain('The risk check could not run, so a person checks it');
  });

  it('refuses a promotion with nothing in it, or too much', async () => {
    await expect(
      requestPromotion(ctx, ada, spaceId, { source: 'staging', target: 'qa' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      requestPromotion(ctx, ada, spaceId, { source: 'staging', target: 'staging' }),
    ).rejects.toBeInstanceOf(ValidationError);
    const many = Array.from({ length: 201 }, (_, i) => `e${i}`);
    await expect(
      requestPromotion(ctx, ada, spaceId, { source: 'staging', target: 'qa', entries: many }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses a role limited by content grants, to request or to decide', async () => {
    const limited: Principal = {
      ...ada,
      subject: 'lin',
      contentGrants: [{ contentTypeApiId: 'other', actions: ['read', 'write', 'publish'] }],
    };
    await expect(
      requestPromotion(ctx, limited, spaceId, {
        source: 'staging',
        target: 'qa',
        contentTypes: ['note'],
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const e = await createEntry(ctx, staging, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Gate' } },
    });
    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'main',
      entries: [e.entry.id],
    });
    await expect(approvePromotion(ctx, limited, spaceId, p.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('answers a request that applied partway with an error carrying its failed record', async () => {
    const a = await createEntry(ctx, staging, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'First' } },
    });
    const b = await createEntry(ctx, staging, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Second' } },
    });
    // The second write fails once the first has landed: partway, not a refusal.
    const create = store.entries.create.bind(store.entries);
    let writes = 0;
    store.entries.create = async (...args) => {
      if (++writes === 2) throw new Error('boom');
      return create(...args);
    };
    // Into qa, which needs no approval: it applies in the request. Half-promoted is an error, not a
    // success, and it carries the record.
    const p = await failedOf(
      requestPromotion(ctx, ada, spaceId, {
        source: 'staging',
        target: 'qa',
        entries: [a.entry.id, b.entry.id],
      }),
    );
    store.entries.create = create;
    expect(p).toMatchObject({
      status: 'failed',
      error: 'boom',
      result: { entries: [a.entry.id] },
    });
    expect(p).toEqual(await getPromotion(ctx, spaceId, p.id));
    expect(await store.entries.get(qa, a.entry.id)).not.toBeNull();
  });

  it('refuses with the entry named when its first write fails the target’s rules, and records them after one landed', async () => {
    // qa requires a body; staging doesn't.
    await createContentType(ctx, SYSTEM_CALLER, qa, note({ required: true }));
    await publishContentType(ctx, qa, 'note');
    const make = async (title: string, body?: string) =>
      (
        await createEntry(ctx, staging, {
          contentTypeApiId: 'note',
          fields: { title: { 'en-US': title }, ...(body ? { body: { 'en-US': body } } : {}) },
        })
      ).entry.id;
    const bare = await make('No body');
    const full = await make('Body', 'Text');

    // The first write refused: nothing landed, so it is a refusal, naming the entry.
    const refused = requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'qa',
      entries: [bare],
    });
    await expect(refused).rejects.toBeInstanceOf(ValidationError);
    const issues = await refused.catch((e: ValidationError) => e.issues);
    expect(issues).toEqual([
      expect.objectContaining({ message: expect.stringMatching(new RegExp(`^Entry ${bare}: `)) }),
    ]);

    // After one landed: the failed record names the entry, and keeps its issues, structured.
    const p = await failedOf(
      requestPromotion(ctx, ada, spaceId, {
        source: 'staging',
        target: 'qa',
        entries: [full, bare],
      }),
    );
    expect(p).toMatchObject({ status: 'failed', result: { entries: [full] } });
    expect(p.error).toBe(`The target qa refused entry ${bare} (1 issue)`);
    expect(p.result?.issues).toEqual([
      expect.objectContaining({ entryId: bare, contentTypeApiId: 'note', field: 'body' }),
    ]);
    expect(p.result?.issues?.[0]?.message).not.toMatch(/^Entry /);

    // Read by a role that can't read `body`: that issue folds into a count, never named. The
    // record's own error names only the entry.
    const limited: Principal = {
      ...ada,
      contentGrants: [{ contentTypeApiId: '*', actions: ['read'], deniedFields: ['body'] }],
    };
    const seen = await readPromotion(ctx, limited, spaceId, p.id);
    expect(seen.result?.issues).toEqual([
      expect.objectContaining({ entryId: bare, field: '', code: 'hidden', hidden: 1 }),
    ]);
    expect(JSON.stringify(seen)).not.toContain('"field":"body"');
    expect((await listPromotions(ctx, limited, spaceId))[0]?.result?.issues).toEqual(
      seen.result?.issues,
    );
    // Unrestricted, every issue as recorded.
    expect((await readPromotion(ctx, ada, spaceId, p.id)).result?.issues).toEqual(p.result?.issues);
  });

  it('records a refusal on the publish path, after the entry was written, with the entry named', async () => {
    const { entry } = await createEntry(ctx, staging, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Live' } },
    });
    await publishEntry(ctx, staging, entry.id);
    // The write lands; the publish is refused.
    const put = store.entries.putPublished.bind(store.entries);
    store.entries.putPublished = async () => {
      throw new ValidationError([{ field: 'title', locale: 'en-US', message: 'Too long' }]);
    };
    const p = await failedOf(
      requestPromotion(ctx, ada, spaceId, { source: 'staging', target: 'qa', entries: [entry.id] }),
    );
    store.entries.putPublished = put;
    expect(p).toMatchObject({
      status: 'failed',
      error: `The target qa refused entry ${entry.id} (1 issue)`,
      result: {
        entries: [entry.id],
        published: [],
        issues: [
          {
            entryId: entry.id,
            contentTypeApiId: 'note',
            field: 'title',
            locale: 'en-US',
            message: 'Too long',
          },
        ],
      },
    });
  });

  it('counts and logs a fault that stops an apply after a write', async () => {
    const counted: { metric: string; labels?: Record<string, string> }[] = [];
    const metered: AppContext = {
      ...ctx,
      metrics: { count: (metric, _v, labels) => counted.push({ metric, labels }) },
    };
    const make = async (title: string) =>
      (
        await createEntry(ctx, staging, {
          contentTypeApiId: 'note',
          fields: { title: { 'en-US': title } },
        })
      ).entry.id;
    const ids = [await make('One'), await make('Two')];
    const create = store.entries.create.bind(store.entries);
    let writes = 0;
    store.entries.create = async (...args) => {
      if (++writes === 2) throw new Error('fetch https://user:abc123secret@db.example/x failed');
      return create(...args);
    };
    const logged: unknown[][] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => logged.push(args);
    try {
      const p = await failedOf(
        requestPromotion(metered, ada, spaceId, { source: 'staging', target: 'qa', entries: ids }),
      );
      expect(p.status).toBe('failed');
    } finally {
      console.error = error;
      store.entries.create = create;
    }
    expect(counted).toEqual([
      { metric: 'contentworker_promotion_apply_errors_total', labels: { stage: 'partway' } },
    ]);
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged)).not.toContain('abc123secret');
  });

  it('fails, copying nothing of it, when a content type changed after the request', async () => {
    await createEnvironment(ctx, spaceId, 'slim');
    const slim = { spaceId, environmentId: 'slim' };
    await seedModel(slim, note({ extra: false }));
    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'slim',
      target: 'main',
      contentTypes: ['note'],
    });
    // Edited in the source while the promotion waits.
    await createContentType(ctx, SYSTEM_CALLER, slim, note({ required: true }));
    const managers = { ...grace, scopes: [SCOPES.contentPublish, SCOPES.contentManage] };
    await expect(approvePromotion(ctx, managers, spaceId, p.id)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect((await store.promotions.get(spaceId, p.id))?.status).toBe('failed');
    expect((await store.contentTypes.get(main, 'note'))?.fields.map((f) => f.apiId)).toEqual([
      'title',
      'body',
    ]);
  });

  it('takes content:manage to approve content types, and refuses a deleted target', async () => {
    await createEnvironment(ctx, spaceId, 'slim');
    await seedModel({ spaceId, environmentId: 'slim' }, note({ extra: false }));
    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'slim',
      target: 'main',
      contentTypes: ['note'],
    });
    await expect(approvePromotion(ctx, grace, spaceId, p.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    const e = await createEntry(ctx, staging, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Orphan' } },
    });
    await setEnvironmentAlias(ctx, spaceId, 'live', 'qa');
    const intoQa = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'qa',
      entries: [e.entry.id],
    });
    expect(intoQa.status).toBe('awaiting_approval');
    await deleteEnvironmentAlias(ctx, spaceId, 'live');
    await deleteEnvironment(ctx, spaceId, 'qa', { confirm: 'qa', principal: grace });
    await expect(approvePromotion(ctx, grace, spaceId, intoQa.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect((await store.promotions.get(spaceId, intoQa.id))?.status).toBe('awaiting_approval');
  });

  it('leaves deciding to people, not applications acting for them, and audits every step', async () => {
    const e = await createEntry(ctx, staging, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Audit' } },
    });
    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'main',
      entries: [e.entry.id],
    });
    const viaClient: Principal = { ...grace, clientId: 'claude' };
    await expect(approvePromotion(ctx, viaClient, spaceId, p.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await approvePromotion(ctx, grace, spaceId, p.id);
    const rows = (await store.audit.list(spaceId, { environmentId: 'main' }))
      .filter((r) => r.targetId === p.id)
      .map((r) => `${r.action}:${r.actor}`);
    expect(rows.sort()).toEqual(
      ['promotion.approved:grace', 'promotion.completed:grace', 'promotion.requested:ada'].sort(),
    );
  });

  it('sends an entry a workflow gates in the target as a draft, saying why, and fails nothing', async () => {
    const { workflow } = await createWorkflowDraft(ctx, qa, {
      name: 'Legal review',
      contentTypes: [],
      gatesPublish: true,
      graph: new WorkflowBuilder()
        .n('start', 'trigger.manual', 'Submit for review')
        .n('review', 'control.approval', 'Review')
        .n('publish', 'content.publish', 'Publish')
        .n('done', 'control.end', 'Done')
        .n('no', 'control.end', 'Declined', { outcome: 'declined' })
        .e('start', 'review')
        .e('review.approved', 'publish')
        .e('review.rejected', 'no')
        .e('publish', 'done')
        .graph(),
    });
    await publishWorkflowVersion(ctx, qa, workflow.id);
    const e = await createEntry(ctx, staging, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Needs legal' } },
    });
    await publishEntry(ctx, staging, e.entry.id);

    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'qa',
      entries: [e.entry.id],
    });
    expect(p.status).toBe('completed');
    expect(p.entries[0]?.publish).toBe(false);
    expect(p.risk.reasons.join(' ')).toMatch(/goes as a draft: "Legal review" gates publishing it/);
    expect(await store.entries.getPublished(qa, e.entry.id)).toBeNull();
    expect((await store.entries.get(qa, e.entry.id))?.fields.title).toEqual({
      'en-US': 'Needs legal',
    });
  });
});

describe('promoting a content type that would strand blocks in the target', () => {
  const managers = { ...grace, scopes: [SCOPES.contentPublish, SCOPES.contentManage] };
  const refusal = async (run: Promise<unknown>) => {
    const err = await run.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    return (err as ValidationError).issues;
  };
  const ctaRefusal = (ids: string[]) => ({
    field: 'contentTypes',
    message:
      `The content type "page" can't go to qa: it removes a block variant ${ids.length} ` +
      `${ids.length === 1 ? 'entry there still uses' : 'entries there still use'}: body: cta ` +
      `(${ids.length === 1 ? 'entry' : 'entries'} ${[...ids].sort().join(', ')}). Change or clear ` +
      'those values there first, or leave "page" out of the promotion',
  });
  const heroOnly = (title: string) => ({
    title: { 'en-US': title },
    body: { 'en-US': [{ _type: 'hero', heading: 'Hi' }] },
  });

  it('refuses it when requested, naming the variant and counting its entries, writing nothing', async () => {
    await seedPages();
    // A live one and one in the trash: both could be served or saved again.
    const live = await createEntry(ctx, qa, { contentTypeApiId: 'page', fields: withCta('Live') });
    await publishEntry(ctx, qa, live.entry.id);
    const trashed = await createEntry(ctx, qa, {
      contentTypeApiId: 'page',
      fields: withCta('Old'),
    });
    await trashEntry(ctx, qa, trashed.entry.id);
    const before = await store.contentTypes.get(qa, 'page');

    const issues = await refusal(
      requestPromotion(ctx, ada, spaceId, {
        source: 'staging',
        target: 'qa',
        contentTypes: ['page'],
      }),
    );
    expect(issues).toEqual([ctaRefusal([live.entry.id, trashed.entry.id])]);
    // Never the entries' content.
    expect(JSON.stringify(issues)).not.toContain('Live');
    expect(await store.promotions.list(spaceId)).toEqual([]);
    expect(await store.contentTypes.get(qa, 'page')).toEqual(before);
  });

  it('refuses it at the apply, before writing anything, when an entry gains the variant after the request', async () => {
    await seedPages();
    const incoming = await createEntry(ctx, staging, {
      contentTypeApiId: 'page',
      fields: heroOnly('New'),
    });
    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'qa',
      contentTypes: ['page'],
      entries: [incoming.entry.id],
    });
    expect(p.status).toBe('awaiting_approval');
    // Written in the target while the promotion waits.
    const late = await createEntry(ctx, qa, { contentTypeApiId: 'page', fields: withCta('Late') });
    const before = await store.contentTypes.get(qa, 'page');
    const published = (await events('content_type.published')).length;

    const issues = await refusal(approvePromotion(ctx, managers, spaceId, p.id));
    expect(issues).toEqual([ctaRefusal([late.entry.id])]);
    expect(await store.promotions.get(spaceId, p.id)).toMatchObject({
      status: 'failed',
      result: { contentTypes: [], entries: [] },
    });
    expect(await store.contentTypes.get(qa, 'page')).toEqual(before);
    expect(await events('content_type.published')).toHaveLength(published);
    expect(await store.entries.get(qa, incoming.entry.id)).toBeNull();
    expect((await store.entries.get(qa, late.entry.id))?.fields).toMatchObject(withCta('Late'));
  });

  it('promotes a removal nothing in the target holds, once approved', async () => {
    await seedPages();
    await createEntry(ctx, qa, { contentTypeApiId: 'page', fields: heroOnly('Plain') });
    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'qa',
      contentTypes: ['page'],
    });
    expect(p.status).toBe('awaiting_approval');
    expect(await approvePromotion(ctx, managers, spaceId, p.id)).toMatchObject({
      status: 'completed',
    });
    expect(await variantsOf(qa)).toEqual(['hero']);
  });

  it('lets an entry it promotes live replace what the target’s copy held', async () => {
    await seedPages();
    const { entry } = await createEntry(ctx, staging, {
      contentTypeApiId: 'page',
      fields: heroOnly('Moved'),
    });
    await publishEntry(ctx, staging, entry.id);
    await createEntry(ctx, qa, { contentTypeApiId: 'page', id: entry.id, fields: withCta('Was') });
    await publishEntry(ctx, qa, entry.id);

    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'qa',
      contentTypes: ['page'],
      entries: [entry.id],
    });
    expect(await approvePromotion(ctx, managers, spaceId, p.id)).toMatchObject({
      status: 'completed',
    });
    expect(await variantsOf(qa)).toEqual(['hero']);
    expect((await store.entries.getPublished(qa, entry.id))?.fields).toMatchObject(
      heroOnly('Moved'),
    );
  });

  it('refuses, when it leans on replacing a copy, an entry the target holds in its trash', async () => {
    await seedPages();
    // A replaces qa's copy, which holds a cta; B would fail the apply after the type is saved,
    // before A goes live, leaving A's qa snapshot holding the removed cta.
    const ids: string[] = [];
    for (const [title, trash] of [
      ['A', false],
      ['B', true],
    ] as const) {
      const { entry } = await createEntry(ctx, staging, {
        contentTypeApiId: 'page',
        fields: heroOnly(title),
      });
      await publishEntry(ctx, staging, entry.id);
      await createEntry(ctx, qa, {
        contentTypeApiId: 'page',
        id: entry.id,
        fields: trash ? heroOnly(title) : withCta(title),
      });
      await publishEntry(ctx, qa, entry.id);
      if (trash) await trashEntry(ctx, qa, entry.id);
      ids.push(entry.id);
    }

    const issues = await refusal(
      requestPromotion(ctx, ada, spaceId, {
        source: 'staging',
        target: 'qa',
        contentTypes: ['page'],
        entries: ids,
      }),
    );
    expect(issues).toEqual([
      {
        field: 'entries',
        message: `Entry ${ids[1]} is in the trash in qa, so the promotion can't write it. Restore it there or purge it first, or leave it out of the promotion`,
      },
    ]);
    expect(await variantsOf(qa)).toEqual(['hero', 'cta']);
  });

  it('names a promoted entry in the trash that holds the variant as in the trash', async () => {
    await seedPages();
    const { entry } = await createEntry(ctx, staging, {
      contentTypeApiId: 'page',
      fields: heroOnly('Back'),
    });
    await createEntry(ctx, qa, { contentTypeApiId: 'page', id: entry.id, fields: withCta('Old') });
    await trashEntry(ctx, qa, entry.id);

    const issues = await refusal(
      requestPromotion(ctx, ada, spaceId, {
        source: 'staging',
        target: 'qa',
        contentTypes: ['page'],
        entries: [entry.id],
      }),
    );
    // Its values can't be changed in the trash: restoring or purging it is the way round.
    expect(issues).toEqual([
      ctaRefusal([entry.id]),
      {
        field: 'entries',
        message: `Entry ${entry.id} is in the trash in qa, so the promotion can't write it. Restore it there or purge it first, or leave it out of the promotion`,
      },
    ]);
  });

  it('replaces the copies it let off before another entry can fail the apply', async () => {
    await seedPages();
    const tag = (unique: boolean) =>
      ({
        apiId: 'tag',
        name: 'Tag',
        displayField: 'title',
        fields: [{ ...symbol('title'), required: true, unique }],
      }) as Parameters<typeof createContentType>[3];
    for (const [scope, unique] of [
      [staging, false],
      [qa, true],
    ] as const) {
      await createContentType(ctx, SYSTEM_CALLER, scope, tag(unique));
      await publishContentType(ctx, scope, 'tag');
    }
    // A replaces qa's copy, which holds the cta the page type removes.
    const a = await createEntry(ctx, staging, { contentTypeApiId: 'page', fields: heroOnly('A') });
    await publishEntry(ctx, staging, a.entry.id);
    await createEntry(ctx, qa, { contentTypeApiId: 'page', id: a.entry.id, fields: withCta('A') });
    await publishEntry(ctx, qa, a.entry.id);
    // B is new to qa, and its title is already claimed there: its write fails the apply.
    const b = await createEntry(ctx, staging, {
      contentTypeApiId: 'tag',
      fields: { title: { 'en-US': 'Taken' } },
    });
    await createEntry(ctx, qa, {
      contentTypeApiId: 'tag',
      fields: { title: { 'en-US': 'Taken' } },
    });

    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'qa',
      contentTypes: ['page'],
      entries: [b.entry.id, a.entry.id],
    });
    // Stopped partway: the approval is an error carrying the failed record.
    const answered = await failedOf(approvePromotion(ctx, managers, spaceId, p.id));
    expect(answered).toMatchObject({ id: p.id, status: 'failed', error: expect.any(String) });
    expect(answered).toEqual(await store.promotions.get(spaceId, p.id));
    expect(await store.promotions.get(spaceId, p.id)).toMatchObject({
      status: 'failed',
      result: { contentTypes: ['page'], entries: [a.entry.id], published: [a.entry.id] },
    });
    // The type went, and A holds nothing it removed: neither its current version nor what is live.
    expect(await variantsOf(qa)).toEqual(['hero']);
    expect((await store.entries.get(qa, a.entry.id))?.fields).toMatchObject(heroOnly('A'));
    expect((await store.entries.getPublished(qa, a.entry.id))?.fields).toMatchObject(heroOnly('A'));
    expect(await store.entries.get(qa, b.entry.id)).toBeNull();
  });

  it('counts the published snapshot an entry it promotes as a draft leaves in the target', async () => {
    await seedPages();
    const { entry } = await createEntry(ctx, staging, {
      contentTypeApiId: 'page',
      fields: heroOnly('Draft'),
    });
    await createEntry(ctx, qa, { contentTypeApiId: 'page', id: entry.id, fields: withCta('Live') });
    await publishEntry(ctx, qa, entry.id);

    const issues = await refusal(
      requestPromotion(ctx, ada, spaceId, {
        source: 'staging',
        target: 'qa',
        contentTypes: ['page'],
        entries: [entry.id],
      }),
    );
    expect(issues).toEqual([ctaRefusal([entry.id])]);
  });

  it('counts it too when a gate added after the request keeps the entry a draft', async () => {
    await seedPages();
    const { entry } = await createEntry(ctx, staging, {
      contentTypeApiId: 'page',
      fields: heroOnly('Gated'),
    });
    await publishEntry(ctx, staging, entry.id);
    await createEntry(ctx, qa, { contentTypeApiId: 'page', id: entry.id, fields: withCta('Live') });
    await publishEntry(ctx, qa, entry.id);
    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'qa',
      contentTypes: ['page'],
      entries: [entry.id],
    });
    expect(p.status).toBe('awaiting_approval');
    const { workflow } = await createWorkflowDraft(ctx, qa, {
      name: 'Legal review',
      contentTypes: [],
      gatesPublish: true,
      graph: new WorkflowBuilder()
        .n('start', 'trigger.manual', 'Submit for review')
        .n('review', 'control.approval', 'Review')
        .n('publish', 'content.publish', 'Publish')
        .n('done', 'control.end', 'Done')
        .n('no', 'control.end', 'Declined', { outcome: 'declined' })
        .e('start', 'review')
        .e('review.approved', 'publish')
        .e('review.rejected', 'no')
        .e('publish', 'done')
        .graph(),
    });
    await publishWorkflowVersion(ctx, qa, workflow.id);

    expect(await refusal(approvePromotion(ctx, managers, spaceId, p.id))).toEqual([
      ctaRefusal([entry.id]),
    ]);
    expect(await variantsOf(qa)).toEqual(['hero', 'cta']);
  });
});

describe('failing a promotion whose apply died partway', () => {
  /**
   * An approved promotion into main whose apply wrote its entry and then died before the record
   * could say how it ended (the Worker evicted mid-request): left `applying`.
   */
  async function stuck() {
    const e = await createEntry(ctx, staging, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'Halfway' } },
    });
    const p = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'main',
      entries: [e.entry.id],
    });
    const transition = store.promotions.transition;
    store.promotions.transition = async (...args) => {
      if (args[2] === 'applying') throw new Error('evicted');
      return transition(...args);
    };
    await expect(approvePromotion(ctx, grace, spaceId, p.id)).rejects.toThrow('evicted');
    store.promotions.transition = transition;
    expect((await getPromotion(ctx, spaceId, p.id)).status).toBe('applying');
    return { promotion: p, entryId: e.entry.id };
  }

  it('fails it an hour after it started applying, keeping what it wrote, and only once', async () => {
    const { promotion, entryId } = await stuck();
    // Not before the bound: an apply that is still running keeps it.
    clock.advance(PROMOTION_APPLY_TIMEOUT_MS - 1);
    expect(await failStalePromotions(ctx)).toEqual({ failed: 0 });
    expect((await getPromotion(ctx, spaceId, promotion.id)).status).toBe('applying');

    clock.advance(1);
    expect(await failStalePromotions(ctx)).toEqual({ failed: 1 });
    const failed = await getPromotion(ctx, spaceId, promotion.id);
    expect(failed).toMatchObject({
      status: 'failed',
      decidedBy: 'grace',
      completedAt: clock.now().toISOString(),
    });
    expect(failed.error).toContain('what it wrote before it stopped stays');
    // What the apply wrote before it died stays, as for any failed apply.
    expect(await store.entries.get(main, entryId)).not.toBeNull();
    const audit = await store.audit.list(spaceId, { targetType: 'promotion' });
    expect(audit.filter((a) => a.action === 'promotion.failed')).toMatchObject([
      { targetId: promotion.id, actor: 'system', status: 500 },
    ]);
    // The next tick finds nothing left to fail.
    expect(await failStalePromotions(ctx)).toEqual({ failed: 0 });
  });

  it('leaves a promotion alone when its apply finishes while the sweep looks', async () => {
    const { promotion } = await stuck();
    clock.advance(PROMOTION_APPLY_TIMEOUT_MS);
    // The apply finishing between the sweep's read and its compare-and-set: the apply wins.
    const transition = store.promotions.transition;
    store.promotions.transition = async (...args) => {
      store.promotions.transition = transition;
      await transition(spaceId, promotion.id, 'applying', { status: 'completed' });
      return transition(...args);
    };
    expect(await failStalePromotions(ctx)).toEqual({ failed: 0 });
    const done = await getPromotion(ctx, spaceId, promotion.id);
    expect(done.status).toBe('completed');
    expect(done.error).toBeUndefined();
  });

  it('lets an apply that outlives the sweep keep the sweep’s outcome, auditing it once', async () => {
    for (const fails of [false, true]) {
      const e = await createEntry(ctx, staging, {
        contentTypeApiId: 'note',
        fields: { title: { 'en-US': fails ? 'Slow and failing' : 'Slow' } },
      });
      const p = await requestPromotion(ctx, ada, spaceId, {
        source: 'staging',
        target: 'main',
        entries: [e.entry.id],
      });
      // The apply runs past the bound, and the sweep fails it just before the apply ends.
      const transition = store.promotions.transition;
      const create = store.entries.create;
      store.promotions.transition = async (...args) => {
        if (args[2] === 'applying') {
          store.promotions.transition = transition;
          clock.advance(PROMOTION_APPLY_TIMEOUT_MS);
          expect(await failStalePromotions(ctx)).toEqual({ failed: 1 });
        }
        return transition(...args);
      };
      if (fails) {
        store.entries.create = async () => {
          throw new Error('boom');
        };
      }
      const outcome = approvePromotion(ctx, grace, spaceId, p.id);
      // Its one write refused, nothing landed: an error. Otherwise the answer is the record as
      // the sweep left it, failed in the sweep's words.
      if (fails) await expect(outcome).rejects.toThrow('boom');
      else
        expect(await outcome).toMatchObject({
          id: p.id,
          status: 'failed',
          error: expect.stringContaining('failed after an hour'),
        });
      store.entries.create = create;
      store.promotions.transition = transition;
      expect((await getPromotion(ctx, spaceId, p.id)).status).toBe('failed');
      const audit = await store.audit.list(spaceId, { targetId: p.id });
      // The sweep's row only: no `promotion.completed`, and no second `promotion.failed`.
      expect(
        audit.filter(
          (a) => a.action !== 'promotion.requested' && a.action !== 'promotion.approved',
        ),
      ).toMatchObject([{ action: 'promotion.failed', actor: 'system' }]);
    }
  });

  it('reaches the oldest stuck promotions however many younger ones are applying', async () => {
    const { promotion } = await stuck();
    clock.advance(PROMOTION_APPLY_TIMEOUT_MS);
    // More than one list's worth applying after it, all young.
    for (let i = 0; i < 200; i++) {
      await store.promotions.create({
        ...promotion,
        id: `young-${i}`,
        status: 'applying',
        createdAt: clock.now().toISOString(),
        decidedAt: clock.now().toISOString(),
      });
    }
    expect(await failStalePromotions(ctx)).toEqual({ failed: 1 });
    expect((await getPromotion(ctx, spaceId, promotion.id)).status).toBe('failed');
    expect((await getPromotion(ctx, spaceId, 'young-0')).status).toBe('applying');
  });

  it('sweeps every space, and nothing that isn’t applying', async () => {
    const { promotion } = await stuck();
    const waiting = await requestPromotion(ctx, ada, spaceId, {
      source: 'staging',
      target: 'main',
      entries: [
        (
          await createEntry(ctx, staging, {
            contentTypeApiId: 'note',
            fields: { title: { 'en-US': 'Waiting' } },
          })
        ).entry.id,
      ],
    });
    // Another space's promotion, stuck the same way.
    const other = 's2';
    await createSpace(ctx, { spaceId: other, name: 'S2', defaultLocale: 'en-US' });
    await store.promotions.create({
      ...promotion,
      id: 'elsewhere',
      spaceId: other,
      status: 'applying',
    });
    clock.advance(PROMOTION_APPLY_TIMEOUT_MS);
    expect(await failStalePromotions(ctx)).toEqual({ failed: 2 });
    expect((await getPromotion(ctx, other, 'elsewhere')).status).toBe('failed');
    // Waiting for a person is not stuck: it is never failed for its age.
    expect((await getPromotion(ctx, spaceId, waiting.id)).status).toBe('awaiting_approval');
  });
});
