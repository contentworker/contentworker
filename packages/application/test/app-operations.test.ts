import {
  AppOperationFailedError,
  ForbiddenError,
  NotConfiguredError,
  NotFoundError,
  type PluginManifest,
  type PluginOperation,
  type Principal,
  SCOPES,
  ValidationError,
} from '@contentworker/domain';
import type {
  PluginCapabilities,
  PluginOperationInvocation,
  PluginRuntime,
} from '@contentworker/ports';
import {
  FakeBlobStore,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@contentworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  createPluginOperationRunner,
  getPlugin,
  installPlugin,
  invokeAppOperation,
  listAppOperations,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
  setPluginEnabled,
  upgradePlugin,
} from '../src/index';

/**
 * App operations: named, typed calls a plugin offers (manifest v2), listed and invoked through
 * one use-case each, run with the plugin's grant narrowed to the caller's.
 */

const SPACE = 's1';
const scope = { spaceId: SPACE, environmentId: 'main' };
const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
const viewer: Principal = { spaceId: SPACE, kind: 'cpa', scopes: [SCOPES.previewRead] };
const editor: Principal = {
  spaceId: SPACE,
  kind: 'cma',
  scopes: [SCOPES.previewRead, SCOPES.contentWrite],
};

const summarize: PluginOperation = {
  name: 'summarize',
  title: 'Summarize',
  description: 'Summarizes an entry',
  requires: SCOPES.previewRead,
  input: {
    type: 'object',
    properties: { entryId: { type: 'string', minLength: 1 } },
    required: ['entryId'],
  },
  output: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
};
const rewrite: PluginOperation = {
  name: 'rewrite',
  title: 'Rewrite',
  description: 'Rewrites an entry',
  requires: SCOPES.contentWrite,
  input: { type: 'object', properties: {} },
};

const manifest = (over: Partial<PluginManifest> = {}): PluginManifest => ({
  manifestVersion: 2,
  id: 'com.example.ops',
  name: 'Ops',
  version: '1.0.0',
  capabilities: ['content:read', 'content:write'],
  allowedHosts: [],
  hooks: [],
  entrypoint: 'index.js',
  operations: [summarize, rewrite],
  ...over,
});

type Call = { inv: PluginOperationInvocation; caps: PluginCapabilities };
function fakeRuntime(
  answer: (inv: PluginOperationInvocation, caps: PluginCapabilities) => unknown = () => ({
    summary: 'short',
  }),
): PluginRuntime & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async invoke(inv) {
      return { payload: inv.payload };
    },
    async runOperation(inv, caps) {
      calls.push({ inv, caps });
      return answer(inv, caps);
    },
  };
}

let ctx: AppContext;
let blob: FakeBlobStore;
let runtime: ReturnType<typeof fakeRuntime>;

function withRuntime(r: PluginRuntime) {
  const base = ctx;
  const appOperations = createPluginOperationRunner(base, blob, r);
  ctx = { ...base, ...(appOperations ? { appOperations } : {}) };
}

async function install(over: Partial<PluginManifest> = {}, enable = true) {
  const m = manifest(over);
  const plugin = await installPlugin(ctx, blob, admin, SPACE, {
    manifest: m,
    bundle: `// ${m.id} ${m.version}`,
    approvedCapabilities: m.capabilities,
  });
  if (enable) await setPluginEnabled(ctx, SPACE, plugin.id, true);
  return plugin;
}

beforeEach(() => {
  blob = new FakeBlobStore();
  const store = new InMemoryContentStore();
  store.seedSpace({ spaceId: SPACE, defaultLocale: 'en-US', locales: ['en-US'] });
  store.seedSpace({ spaceId: 's2', defaultLocale: 'en-US', locales: ['en-US'] });
  ctx = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('o') };
  runtime = fakeRuntime();
  withRuntime(runtime);
});

