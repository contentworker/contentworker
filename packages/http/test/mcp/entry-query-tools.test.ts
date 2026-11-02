import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  publishContentType,
} from '@contentworker/application';
import { type Principal, SCOPES } from '@contentworker/domain';
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
import { beforeEach, describe, expect, it } from 'vitest';
import type { McpDeps } from '../../src/mcp/deps';
import { buildServer } from '../../src/mcp/server';

/** entries_query: the MCP side of GET /preview/.../entries, paged with the same cursor. */
const SPACE = 'space-1';
const scope = { spaceId: SPACE, environmentId: 'main' };
const READER: Principal = { spaceId: SPACE, kind: 'cpa', scopes: [SCOPES.previewRead] };
const hasher = { hash: (v: string) => createHash('sha256').update(v).digest('hex') };

function makeDeps(): McpDeps {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('m'),
  };
  return {
    ctx,
    ai: new StubAIProvider(() => ({})),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher,
    adminToken: 'admin',
    blob: new FakeBlobStore(),
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
  };
}

async function connect(deps: McpDeps, principal: Principal): Promise<Client> {
  const server = buildServer(deps, principal);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const text = (res: Awaited<ReturnType<Client['callTool']>>) =>
  JSON.parse((res.content as { text: string }[])[0]?.text ?? 'null');

interface Page {
  items: { id: string; fields: { title: Record<string, string> } }[];
  nextCursor?: string;
}

describe('entries_query over MCP', () => {
  let deps: McpDeps;
  beforeEach(async () => {
    deps = makeDeps();
    await createSpace(deps.ctx, { spaceId: SPACE, name: 'One', defaultLocale: 'en-US' });
    await createContentType(deps.ctx, scope, {
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
      ],
    });
    await publishContentType(deps.ctx, scope, 'note');
    for (const t of ['b', 'd', 'a', 'c', 'e']) {
      await createEntry(deps.ctx, scope, {
        contentTypeApiId: 'note',
        fields: { title: { 'en-US': t } },
      });
    }
  });

  it('returns a page and follows nextCursor to the end, in the order asked', async () => {
    const client = await connect(deps, READER);
    const order = [{ field: 'title', direction: 'asc' }];
    const titles: string[] = [];
    let cursor: string | undefined;
    let calls = 0;
    do {
      const res = await client.callTool({
        name: 'entries_query',
        arguments: {
          space: SPACE,
          contentType: 'note',
          order,
          limit: 2,
          ...(cursor ? { cursor } : {}),
        },
      });
      expect(res.isError).toBeFalsy();
      const page = text(res) as Page;
      titles.push(...page.items.map((e) => e.fields.title['en-US'] as string));
      cursor = page.nextCursor;
      calls++;
    } while (cursor);
    expect(titles).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(calls).toBe(3);
  });

  it('refuses a cursor carried over to another order', async () => {
    const client = await connect(deps, READER);
    const first = text(
      await client.callTool({
        name: 'entries_query',
        arguments: { space: SPACE, contentType: 'note', limit: 2 },
      }),
    ) as Page;
    const res = await client.callTool({
      name: 'entries_query',
      arguments: {
        space: SPACE,
        contentType: 'note',
        order: [{ field: 'title', direction: 'desc' }],
        cursor: first.nextCursor,
      },
    });
    expect(res.isError).toBe(true);
  });

  it('refuses skip rather than reading the first page again', async () => {
    const client = await connect(deps, READER);
    const res = await client.callTool({
      name: 'entries_query',
      arguments: { space: SPACE, contentType: 'note', skip: 2 },
    });
    expect(res.isError).toBe(true);
  });
});
