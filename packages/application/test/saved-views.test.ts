import {
  ConflictError,
  type FieldDefinition,
  ForbiddenError,
  MAX_PERSONAL_VIEWS,
  NotFoundError,
  type Principal,
  SCOPES,
  ValidationError,
} from '@contentworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  createEnvironment,
  createSavedView,
  createSpace,
  deleteSavedView,
  getSavedView,
  listSavedViews,
  publishContentType,
  runSavedView,
  updateSavedView,
} from '../src/index';

const scope = { spaceId: 'site', environmentId: 'main' };
const staging = { spaceId: 'site', environmentId: 'staging' };
const otherSpace = { spaceId: 'other', environmentId: 'main' };

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

const READ = [SCOPES.previewRead];
const MANAGE = [SCOPES.previewRead, SCOPES.contentManage];

const person = (
  subject: string,
  scopes: readonly string[] = READ,
  contentGrants?: Principal['contentGrants'],
): Principal => ({
  spaceId: 'site',
  kind: 'user',
  subject,
  scopes,
  ...(contentGrants ? { contentGrants } : {}),
});

const ada = person('ada@example.com', MANAGE);
const bob = person('bob@example.com');
const key: Principal = { spaceId: 'site', kind: 'cma', scopes: MANAGE };

const refusal = async (p: Promise<unknown>): Promise<string[]> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof ValidationError))
    throw new Error(`expected a ValidationError, got ${String(err)}`);
  return err.issues.map((i) => `${i.field}: ${i.message}`);
};

