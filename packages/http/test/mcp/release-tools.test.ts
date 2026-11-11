import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import {
  type AppContext,
  addEntryToRelease,
  createContentType,
  createEntry,
  createRelease,
  createSpace,
  publishContentType,
  purgeEntry,
  SYSTEM_CALLER,
  trashEntry,
} from '@contentworker/application';
import { type FieldDefinition, type Principal, SCOPES } from '@contentworker/domain';
import {
  FakeBlobStore,
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

const shipper = (deniedFields?: readonly string[]): Principal => ({
  spaceId: SPACE,
  kind: 'cma',
  scopes: [SCOPES.previewRead, SCOPES.contentWrite, SCOPES.contentPublish],
  contentGrants: [
    {
      contentTypeApiId: 'story',
      actions: ['read', 'write', 'publish'],
      ...(deniedFields ? { deniedFields } : {}),
    },
  ],
});

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

/** A release holding a story whose `source` links an entry deleted since, shipped as `principal`. */
async function setup(principal: Principal) {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('m'),
  };
  const deps: McpDeps = {
    ctx,
    ai: new StubAIProvider(() => ({})),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher: { hash: (v) => createHash('sha256').update(v).digest('hex') },
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
    blob: new FakeBlobStore(),
  };
  await createSpace(ctx, { spaceId: SPACE, name: 'Site', defaultLocale: 'en-US' });
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'story',
    name: 'Story',
    displayField: 'title',
    fields: [
      field({ apiId: 'title', type: 'Symbol' }),
      field({ apiId: 'source', type: 'Link', linkType: 'Entry', position: 1 }),
    ],
  });
  await publishContentType(ctx, scope, 'story');
  const source = await createEntry(ctx, scope, {
    contentTypeApiId: 'story',
    fields: { title: { 'en-US': 'Source' } },
  });
  const story = await createEntry(ctx, scope, {
    contentTypeApiId: 'story',
    fields: {
      title: { 'en-US': 'Story' },
      source: { 'en-US': { id: source.entry.id, linkType: 'Entry' } },
    },
  });
  await trashEntry(ctx, scope, source.entry.id);
  await purgeEntry(ctx, scope, source.entry.id);
  const release = await createRelease(ctx, scope, { title: 'Launch' });
  await addEntryToRelease(ctx, scope, release.id, { entityId: story.entry.id });

  const server = buildServer(deps, principal);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  const r = (await client.callTool({
    name: 'releases_publish',
    arguments: { space: SPACE, id: release.id },
  })) as { isError?: boolean; content?: { type: string; text?: string }[] };
  const text = r.content?.find((c) => c.type === 'text')?.text ?? 'null';
  return { isError: r.isError === true, text, sourceId: source.entry.id };
}

describe('releases_publish', () => {
  it('counts a refusal in a field the role can’t read, naming neither it nor its target', async () => {
    const { isError, text, sourceId } = await setup(shipper(['source']));
    expect(isError).toBe(true);
    expect(JSON.parse(text).error.issues).toEqual([
      expect.objectContaining({ field: '', code: 'hidden', hidden: 1 }),
    ]);
    expect(text).not.toContain('source');
    expect(text).not.toContain(sourceId);
  });

  it('names it to a role that reads the field', async () => {
    const { isError, text, sourceId } = await setup(shipper());
    expect(isError).toBe(true);
    expect(JSON.parse(text).error.issues).toEqual([
      { field: 'source', message: `Linked entry "${sourceId}" does not exist` },
    ]);
  });
});
