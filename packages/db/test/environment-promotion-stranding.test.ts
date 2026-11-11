import {
  type AppContext,
  approvePromotion,
  createContentType,
  createEntry,
  createEnvironment,
  createSpace,
  publishContentType,
  publishEntry,
  requestPromotion,
  SYSTEM_CALLER,
} from '@contentworker/application';
import { type Principal, SCOPES, ValidationError } from '@contentworker/domain';
import type { Clock, IdGenerator } from '@contentworker/ports';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * A promotion whose content type drops a block variant the target's entries still hold, on D1:
 * refused when requested and again at the apply, before anything is written. More entries than
 * one statement binds (100), so the in-use scan pages and the promoted entries' current and
 * published copies are read in chunks.
 */
const clock: Clock = { now: () => new Date() };
const ids: IdGenerator = { newId: () => crypto.randomUUID() };
const store = createD1Store(testDb);
const ctx: AppContext = { store, clock, ids };
const spaceId = `strand-${crypto.randomUUID().slice(0, 8)}`;
const staging = { spaceId, environmentId: 'staging' };
const qa = { spaceId, environmentId: 'qa' };
const ada: Principal = {
  spaceId,
  kind: 'user',
  subject: 'ada',
  scopes: [SCOPES.contentPublish, SCOPES.contentManage],
};
const grace: Principal = { ...ada, subject: 'grace' };
const MANY = 110;

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
const hero = { apiId: 'hero', name: 'Hero', fields: [symbol('heading')] };
const cta = { apiId: 'cta', name: 'CTA', fields: [symbol('label')] };
const variantsOf = async () =>
  (await store.contentTypes.get(qa, 'page'))?.fields[1]?.items?.variants?.map((v) => v.apiId);

describe('promoting a type that would strand blocks, on D1', () => {
  it('counts every holder past one statement, lets promoted copies replace theirs, and refuses a late one at the apply', async () => {
    await createSpace(ctx, { spaceId, name: 'S', defaultLocale: 'en-US', locales: ['en-US'] });
    await createEnvironment(ctx, spaceId, 'staging');
    await createEnvironment(ctx, spaceId, 'qa');
    await createContentType(ctx, SYSTEM_CALLER, qa, page([hero, cta]));
    await publishContentType(ctx, qa, 'page');
    await createContentType(ctx, SYSTEM_CALLER, staging, page([hero]));
    await publishContentType(ctx, staging, 'page');

    // qa's copies hold a cta, live; staging's copies of the same entries are drafts without one.
    const held: string[] = [];
    for (let i = 0; i < MANY; i++) {
      const { entry } = await createEntry(ctx, qa, {
        contentTypeApiId: 'page',
        fields: {
          title: { 'en-US': `Page ${i}` },
          body: { 'en-US': [{ _type: 'cta', label: 'Go' }] },
        },
      });
      await publishEntry(ctx, qa, entry.id);
      await createEntry(ctx, staging, {
        contentTypeApiId: 'page',
        id: entry.id,
        fields: {
          title: { 'en-US': `Page ${i}` },
          body: { 'en-US': [{ _type: 'hero', heading: 'Hi' }] },
        },
      });
      held.push(entry.id);
    }
    const request = () =>
      requestPromotion(ctx, ada, spaceId, {
        source: 'staging',
        target: 'qa',
        contentTypes: ['page'],
        entries: held,
      });

    // As drafts, they leave qa's published snapshots holding the cta.
    const err = await request().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    const [issue] = (err as ValidationError).issues;
    expect(issue?.field).toBe('contentTypes');
    expect(issue?.message).toContain(
      `it removes a block variant ${MANY} entries there still use: body: cta (entries `,
    );
    expect(issue?.message).toContain(`and ${MANY - 10} more)`);
    expect(await store.promotions.list(spaceId)).toEqual([]);

    // Live, they replace both of qa's copies: nothing is stranded.
    for (const id of held) await publishEntry(ctx, staging, id);
    const p = await request();
    expect(p.status).toBe('awaiting_approval');

    // Written in qa while it waits: the apply refuses before saving anything.
    const { entry: late } = await createEntry(ctx, qa, {
      contentTypeApiId: 'page',
      fields: { title: { 'en-US': 'Late' }, body: { 'en-US': [{ _type: 'cta', label: 'Go' }] } },
    });
    const before = await store.contentTypes.get(qa, 'page');
    const refused = await approvePromotion(ctx, grace, spaceId, p.id).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ValidationError);
    expect((refused as ValidationError).issues[0]?.message).toContain(
      `1 entry there still uses: body: cta (entry ${late.id})`,
    );
    expect(await store.promotions.get(spaceId, p.id)).toMatchObject({
      status: 'failed',
      result: { contentTypes: [], entries: [] },
    });
    expect(await store.contentTypes.get(qa, 'page')).toEqual(before);
    expect(await variantsOf()).toEqual(['hero', 'cta']);
    expect((await store.entries.get(qa, held[0] as string))?.fields.body).toMatchObject({
      'en-US': [{ _type: 'cta' }],
    });
  });
});
