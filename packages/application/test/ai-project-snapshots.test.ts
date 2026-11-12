import { type Principal, SCOPES, type Scope, ValidationError } from '@contentworker/domain';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  cloneEnvironment,
  createAiProject,
  createAsset,
  createEnvironment,
  createSpace,
  type EnvironmentSnapshot,
  exportSnapshot,
  importSnapshot,
  SYSTEM_CALLER,
  setDefaultAiProject,
  withActor,
} from '../src/index';

/**
 * AI projects in snapshots and clones: carried with their ids and pins (assets keep their ids),
 * checked like a save, kept out where the target already holds the id or the name, and the
 * default never doubled. Promotions don't carry them (they never go through a snapshot).
 */
const source: Scope = { spaceId: 'shop', environmentId: 'main' };
const target: Scope = { spaceId: 'shop', environmentId: 'staging' };

const editor = {
  kind: 'user',
  spaceId: 'shop',
  subject: 'ed@example.com',
  scopes: [SCOPES.contentManage, SCOPES.contentWrite, SCOPES.previewRead, SCOPES.spaceAdmin],
} as Principal;

async function setup() {
  const store = new InMemoryContentStore();
  const blob = new FakeBlobStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('s') };
  await createSpace(ctx, {
    spaceId: 'shop',
    name: 'Shop',
    defaultLocale: 'en-US',
    locales: ['en-US'],
  });
  await createEnvironment(ctx, 'shop', 'staging');
  const { asset } = await createAsset(ctx, blob, source, {
    fileName: 'spec.pdf',
    contentType: 'application/pdf',
  });
  const project = await createAiProject(ctx, source, editor, {
    name: 'Northwind launch',
    instructions: 'Say spec sheet.',
    writer: { name: 'Team', description: 'Plain.' },
    references: [{ assetId: asset.id }],
  });
  await setDefaultAiProject(ctx, source, editor, project.id);
  return { store, ctx, asset, project };
}

describe('AI projects in snapshots and clones', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    t = await setup();
  });

  it('exports each project with its pins', async () => {
    const snapshot = await exportSnapshot(t.ctx, SYSTEM_CALLER, source);
    expect(snapshot.aiProjects).toEqual([
      expect.objectContaining({
        id: t.project.id,
        name: 'Northwind launch',
        isDefault: true,
        references: [{ assetId: t.asset.id, version: 1 }],
      }),
    ]);
  });

  it('a clone carries them with their ids, pins and makers, but never the default', async () => {
    const report = await cloneEnvironment(t.ctx, editor, source, target);
    expect(report.aiProjects).toBe(1);
    const [copy] = await t.store.aiProjects.list(target);
    expect(copy).toMatchObject({
      id: t.project.id,
      name: 'Northwind launch',
      instructions: 'Say spec sheet.',
      writer: { name: 'Team', description: 'Plain.' },
      references: [{ assetId: t.asset.id, version: 1 }],
      // The default is space:admin's to set in the target; a clone takes content:manage.
      isDefault: false,
      version: 1,
      createdBy: 'ed@example.com',
    });
  });

  it('an uploaded snapshot credits the importer, and drops a pin to an asset it can’t place', async () => {
    const snapshot = await exportSnapshot(t.ctx, SYSTEM_CALLER, source);
    const [p] = snapshot.aiProjects ?? [];
    const edited: EnvironmentSnapshot = {
      ...snapshot,
      aiProjects: [
        {
          ...(p as NonNullable<typeof p>),
          createdBy: 'forged@example.com',
          references: [
            { assetId: t.asset.id, version: 1 },
            { assetId: 'not-in-the-snapshot', version: 1 },
          ],
        },
      ],
    };
    await importSnapshot(withActor(t.ctx, 'importer@example.com'), SYSTEM_CALLER, target, edited);
    const [copy] = await t.store.aiProjects.list(target);
    expect(copy?.createdBy).toBe('importer@example.com');
    // A file can't make a project the default: that is space:admin's to set.
    expect(copy?.isDefault).toBe(false);
    expect(copy?.references).toEqual([{ assetId: t.asset.id, version: 1 }]);
  });

  it('keeps the target’s project where the id or the name is taken, and never a second default', async () => {
    const snapshot = await exportSnapshot(t.ctx, SYSTEM_CALLER, source);
    const mine = await createAiProject(t.ctx, target, editor, { name: 'NORTHWIND LAUNCH' });
    await setDefaultAiProject(t.ctx, target, editor, mine.id);
    const other = {
      ...(snapshot.aiProjects?.[0] as NonNullable<EnvironmentSnapshot['aiProjects']>[number]),
    };
    await importSnapshot(t.ctx, SYSTEM_CALLER, target, {
      ...snapshot,
      aiProjects: [other, { ...other, id: 'second', name: 'Second', isDefault: true }],
    });
    const projects = await t.store.aiProjects.list(target);
    expect(projects.map((p) => [p.name, p.isDefault])).toEqual([
      ['NORTHWIND LAUNCH', true],
      ['Second', false],
    ]);
  });

  it('refuses a snapshot whose project breaks a rule, before writing anything', async () => {
    const snapshot = await exportSnapshot(t.ctx, SYSTEM_CALLER, source);
    const bad: EnvironmentSnapshot = {
      ...snapshot,
      aiProjects: [
        {
          ...(snapshot.aiProjects?.[0] as NonNullable<EnvironmentSnapshot['aiProjects']>[number]),
          instructions: 'x'.repeat(5_000),
        },
      ],
    };
    await expect(importSnapshot(t.ctx, SYSTEM_CALLER, target, bad)).rejects.toThrow(
      ValidationError,
    );
    expect(await t.store.aiProjects.list(target)).toEqual([]);
  });

  it('reads a snapshot written before projects as having none', async () => {
    const { aiProjects: _none, ...older } = await exportSnapshot(t.ctx, SYSTEM_CALLER, source);
    const report = await importSnapshot(t.ctx, SYSTEM_CALLER, target, older);
    expect(report.aiProjects).toBe(0);
    expect(await t.store.aiProjects.list(target)).toEqual([]);
  });
});
