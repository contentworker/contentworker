import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import { type Principal, SCOPES } from '@contentworker/domain';
import type { RemoteFetcher } from '@contentworker/ports';
import { FakeAssetIngestQueue } from '@contentworker/test-kit';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import type { McpDeps } from '../../src/mcp/deps';
import { buildServer } from '../../src/mcp/server';
import { testConfig } from '../api/config';
import { wire } from '../api/wire';

const config = testConfig();
const M = '/spaces/s1/environments/main';
const cma = { Authorization: 'Bearer cma', 'Content-Type': 'application/json' };
const BYTES = new Uint8Array([1, 2, 3, 4, 5]);

function host(): RemoteFetcher & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get() {
      throw new Error('not used');
    },
    async getBytes(url) {
      calls.push(url);
      return url.startsWith('https://files.example.com/')
        ? { status: 200, contentType: 'image/webp', bytes: BYTES }
        : { status: 404, bytes: new Uint8Array() };
    },
  };
}

/** REST and MCP over one wiring, so their answers can be compared. */
async function both(fetcher: RemoteFetcher | null = host()) {
  const remoteFetcher = fetcher ?? undefined;
  const wired = wire(config);
  const ingest = new FakeAssetIngestQueue();
  const app = createApp(
    wired.ctx,
    config,
    wired.rag,
    wired.blob,
    wired.ai,
    undefined,
    undefined,
    undefined,
    undefined,
    { ...(remoteFetcher ? { remoteFetcher } : {}), assetIngest: ingest },
  );
  const deps: McpDeps = {
    ctx: wired.ctx,
    ai: wired.ai,
    rag: wired.rag,
    blob: wired.blob,
    assetIngest: ingest,
    ...(remoteFetcher ? { remoteFetcher } : {}),
    hasher: { hash: (v) => createHash('sha256').update(v).digest('hex') },
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx: wired.ctx, ai: wired.ai })),
  };
  const rest = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`${M}${path}`, {
      method,
      headers: cma,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const mcp = async (principal: Principal) => {
    const server = buildServer(deps, principal);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    return async (args: Record<string, unknown>) => {
      const res = await client.callTool({
        name: 'assets_create_from_url',
        arguments: { space: 's1', ...args },
      });
      const text = (res.content as { type: string; text?: string }[] | undefined)?.find(
        (c) => c.type === 'text',
      )?.text;
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(text ?? 'null');
      } catch {
        body = { message: text };
      }
      return { isError: res.isError === true, body };
    };
  };
  return { wired, ingest, rest, mcp };
}

const writer: Principal = { spaceId: 's1', kind: 'cma', scopes: [SCOPES.assetsWrite] };

describe('assets_create_from_url (MCP), on the use-case POST …/assets/from-url calls', () => {
  it('creates the asset REST would, in the same shape, and starts ingest', async () => {
    const { rest, mcp, ingest } = await both();
    const call = await mcp(writer);
    const created = await call({ url: 'https://files.example.com/a/photo.webp', title: 'Photo' });
    expect(created.isError).toBe(false);
    const viaRest = await rest('POST', '/assets/from-url', {
      url: 'https://files.example.com/b/other.webp',
    });
    expect(Object.keys(created.body).sort()).toEqual(Object.keys(viaRest.body).sort());
    const asset = created.body.asset as { id: string };
    expect(created.body).toMatchObject({
      deduplicated: false,
      asset: { title: { 'en-US': 'Photo' }, file: { fileName: 'photo.webp' } },
    });
    expect(created.body.asset).not.toHaveProperty('r2Key');
    expect((await rest('GET', `/assets/${asset.id}`)).body).toEqual(created.body.asset);
    expect(ingest.created).toHaveLength(2);
  });

  it('returns the asset already holding the bytes, as REST does', async () => {
    const { wired, mcp } = await both();
    const call = await mcp(writer);
    const first = (await call({ url: 'https://files.example.com/x.webp' })).body.asset as {
      id: string;
    };
    await wired.ctx.store.assets.recordIngest(
      { spaceId: 's1', environmentId: 'main' },
      first.id,
      1,
      {
        contentHash: createHash('sha256').update(BYTES).digest('hex'),
      },
    );
    expect((await call({ url: 'https://files.example.com/y.webp' })).body).toMatchObject({
      deduplicated: true,
      asset: { id: first.id },
    });
  });

  it('refuses a loopback URL, another space and a caller without assets:write', async () => {
    const fetcher = host();
    const { mcp } = await both(fetcher);
    expect((await (await mcp(writer))({ url: 'http://127.0.0.1:8787/a.png' })).isError).toBe(true);
    const reader = await mcp({ spaceId: 's1', kind: 'cpa', scopes: [SCOPES.previewRead] });
    expect((await reader({ url: 'https://files.example.com/a.webp' })).isError).toBe(true);
    const elsewhere = await mcp({ spaceId: 'other', kind: 'cma', scopes: Object.values(SCOPES) });
    expect((await elsewhere({ url: 'https://files.example.com/a.webp' })).isError).toBe(true);
    expect(fetcher.calls).toEqual([]);
  });

  it('says so when the deployment has no outbound fetcher', async () => {
    const { mcp } = await both(null);
    const res = await (await mcp(writer))({ url: 'https://files.example.com/a.webp' });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.body)).toContain('cannot download files');
  });
});