describe('saved views', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    ctx = {
      store: new InMemoryContentStore(),
      clock: new FixedClock(),
      ids: new SequenceIdGenerator('v'),
    };
    await createSpace(ctx, { spaceId: 'site', name: 'Site', defaultLocale: 'en-US' });
    await createSpace(ctx, { spaceId: 'other', name: 'Other', defaultLocale: 'en-US' });
    await createEnvironment(ctx, 'site', 'staging');
    await createContentType(ctx, scope, {
      apiId: 'article',
      name: 'Article',
      displayField: 'title',
      fields: [
        field({ apiId: 'title', type: 'Symbol' }),
        field({ apiId: 'section', type: 'Symbol', position: 1 }),
        field({ apiId: 'salary', type: 'Integer', position: 2 }),
      ],
    });
    await createContentType(ctx, scope, {
      apiId: 'page',
      name: 'Page',
      displayField: 'title',
      fields: [field({ apiId: 'title', type: 'Symbol' })],
    });
    await publishContentType(ctx, scope, 'article');
    await publishContentType(ctx, scope, 'page');
    for (const [title, section, salary] of [
      ['Alpha', 'news', 10],
      ['Beta', 'news', 20],
      ['Gamma', 'sport', 30],
    ] as const) {
      await createEntry(ctx, scope, {
        contentTypeApiId: 'article',
        fields: {
          title: { 'en-US': title },
          section: { 'en-US': section },
          salary: { 'en-US': salary },
        },
      });
    }
    await createEntry(ctx, scope, {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': 'About' } },
    });
  });

  const titles = (run: { items: readonly { fields: Record<string, unknown> }[] }) =>
    run.items.map((e) => (e.fields.title as Record<string, string>)['en-US']);

  it('stores the structured query and columns, and runs it through the entries query', async () => {
    const view = await createSavedView(ctx, scope, bob, {
      name: ' News, newest first ',
      contentTypeApiId: 'article',
      query: {
        filters: [{ field: 'fields.section', op: 'eq', value: 'news' }],
        where: {
          or: [
            { field: 'title', op: 'startsWith', value: 'A' },
            { field: 'salary', op: 'gte', value: 20 },
          ],
        },
        order: [{ field: 'fields.title', direction: 'desc' }],
      },
      columns: ['section', 'sys.status'],
    });
    expect(view).toMatchObject({
      name: 'News, newest first',
      visibility: 'personal',
      createdBy: 'bob@example.com',
      contentTypeApiId: 'article',
      // The `fields.` prefix is the query string's spelling: the stored form names the field.
      query: {
        filters: [{ field: 'section', op: 'eq', value: 'news' }],
        order: [{ field: 'title', direction: 'desc' }],
      },
      columns: ['section', 'sys.status'],
      revision: 1,
    });
    expect(await getSavedView(ctx, scope, bob, view.id)).toEqual(view);
    const run = await runSavedView(ctx, scope, bob, view.id);
    expect(titles(run)).toEqual(['Beta', 'Alpha']);
    expect(run.view).toMatchObject({ id: view.id, columns: ['section', 'sys.status'] });
    expect(run.ignored).toBeUndefined();
  });

  it('refuses a stored query a live query would refuse, strictly', async () => {
    const bad = (query: unknown) =>
      refusal(createSavedView(ctx, scope, bob, { name: 'x', contentTypeApiId: 'article', query }));
    expect(await bad({ filters: [{ field: 'title', op: 'match', value: '' }] })).toEqual([
      'query.filters[0]: match takes a non-empty string',
    ]);
    expect(await bad({ filters: [{ field: 'title', op: 'near', value: 'x' }] })).toEqual([
      expect.stringContaining('query.filters[0]: op must be one of'),
    ]);
    expect(await bad({ where: { and: [] } })).toEqual([
      'query.where.and: expected a non-empty array',
    ]);
    expect(await bad({ order: [{ field: 'title; drop', direction: 'asc' }] })).toEqual([
      'query.order[0]: "title; drop" is not a field a sort can name',
    ]);
    expect(await bad({ filters: [{ field: 'title', op: 'eq', value: { $gt: 1 } }] })).toEqual([
      'query.filters[0]: a value is a string, number, boolean or a list of them',
    ]);
    // A misspelt key is refused rather than kept: only `extra` keeps what isn't understood.
    expect(await bad({ fitlers: [] })).toEqual([
      'query: query holds only filters, where, order, search, extra; not fitlers',
    ]);
    expect(
      await refusal(
        createSavedView(ctx, scope, bob, {
          name: 'x',
          contentTypeApiId: 'article',
          columns: ['nope'],
        }),
      ),
    ).toEqual(['columns[0]: article has no field "nope"']);
    expect(
      await refusal(createSavedView(ctx, scope, bob, { name: 'x', columns: ['title'] })),
    ).toEqual(['columns[0]: a view over every type shows only sys.status, sys.updatedAt']);
    expect(
      await refusal(createSavedView(ctx, scope, bob, { name: 'x', contentTypeApiId: 'ghost' })),
    ).toEqual(['contentTypeApiId: No content type "ghost" in this environment']);
  });

  it('keeps unknown query keys verbatim under extra, and says a run left them out', async () => {
    const view = await createSavedView(ctx, scope, bob, {
      name: 'Mine',
      contentTypeApiId: 'article',
      query: { extra: { 'sys.createdBy': 'me' } },
    });
    expect(view.query.extra).toEqual({ 'sys.createdBy': 'me' });
    const renamed = await updateSavedView(ctx, scope, bob, view.id, { name: 'Mine, renamed' });
    expect(renamed.query.extra).toEqual({ 'sys.createdBy': 'me' });
    const run = await runSavedView(ctx, scope, bob, view.id);
    expect(run.ignored).toEqual(['sys.createdBy']);
    expect(run.items).toHaveLength(3);
  });

  it('shows a personal view to its owner only: anyone else gets a 404', async () => {
    const view = await createSavedView(ctx, scope, bob, {
      name: 'Bob’s',
      contentTypeApiId: 'article',
    });
    expect((await listSavedViews(ctx, scope, bob)).map((v) => v.id)).toEqual([view.id]);
    expect(await listSavedViews(ctx, scope, ada)).toEqual([]);
    expect(await listSavedViews(ctx, scope, key)).toEqual([]);
    for (const p of [ada, key]) {
      await expect(getSavedView(ctx, scope, p, view.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(runSavedView(ctx, scope, p, view.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        updateSavedView(ctx, scope, p, view.id, { name: 'taken' }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(deleteSavedView(ctx, scope, p, view.id)).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it('is the space’s: every environment sees it, another space never does', async () => {
    const view = await createSavedView(ctx, scope, ada, {
      name: 'All',
      visibility: 'shared',
    });
    expect((await listSavedViews(ctx, staging, bob)).map((v) => v.id)).toEqual([view.id]);
    expect(await listSavedViews(ctx, otherSpace, { ...bob, spaceId: 'other' })).toEqual([]);
    await expect(getSavedView(ctx, otherSpace, ada, view.id)).rejects.toBeInstanceOf(NotFoundError);
    // Run in staging, it lists staging's entries: none.
    expect((await runSavedView(ctx, staging, bob, view.id)).items).toEqual([]);
  });

  it('needs content:manage to create, change, share or delete a shared view', async () => {
    await expect(
      createSavedView(ctx, scope, bob, { name: 'Team', visibility: 'shared' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const mine = await createSavedView(ctx, scope, bob, { name: 'Mine' });
    await expect(
      updateSavedView(ctx, scope, bob, mine.id, { visibility: 'shared' }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const shared = await createSavedView(ctx, scope, ada, { name: 'Team', visibility: 'shared' });
    expect((await listSavedViews(ctx, scope, bob)).map((v) => v.name)).toEqual(['Mine', 'Team']);
    await expect(
      updateSavedView(ctx, scope, bob, shared.id, { name: 'Hijacked' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteSavedView(ctx, scope, bob, shared.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    // A key saves shared views only: it has no person to own a personal one.
    expect(await refusal(createSavedView(ctx, scope, key, { name: 'K' }))).toEqual([
      'visibility: Only a person has personal views; an API key saves shared views',
    ]);
    const byKey = await createSavedView(ctx, scope, key, { name: 'K', visibility: 'shared' });
    expect(byKey.createdBy).toBe('cma');

    // Unsharing makes it the unsharer's own.
    const unshared = await updateSavedView(ctx, scope, ada, shared.id, { visibility: 'personal' });
    expect(unshared.createdBy).toBe('ada@example.com');
    await expect(getSavedView(ctx, scope, bob, shared.id)).rejects.toBeInstanceOf(NotFoundError);
    await deleteSavedView(ctx, scope, ada, shared.id);
    await expect(getSavedView(ctx, scope, ada, shared.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('runs a shared view with the viewer’s grants, never the creator’s', async () => {
    const view = await createSavedView(ctx, scope, ada, {
      name: 'Everything',
      visibility: 'shared',
      query: { order: [{ field: 'sys.updatedAt', direction: 'asc' }] },
    });
    expect(await runSavedView(ctx, scope, ada, view.id).then(titles)).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
      'About',
    ]);
    // Pages only: the view over every type lists no article for this viewer.
    const pagesOnly = person('pat@example.com', READ, [
      { contentTypeApiId: 'page', actions: ['read'] },
    ]);
    expect(await runSavedView(ctx, scope, pagesOnly, view.id).then(titles)).toEqual(['About']);
    // Salary hidden: the rows come back with it masked.
    const noSalary = person('nia@example.com', READ, [
      { contentTypeApiId: '*', actions: ['read'], deniedFields: ['salary'] },
    ]);
    const masked = await runSavedView(ctx, scope, noSalary, view.id);
    expect(masked.items.length).toBe(4);
    expect(masked.items.every((e) => !('salary' in e.fields))).toBe(true);
  });

  it('skips a view over a type the viewer can’t read, or naming a field their role hides', async () => {
    const bySalary = await createSavedView(ctx, scope, ada, {
      name: 'Well paid',
      contentTypeApiId: 'article',
      visibility: 'shared',
      query: { filters: [{ field: 'salary', op: 'gt', value: 15 }] },
    });
    const sortedBySalary = await createSavedView(ctx, scope, ada, {
      name: 'By pay',
      contentTypeApiId: 'article',
      visibility: 'shared',
      query: {
        where: {
          or: [
            { field: 'title', op: 'exists' },
            { field: 'salary', op: 'lt', value: 1 },
          ],
        },
      },
    });
    const plain = await createSavedView(ctx, scope, ada, {
      name: 'Articles',
      contentTypeApiId: 'article',
      visibility: 'shared',
      columns: ['salary', 'section'],
    });
    const pages = await createSavedView(ctx, scope, ada, {
      name: 'Pages',
      contentTypeApiId: 'page',
      visibility: 'shared',
    });
    const noSalary = person('nia@example.com', READ, [
      { contentTypeApiId: '*', actions: ['read'], deniedFields: ['salary'] },
    ]);
    // A filter or a `where` predicate over the hidden field: the view isn't there for them.
    expect((await listSavedViews(ctx, scope, noSalary)).map((v) => v.name)).toEqual([
      'Articles',
      'Pages',
    ]);
    for (const id of [bySalary.id, sortedBySalary.id]) {
      await expect(getSavedView(ctx, scope, noSalary, id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(runSavedView(ctx, scope, noSalary, id)).rejects.toBeInstanceOf(NotFoundError);
    }
    // A hidden column is left out of the view they're shown.
    expect((await getSavedView(ctx, scope, noSalary, plain.id)).columns).toEqual(['section']);
    // A type they can't read: none of its views.
    const articlesOnly = person('art@example.com', READ, [
      { contentTypeApiId: 'article', actions: ['read'] },
    ]);
    expect((await listSavedViews(ctx, scope, articlesOnly)).map((v) => v.id)).not.toContain(
      pages.id,
    );
    expect(
      (await listSavedViews(ctx, scope, articlesOnly, { contentTypeApiId: 'page' })).map(
        (v) => v.id,
      ),
    ).toEqual([]);
    // And they can't save one that names the field either.
    await expect(
      createSavedView(ctx, scope, noSalary, {
        name: 'Sneaky',
        contentTypeApiId: 'article',
        query: { order: [{ field: 'salary', direction: 'desc' }] },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses a stale revision, and applies a change without one to the view as it stands', async () => {
    const view = await createSavedView(ctx, scope, bob, { name: 'One' });
    const two = await updateSavedView(ctx, scope, bob, view.id, { name: 'Two', revision: 1 });
    expect(two.revision).toBe(2);
    await expect(
      updateSavedView(ctx, scope, bob, view.id, { name: 'Late', revision: 1 }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(deleteSavedView(ctx, scope, bob, view.id, 1)).rejects.toBeInstanceOf(
      ConflictError,
    );
    const three = await updateSavedView(ctx, scope, bob, view.id, { columns: ['sys.status'] });
    expect(three).toMatchObject({ name: 'Two', columns: ['sys.status'], revision: 3 });
    const back = await updateSavedView(ctx, scope, bob, view.id, { columns: null });
    expect(back.columns).toBeUndefined();
    await deleteSavedView(ctx, scope, bob, view.id, 4);
    expect(await listSavedViews(ctx, scope, bob)).toEqual([]);
  });

  it('caps the personal views a person keeps', async () => {
    for (let i = 0; i < MAX_PERSONAL_VIEWS; i++) {
      await createSavedView(ctx, scope, bob, { name: `View ${i}` });
    }
    expect(await refusal(createSavedView(ctx, scope, bob, { name: 'One more' }))).toEqual([
      `visibility: A person keeps at most ${MAX_PERSONAL_VIEWS} personal views in a space`,
    ]);
    // Someone else's cap is their own.
    await createSavedView(ctx, scope, ada, { name: 'Ada’s first' });
  });
});