describe('listing app operations', () => {
  it('lists enabled plugins’ operations the caller may invoke, with their schemas', async () => {
    await install();
    const forEditor = await listAppOperations(ctx, editor, SPACE);
    expect(forEditor.map((o) => o.name)).toEqual(['summarize', 'rewrite']);
    expect(forEditor[0]).toMatchObject({
      plugin: 'com.example.ops',
      requires: 'preview:read',
      mode: 'sync',
      input: summarize.input,
    });
    expect((await listAppOperations(ctx, viewer, SPACE)).map((o) => o.name)).toEqual(['summarize']);
  });

  it('lists nothing from a disabled plugin, or from another space', async () => {
    await install({}, false);
    expect(await listAppOperations(ctx, admin, SPACE)).toEqual([]);
    await setPluginEnabled(ctx, SPACE, 'com.example.ops', true);
    expect(await listAppOperations(ctx, admin, 's2')).toEqual([]);
    await expect(listAppOperations(ctx, viewer, 's2')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('invoking an app operation', () => {
  it('runs it with the checked input and returns the output', async () => {
    await install();
    const result = await invokeAppOperation(ctx, viewer, scope, 'com.example.ops', 'summarize', {
      entryId: 'e1',
    });
    expect(result).toEqual({ output: { summary: 'short' } });
    expect(runtime.calls[0]?.inv).toMatchObject({
      pluginId: 'com.example.ops',
      operation: 'summarize',
      input: { entryId: 'e1' },
      scope,
    });
  });

  it('narrows the plugin’s grant to the caller, so a viewer can’t make it write', async () => {
    await install();
    await invokeAppOperation(ctx, viewer, scope, 'com.example.ops', 'summarize', {
      entryId: 'e1',
    });
    await invokeAppOperation(ctx, editor, scope, 'com.example.ops', 'summarize', {
      entryId: 'e1',
    });
    const [asViewer, asEditor] = runtime.calls;
    expect(asViewer?.inv.capabilities).toEqual(['content:read']);
    expect((asViewer?.caps.content as Record<string, unknown> | undefined)?.create).toBeUndefined();
    expect(asEditor?.inv.capabilities).toEqual(['content:read', 'content:write']);
    expect(typeof (asEditor?.caps.content as Record<string, unknown> | undefined)?.create).toBe(
      'function',
    );
  });

  it('refuses a caller without the scope the operation requires', async () => {
    await install();
    await expect(
      invokeAppOperation(ctx, viewer, scope, 'com.example.ops', 'rewrite', {}),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(runtime.calls).toHaveLength(0);
  });

  it('refuses input outside the declared schema before the plugin sees it', async () => {
    await install();
    const bad = invokeAppOperation(ctx, viewer, scope, 'com.example.ops', 'summarize', {
      entryId: 'e1',
      extra: true,
    });
    await expect(bad).rejects.toBeInstanceOf(ValidationError);
    await expect(
      invokeAppOperation(ctx, viewer, scope, 'com.example.ops', 'summarize', {}),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(runtime.calls).toHaveLength(0);
  });

  it('answers not found for an unknown, disabled or other space’s operation', async () => {
    await install();
    const call = (s: typeof scope, plugin: string, op: string) =>
      invokeAppOperation(ctx, admin, s, plugin, op, { entryId: 'e1' });
    await expect(call(scope, 'com.example.ops', 'nope')).rejects.toBeInstanceOf(NotFoundError);
    await expect(call(scope, 'com.example.none', 'summarize')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      call({ spaceId: 's2', environmentId: 'main' }, 'com.example.ops', 'summarize'),
    ).rejects.toBeInstanceOf(NotFoundError);
    await setPluginEnabled(ctx, SPACE, 'com.example.ops', false);
    await expect(call(scope, 'com.example.ops', 'summarize')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('reports a plugin that throws or answers off-schema as the plugin’s failure', async () => {
    await install();
    withRuntime(
      fakeRuntime(() => {
        throw new Error('boom');
      }),
    );
    await expect(
      invokeAppOperation(ctx, viewer, scope, 'com.example.ops', 'summarize', { entryId: 'e1' }),
    ).rejects.toBeInstanceOf(AppOperationFailedError);
    withRuntime(fakeRuntime(() => ({ summary: 42 })));
    await expect(
      invokeAppOperation(ctx, viewer, scope, 'com.example.ops', 'summarize', { entryId: 'e1' }),
    ).rejects.toThrow(/output does not match/);
  });

  it('says operations are not configured where nothing can sandbox plugin code', async () => {
    await install();
    const { appOperations: _none, ...bare } = ctx;
    ctx = bare;
    await expect(
      invokeAppOperation(ctx, viewer, scope, 'com.example.ops', 'summarize', { entryId: 'e1' }),
    ).rejects.toBeInstanceOf(NotConfiguredError);
  });
});

describe('upgrading a plugin’s operations', () => {
  const upgrade = (operations: PluginOperation[]) => {
    const m = manifest({ version: '1.1.0', operations });
    return upgradePlugin(ctx, blob, admin, SPACE, { manifest: m, bundle: `// ${m.version}` });
  };

  it('disables a plugin whose upgrade adds an operation or changes who may call one', async () => {
    await install();
    await upgrade([summarize, rewrite, { ...rewrite, name: 'translate' }]);
    expect((await getPlugin(ctx, SPACE, 'com.example.ops')).enabled).toBe(false);
    await setPluginEnabled(ctx, SPACE, 'com.example.ops', true);
    await upgrade([
      summarize,
      rewrite,
      { ...rewrite, name: 'translate', requires: 'preview:read' },
    ]);
    expect((await getPlugin(ctx, SPACE, 'com.example.ops')).enabled).toBe(false);
  });

  it('keeps it running when operations only go away or keep their scope', async () => {
    await install();
    await upgrade([{ ...summarize, title: 'Summarize better' }]);
    expect((await getPlugin(ctx, SPACE, 'com.example.ops')).enabled).toBe(true);
  });
});

describe('an operation under its caller’s content grants', () => {
  const typeOf = (apiId: string) =>
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
        {
          apiId: 'secret',
          name: 'Secret',
          type: 'Symbol',
          localized: false,
          required: false,
          position: 1,
        },
      ],
    }) as Parameters<typeof createContentType>[3];

  // A member who may write and publish blog posts, and nothing else.
  const blogOnly: Principal = {
    spaceId: SPACE,
    kind: 'user',
    subject: 'u1',
    scopes: [SCOPES.previewRead, SCOPES.contentWrite, SCOPES.contentPublish],
    contentGrants: [
      { contentTypeApiId: 'blog', actions: ['read', 'write', 'publish'], deniedFields: ['secret'] },
    ],
  };
  const writer: PluginOperation = { ...rewrite, requires: SCOPES.contentWrite };

  let legalId: string;
  beforeEach(async () => {
    for (const t of ['blog', 'legal']) {
      await createContentType(ctx, SYSTEM_CALLER, scope, typeOf(t));
      await publishContentType(ctx, scope, t);
    }
    const legal = await createEntry(ctx, scope, {
      contentTypeApiId: 'legal',
      fields: { title: { 'en-US': 'Terms' } },
    });
    legalId = legal.entry.id;
    const blog = await createEntry(ctx, scope, {
      contentTypeApiId: 'blog',
      fields: { title: { 'en-US': 'Post' }, secret: { 'en-US': 'hidden' } },
    });
    await publishEntry(ctx, scope, blog.entry.id);
    await publishEntry(ctx, scope, legalId);
    await install({
      capabilities: ['content:read', 'content:write', 'content:publish'],
      operations: [writer],
    });
  });

  const run = (
    act: (content: Record<string, (...a: unknown[]) => Promise<unknown>>) => unknown,
  ) => {
    withRuntime(
      fakeRuntime((_inv, caps) =>
        act(caps.content as Record<string, (...a: unknown[]) => Promise<unknown>>),
      ),
    );
    return invokeAppOperation(ctx, blogOnly, scope, 'com.example.ops', 'rewrite', {});
  };

  it('can’t create, change or publish an entry of a type the caller may not write', async () => {
    await expect(
      run((c) => c.create?.({ contentTypeApiId: 'legal', fields: { title: { 'en-US': 'x' } } })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      run((c) => c.update?.(legalId, { title: { 'en-US': 'changed' } })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(run((c) => c.publish?.(legalId))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('can still write the types the caller may, but not a field it may not', async () => {
    await expect(
      run((c) => c.create?.({ contentTypeApiId: 'blog', fields: { title: { 'en-US': 'ok' } } })),
    ).resolves.toBeTruthy();
    await expect(
      run((c) =>
        c.create?.({
          contentTypeApiId: 'blog',
          fields: { title: { 'en-US': 'ok' }, secret: { 'en-US': 'no' } },
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('reads published entries filtered and masked as the caller would see them', async () => {
    let seen: { contentType: string; fields: Record<string, unknown> }[] = [];
    await run(async (c) => {
      seen = (await c.listPublished?.({})) as typeof seen;
      return null;
    });
    expect(seen.map((e) => e.contentType)).toEqual(['blog']);
    expect(seen[0]?.fields.secret).toBeUndefined();
  });
});
