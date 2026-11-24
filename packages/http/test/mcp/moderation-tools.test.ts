import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  getEntry,
  holdEntryForModeration,
  listAuditLog,
  publishContentType,
  publishEntry,
  SYSTEM_CALLER,
} from '@contentworker/application';
import { type Principal, SCOPES } from '@contentworker/domain';
import {
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

const SPACE = 'space-1';
const scope = { spaceId: SPACE, environmentId: 'main' };
const ADMIN: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
const READER: Principal = { spaceId: SPACE, kind: 'cpa', scopes: ['preview:read'] };
/** May publish, but its role grants only write on articles. */
const WRITER: Principal = {
  spaceId: SPACE,
  kind: 'user',
  subject: 'writer@example.com',
  scopes: ['content:write', 'content:publish', 'preview:read'],
  contentGrants: [{ contentTypeApiId: 'article', actions: ['read', 'write'] }],
};
const EDITOR: Principal = {
  ...WRITER,
  subject: 'editor@example.com',
  contentGrants: [{ contentTypeApiId: 'article', actions: ['read', 'write', 'publish'] }],
};

type Json = Record<string, unknown>;

describe('MCP moderation hold tools', () => {
  let deps: McpDeps;
  let entryId: string;

  beforeEach(async () => {
    const ctx: AppContext = {
      store: new InMemoryContentStore(),
      clock: new FixedClock(),
      ids: new SequenceIdGenerator('h'),
      ai: { mode: 'mock', timeoutMs: 1000 },
    };
    deps = {
      ctx,
      ai: new StubAIProvider(() => ({})),
      rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
      hasher: { hash: (v) => createHash('sha256').update(v).digest('hex') },
      adminToken: 'admin',
      agents: new InProcessAgentRuntime(
        makeActivities({ ctx, ai: new StubAIProvider(() => ({})) }),
      ),
    };
    await createSpace(ctx, { spaceId: SPACE, name: 'Blog', defaultLocale: 'en-US' });
    await createContentType(ctx, SYSTEM_CALLER, scope, {
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
    entryId = (
      await createEntry(ctx, scope, {
        contentTypeApiId: 'article',
        fields: { title: { 'en-US': 'Hello' } },
      })
    ).entry.id;
    await publishEntry(ctx, scope, entryId);
    await holdEntryForModeration(ctx, scope, entryId, { flags: ['harassment'] });
  });

  async function connect(principal: Principal) {
    const server = buildServer(deps, principal);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    return {
      client,
      call: async (name: string, args: Json = {}) => {
        const res = (await client.callTool({ name, arguments: { space: SPACE, ...args } })) as {
          isError?: boolean;
          content?: { type: string; text?: string }[];
        };
        const text = res.content?.find((c) => c.type === 'text')?.text ?? 'null';
        if (res.isError) return { error: text } as Json;
        return JSON.parse(text) as Json;
      },
    };
  }

  const holdId = async () => {
    const { call } = await connect(READER);
    const { items } = (await call('moderation_hold_list', { status: 'open' })) as {
      items: Json[];
    };
    return items[0]?.id as string;
  };

  it('lists open holds read-only, counted in approvals_count', async () => {
    const { client, call } = await connect(READER);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('moderation_hold_list')?.annotations?.readOnlyHint).toBe(true);
    // A reader isn't shown the decisions it couldn't make.
    expect(byName.has('moderation_hold_republish')).toBe(false);
    expect(await call('moderation_hold_list', { status: 'open' })).toMatchObject({
      items: [{ entryId, flags: ['harassment'], status: 'open' }],
    });
    expect(await call('approvals_count')).toMatchObject({ moderationHolds: 1, total: 1 });
    expect((await call('moderation_hold_keep', { id: await holdId() })).error).toMatch(
      /content:publish/,
    );
  });

  it('republishes as the HTTP API does, audited, and refuses a role without publish', async () => {
    const id = await holdId();
    const writer = await connect(WRITER);
    expect((await writer.call('moderation_hold_republish', { id })).error).toMatch(/publish/);
    expect((await getEntry(deps.ctx, scope, entryId)).entry.publishedVersion).toBeNull();

    const editor = await connect(EDITOR);
    const res = await editor.call('moderation_hold_republish', { id, note: 'Context matters' });
    expect(res).toMatchObject({
      published: true,
      hold: { status: 'republished', decidedBy: 'editor@example.com', note: 'Context matters' },
    });
    expect((await getEntry(deps.ctx, scope, entryId)).entry.publishedVersion).toBe(1);
    expect((await editor.call('moderation_hold_keep', { id })).error).toMatch(/already decided/);
    const { items } = await listAuditLog(deps.ctx, SPACE, { targetType: 'moderation_hold' });
    expect(items.map((r) => r.action)).toEqual(['MCP moderation_hold_republish']);
  });

  it('keeps an entry unpublished', async () => {
    const { call } = await connect(ADMIN);
    expect(await call('moderation_hold_keep', { id: await holdId() })).toMatchObject({
      published: false,
      hold: { status: 'kept', decidedBy: 'admin-token' },
    });
    expect(await call('moderation_hold_list', { status: 'open' })).toEqual({ items: [] });
    expect((await getEntry(deps.ctx, scope, entryId)).entry.publishedVersion).toBeNull();
  });
});
