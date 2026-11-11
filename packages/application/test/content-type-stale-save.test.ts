import { ConflictError, type ContentTypeDraft } from '@contentworker/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  getContentType,
  SYSTEM_CALLER,
  updateContentType,
} from '../src/index';

const scope = { spaceId: 's1', environmentId: 'main' };
const other = { spaceId: 's1', environmentId: 'staging' };

const draft = (over: Partial<ContentTypeDraft> = {}): ContentTypeDraft => ({
  apiId: 'article',
  name: 'Article',
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
  ...over,
});

let ctx: AppContext;
let store: InMemoryContentStore;

beforeEach(async () => {
  store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 's1', defaultLocale: 'en', locales: ['en'] });
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('t') };
  await createContentType(ctx, SYSTEM_CALLER, scope, draft({ group: 'Editorial' }));
  // Someone else's save lands after the caller read version 1.
  await createContentType(ctx, SYSTEM_CALLER, scope, draft({ description: 'Theirs' }));
});

const conflictOf = async (p: Promise<unknown>): Promise<ConflictError> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConflictError);
  return err as ConflictError;
};

describe('a content type save held to the version its caller read', () => {
  it('refuses a stale save, naming the stored version, with nothing written', async () => {
    const before = store.allEvents().length;
    const err = await conflictOf(
      createContentType(ctx, SYSTEM_CALLER, scope, draft({ description: 'Mine' }), {
        expectedVersion: 1,
      }),
    );
    expect(err.code).toBe('conflict');
    expect(err.details).toEqual({ version: 2, expectedVersion: 1 });
    const stored = await getContentType(ctx, scope, 'article');
    expect(stored.version).toBe(2);
    expect(stored.description).toBe('Theirs');
    expect(store.allEvents().length).toBe(before);
  });

  it('refuses before any other check: a stale save that would also be invalid is a 409', async () => {
    await conflictOf(
      updateContentType(
        ctx,
        SYSTEM_CALLER,
        scope,
        'article',
        { displayField: 'nope' },
        { expectedVersion: 1 },
      ),
    );
  });

  it('saves over the version it read', async () => {
    const saved = await createContentType(
      ctx,
      SYSTEM_CALLER,
      scope,
      draft({ description: 'Mine' }),
      { expectedVersion: 2 },
    );
    expect(saved.version).toBe(3);
    expect((await getContentType(ctx, scope, 'article')).description).toBe('Mine');
  });

  it('saves over whatever is stored without one, as before', async () => {
    const saved = await updateContentType(ctx, SYSTEM_CALLER, scope, 'article', { name: 'Post' });
    expect(saved.version).toBe(3);
  });

  it('takes 0 as "read as not existing": a create only, refused over a type someone made', async () => {
    const made = await createContentType(ctx, SYSTEM_CALLER, scope, draft({ apiId: 'page' }), {
      expectedVersion: 0,
    });
    expect(made.version).toBe(1);
    const err = await conflictOf(
      createContentType(ctx, SYSTEM_CALLER, scope, draft({ apiId: 'page' }), {
        expectedVersion: 0,
      }),
    );
    expect(err.details).toEqual({ version: 1, expectedVersion: 0 });
  });

  it('refuses a save from a read of a type that is gone, rather than making it again', async () => {
    const err = await conflictOf(
      createContentType(ctx, SYSTEM_CALLER, scope, draft({ apiId: 'gone' }), {
        expectedVersion: 3,
      }),
    );
    expect(err.details).toEqual({ version: 0, expectedVersion: 3 });
    await expect(getContentType(ctx, scope, 'gone')).rejects.toThrow();
  });

  it('judges the version in the caller’s scope only', async () => {
    // Another environment's type of the same apiId is at version 1: it says nothing about main's.
    await createContentType(ctx, SYSTEM_CALLER, other, draft());
    await conflictOf(createContentType(ctx, SYSTEM_CALLER, scope, draft(), { expectedVersion: 1 }));
    const saved = await createContentType(ctx, SYSTEM_CALLER, other, draft({ name: 'Story' }), {
      expectedVersion: 1,
    });
    expect(saved.version).toBe(2);
  });
});
