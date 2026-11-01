import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  cancelScheduledAction,
  createContentType,
  createEntry,
  getPublishedEntry,
  publishContentType,
  runDueScheduledActions,
  scheduleAction,
} from '../src/index';

const scope = { spaceId: 'space-1', environmentId: 'main' };
const T0 = '2026-01-01T00:00:00.000Z';

function makeContext(): { ctx: AppContext; clock: FixedClock } {
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: 'space-1', defaultLocale: 'en-US', locales: ['en-US'] });
  const clock = new FixedClock(new Date(T0));
  return { ctx: { store, clock, ids: new SequenceIdGenerator('e') }, clock };
}

async function seedDraft(ctx: AppContext, title: string) {
  await createContentType(ctx, scope, {
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
  });
  await publishContentType(ctx, scope, 'article');
  return createEntry(ctx, scope, {
    contentTypeApiId: 'article',
    fields: { title: { 'en-US': title } },
  });
}

describe('scheduled publishing', () => {
  let ctx: AppContext;
  let clock: FixedClock;
  beforeEach(() => {
    ({ ctx, clock } = makeContext());
  });

  it('does not fire an action before its time, then publishes once due', async () => {
    const entry = await seedDraft(ctx, 'Scheduled');
    await scheduleAction(ctx, scope, {
      action: 'publish',
      entityType: 'Entry',
      entityId: entry.entry.id,
      scheduledFor: '2026-01-01T01:00:00.000Z',
    });

    // Not yet due — runDue is a no-op and the entry stays unpublished.
    expect(await runDueScheduledActions(ctx)).toEqual({ executed: 0, failed: 0 });
    await expect(getPublishedEntry(ctx, scope, entry.entry.id)).rejects.toThrow(/not.*found/i);

    // Advance past the scheduled instant; now it fires.
    clock.advance(60 * 60 * 1000);
    expect(await runDueScheduledActions(ctx)).toEqual({ executed: 1, failed: 0 });
    expect((await getPublishedEntry(ctx, scope, entry.entry.id)).fields.title?.['en-US']).toBe(
      'Scheduled',
    );

    // Idempotent: the completed action does not re-run.
    expect(await runDueScheduledActions(ctx)).toEqual({ executed: 0, failed: 0 });
    const [action] = await ctx.store.scheduledActions.list(scope);
    expect(action?.status).toBe('completed');
  });

  it('a canceled action never fires', async () => {
    const entry = await seedDraft(ctx, 'Canceled');
    const action = await scheduleAction(ctx, scope, {
      action: 'publish',
      entityType: 'Entry',
      entityId: entry.entry.id,
      scheduledFor: '2026-01-01T01:00:00.000Z',
    });
    await cancelScheduledAction(ctx, scope, action.id);

    clock.advance(2 * 60 * 60 * 1000);
    expect(await runDueScheduledActions(ctx)).toEqual({ executed: 0, failed: 0 });
    await expect(getPublishedEntry(ctx, scope, entry.entry.id)).rejects.toThrow(/not.*found/i);
  });

  it('marks an action failed (not crashing) when its target cannot publish', async () => {
    const entry = await seedDraft(ctx, 'Gone');
    await scheduleAction(ctx, scope, {
      action: 'unpublish', // entry was never published → unpublish throws
      entityType: 'Entry',
      entityId: entry.entry.id,
      scheduledFor: T0,
    });

    expect(await runDueScheduledActions(ctx)).toEqual({ executed: 0, failed: 1 });
    const [action] = await ctx.store.scheduledActions.list(scope);
    expect(action?.status).toBe('failed');
    expect(action?.error).toBeTruthy();
  });
});
