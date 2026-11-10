import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  publishContentType,
  SYSTEM_CALLER,
} from '@contentworker/application';
import { type FieldDefinition, type Principal, SCOPES } from '@contentworker/domain';
import type { GenerateRequest } from '@contentworker/ports';
import {
  FakeBlobStore,
  FakePasswordHasher,
  FixedClock,
  InMemoryContentStore,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  SequenceIdGenerator,
  StubAIProvider,
} from '@contentworker/test-kit';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import type { McpDeps } from '../../src/mcp/deps';
import { buildServer } from '../../src/mcp/server';

const SPACE = 'space-1';
const scope = { spaceId: SPACE, environmentId: 'main' };

const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
// Writes the page's body, reads but may not write its sidebar.
const writer: Principal = {
  spaceId: SPACE,
  kind: 'cma',
  scopes: [SCOPES.previewRead, SCOPES.contentWrite],
  contentGrants: [
    { contentTypeApiId: 'page', actions: ['read', 'write'], readOnlyFields: ['sidebar'] },
  ],
};

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;
const cta = {
  apiId: 'cta',
  name: 'Call to action',
  fields: [field({ apiId: 'label', type: 'Symbol' })],
};
const blocks = (apiId: string, position: number) =>
  field({ apiId, type: 'Array', position, items: { type: 'Component', variants: [cta] } });

async function setup(principal: Principal, answer: (req: GenerateRequest) => unknown) {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('m'),
    passwords: new FakePasswordHasher(),
  };
  const ai = new StubAIProvider(answer);
  const deps: McpDeps = {
    ctx,
    ai,
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher: { hash: (v) => createHash('sha256').update(v).digest('hex') },
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai })),
    blob: new FakeBlobStore(),
  };
  await createSpace(ctx, { spaceId: SPACE, name: 'Site', defaultLocale: 'en-US' });
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'page',
    name: 'Page',
    displayField: 'title',
    fields: [field({ apiId: 'title', type: 'Symbol' }), blocks('body', 1), blocks('sidebar', 2)],
  });
  await publishContentType(ctx, scope, 'page');
  const { entry } = await createEntry(ctx, scope, {
    contentTypeApiId: 'page',
    fields: { title: { 'en-US': 'Home' }, body: { 'en-US': [{ _type: 'cta', label: 'One' }] } },
  });
  const server = buildServer(deps, principal);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: { space: SPACE, ...args } })) as {
      isError?: boolean;
      content?: { type: string; text?: string }[];
    };
    const text = r.content?.find((c) => c.type === 'text')?.text ?? 'null';
    return { isError: r.isError === true, text };
  };
  return { ai, client, id: entry.id, call };
}

describe('the blocks generation tool', () => {
  it('composes ops that entry_blocks_patch saves, read-only itself', async () => {
    const { client, id, call } = await setup(admin, () => ({
      blocks: [{ _type: 'cta', label: 'Two' }],
    }));
    const listed = await client.listTools();
    const tool = listed.tools.find((t) => t.name === 'entry_blocks_generate');
    expect(tool?.annotations?.readOnlyHint).toBe(true);

    const generated = await call('entry_blocks_generate', { id, field: 'body', prompt: 'More' });
    expect(generated.isError, generated.text).toBe(false);
    const out = JSON.parse(generated.text);
    expect(out.expectedVersion).toBe(1);
    expect(out.ops).toEqual([
      { op: 'insert', field: 'body', locale: 'en-US', block: { _type: 'cta', label: 'Two' } },
    ]);
    const patched = await call('entry_blocks_patch', {
      id,
      expectedVersion: out.expectedVersion,
      ops: out.ops,
    });
    expect(patched.isError, patched.text).toBe(false);
    expect(JSON.parse(patched.text).fields.body['en-US']).toHaveLength(2);
  });

  it('answers a new entry’s field with contentType instead of an id', async () => {
    const { call } = await setup(admin, () => ({ blocks: [{ _type: 'cta', label: 'Hi' }] }));
    const out = await call('entry_blocks_generate', {
      contentType: 'page',
      field: 'body',
      prompt: 'x',
    });
    expect(out.isError, out.text).toBe(false);
    expect(JSON.parse(out.text)).toMatchObject({
      entryId: null,
      fields: { body: { 'en-US': [{ _type: 'cta', label: 'Hi' }] } },
    });
  });

  it('is held to the caller’s role as the route is, and to one target', async () => {
    const { ai, id, call } = await setup(writer, () => ({ blocks: [] }));
    const readOnly = await call('entry_blocks_generate', { id, field: 'sidebar', prompt: 'x' });
    expect(readOnly.isError).toBe(true);
    expect(readOnly.text).toContain('forbidden');
    const neither = await call('entry_blocks_generate', { field: 'body', prompt: 'x' });
    expect(neither.isError).toBe(true);
    expect(ai.requests).toHaveLength(0);
  });

  it('drafts an entry’s blocks fields through generate_draft', async () => {
    const { call } = await setup(admin, () => ({
      title: 'T',
      body: [{ _type: 'cta', label: 'Go' }],
      sidebar: [],
    }));
    const out = await call('generate_draft', { contentType: 'page', prompt: 'x' });
    expect(out.isError, out.text).toBe(false);
    expect(JSON.parse(out.text).fields.body).toEqual({ 'en-US': [{ _type: 'cta', label: 'Go' }] });
  });
});
