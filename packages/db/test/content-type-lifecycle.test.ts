import {
  type AppContext,
  cloneContentType,
  contentTypeDependents,
  createContentType,
  createEntry,
  createEnvironment,
  createSpace,
  deleteContentType,
  publishContentType,
  trashEntry,
} from '@contentworker/application';
import type { FieldDefinition } from '@contentworker/domain';
import { TransactionConflictError } from '@contentworker/ports';
import { FixedClock } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Deleting and cloning a content type on D1: the delete is a compare-and-set on the type's version
 * whose own WHERE refuses a type with any entry (the trash included), so an entry written after
 * the use-case looked fails the commit; the outbox event rides in the same batch. Each test makes
 * its own space: the file shares one database.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();
const title: FieldDefinition = {
  apiId: 'title',
  name: 'Title',
  type: 'Symbol',
  localized: false,
  required: false,
  position: 0,
};

async function harness() {
  const ctx: AppContext = { store, clock: new FixedClock(), ids: { newId: uid } };
  const spaceId = `ct-life-${uid()}`;
  await createSpace(ctx, { spaceId, name: 'Lifecycle', defaultLocale: 'en-US' });
  const scope = { spaceId, environmentId: 'main' };
  await createContentType(ctx, scope, {
    apiId: 'note',
    name: 'Note',
    displayField: 'title',
    fields: [title],
  });
  await publishContentType(ctx, scope, 'note');
  return { ctx, scope };
}

async function deletedEvents(spaceId: string): Promise<number> {
  const row = await testDb
    .prepare(
      "select count(*) as n from outbox where json_extract(payload, '$.scope.spaceId') = ? and json_extract(payload, '$.type') = 'content_type.deleted'",
    )
    .bind(spaceId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe('content type delete on D1', () => {
  it('deletes at its version with the event, and refuses a stale version', async () => {
    const { ctx, scope } = await harness();
    // Revised since the caller read version 1.
    await expect(store.contentTypes.delete(scope, 'note', 2)).rejects.toBeInstanceOf(
      TransactionConflictError,
    );
    await deleteContentType(ctx, scope, 'note');
    expect(await store.contentTypes.get(scope, 'note')).toBeNull();
    expect(await deletedEvents(scope.spaceId)).toBe(1);
  });

  it('fails the commit when an entry exists by then, the trash included, and writes no event', async () => {
    const { ctx, scope } = await harness();
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'note',
      fields: { title: { 'en-US': 'x' } },
    });
    await trashEntry(ctx, scope, entry.id);
    const version = (await store.contentTypes.get(scope, 'note'))?.version ?? 0;
    await expect(
      store.withTransaction(async (tx) => {
        await tx.contentTypes.delete(scope, 'note', version);
        await tx.outbox.append({
          id: uid(),
          type: 'content_type.deleted',
          scope,
          occurredAt: new Date().toISOString(),
          contentTypeApiId: 'note',
          version,
        });
      }),
    ).rejects.toBeInstanceOf(TransactionConflictError);
    expect(await store.contentTypes.get(scope, 'note')).not.toBeNull();
    expect(await deletedEvents(scope.spaceId)).toBe(0);
    expect((await contentTypeDependents(ctx, scope, 'note')).entries).toEqual({
      live: 0,
      trashed: 1,
    });
  });

  it('touches only its own environment', async () => {
    const { ctx, scope } = await harness();
    await createEnvironment(ctx, scope.spaceId, 'staging');
    const staging = { spaceId: scope.spaceId, environmentId: 'staging' };
    await createContentType(ctx, staging, {
      apiId: 'note',
      name: 'Note',
      displayField: 'title',
      fields: [title],
    });
    await deleteContentType(ctx, scope, 'note');
    expect(await store.contentTypes.get(staging, 'note')).not.toBeNull();
  });

  it('clones the definition under a new apiId', async () => {
    const { ctx, scope } = await harness();
    const clone = await cloneContentType(ctx, scope, 'note', 'memo', 'Memo');
    expect(await store.contentTypes.get(scope, 'memo')).toEqual(clone);
    expect(clone).toMatchObject({ version: 1, status: 'draft', displayField: 'title' });
  });
});
