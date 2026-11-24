import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  getEntry,
  holdEntryForModeration,
  listAgentRuns,
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

  it('offers no republish to any token, which every MCP caller is', async () => {
    // A CMA key, an OAuth token and a personal access token, each with content:publish.
    const tokens: Principal[] = [
      { spaceId: SPACE, kind: 'cma', scopes: EDITOR.scopes, keyId: 'key-1' },
      { ...EDITOR, issuance: 'oauth', clientId: 'client-1', keyId: 'key-2' },
      { ...EDITOR, issuance: 'pat', keyId: 'key-3' },
      ADMIN,
    ];
    const id = await holdId();
    for (const principal of tokens) {
      const { client, call } = await connect(principal);
      const { tools } = await client.listTools();
      expect(tools.some((t) => t.name === 'moderation_hold_republish')).toBe(false);
      await expect(call('moderation_hold_republish', { id })).rejects.toThrow(/not found/);
      // The list says why, so an agent hands the decision to a person.
      const list = tools.find((t) => t.name === 'moderation_hold_list');
      expect(list?.description).toMatch(/Only a person signed in to the admin can republish/);
    }
    expect((await getEntry(deps.ctx, scope, entryId)).entry.publishedVersion).toBeNull();
    expect(
      await (await connect(READER)).call('moderation_hold_list', { status: 'open' }),
    ).toMatchObject({
      items: [{ id, status: 'open' }],
    });
  });

  it('keeps one unpublished for a role that may publish, audited, naming its key', async () => {
    const id = await holdId();
    const writer = await connect(WRITER);
    expect((await writer.call('moderation_hold_keep', { id })).error).toMatch(/publish/);
    const pat = await connect({ ...EDITOR, issuance: 'pat', keyId: 'key-3' });
    expect(await pat.call('moderation_hold_keep', { id, note: 'Agreed' })).toMatchObject({
      published: false,
      hold: { status: 'kept', decidedBy: 'editor@example.com', note: 'Agreed' },
    });
    expect((await pat.call('moderation_hold_keep', { id })).error).toMatch(/already decided/);
    const { items } = await listAuditLog(deps.ctx, SPACE, { targetType: 'moderation_hold' });
    expect(items.map((r) => r.action)).toEqual(['MCP moderation_hold_keep']);
    const runs = await listAgentRuns(deps.ctx, scope, { workflow: 'moderate' });
    expect(runs.flatMap((r) => r.decisions)).toContain(
      'kept unpublished by editor@example.com via key key-3 (flagged: harassment)',
    );
  });

  it('is invisible to a caller in another space, deciding by id', async () => {
    const id = await holdId();
    const elsewhere = await connect({ ...EDITOR, spaceId: 'space-2' });
    // Its own space has no such hold; this space's it may not reach.
    const there = await elsewhere.client.callTool({
      name: 'moderation_hold_keep',
      arguments: { space: 'space-2', id },
    });
    expect(JSON.stringify(there)).toMatch(/not_found|not found/i);
    expect((await elsewhere.call('moderation_hold_keep', { id })).error).toBeDefined();
    expect(
      await (await connect(READER)).call('moderation_hold_list', { status: 'open' }),
    ).toMatchObject({
      items: [{ id, status: 'open' }],
    });
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
