import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@contentworker/agent-runtime';
import { recordSchedulerTick, SchedulerTick } from '@contentworker/application';
import type { Principal } from '@contentworker/domain';
import type { ApiConfig } from '@contentworker/platform/config';
import {
  FixedClock,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  StubAIProvider,
} from '@contentworker/test-kit';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { createApp, HEALTH_SCHEDULER_TTL_MS } from '../../src/api/app';
import type { McpDeps } from '../../src/mcp/deps';
import { buildServer } from '../../src/mcp/server';
import { testConfig } from './config';
import { wire } from './wire';

const config: ApiConfig = testConfig({
  role: 'all',
  cmaKey: 'cma',
  cdaKey: 'cda',
  cpaKey: 'cpa',
  adminToken: 'admin',
  seed: {
    spaceId: 's1',
    environmentId: 'main',
    defaultLocale: 'en-US',
    locales: ['en-US'],
    scale: 1,
  },
});

function build() {
  const w = wire(config);
  const clock = new FixedClock(new Date('2026-11-01T10:00:00.000Z'));
  const ctx = { ...w.ctx, clock };
  return { ctx, clock, app: createApp(ctx, config, w.rag, w.blob, w.ai) };
}

async function tick(ctx: Parameters<typeof recordSchedulerTick>[0], fail?: string) {
  const t = new SchedulerTick(ctx.clock);
  t.ok('outbox-relay');
  if (fail) t.fail('scheduled-actions', new Error(fail));
  await recordSchedulerTick(ctx, t);
}

describe('GET /health', () => {
  it('says only whether the scheduler is ticking, and stays 200 when it is stale', async () => {
    const { ctx, clock, app } = build();
    let res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', scheduler: 'stale' });

    await tick(ctx, 'boom at https://user:secret@hooks.example');
    // The isolate keeps the answer it read for the window: a probe flood is one read.
    expect(await (await app.request('/health')).json()).toEqual({
      status: 'ok',
      scheduler: 'stale',
    });
    clock.advance(HEALTH_SCHEDULER_TTL_MS);
    res = await app.request('/health');
    const body = await res.json();
    expect(body).toEqual({ status: 'ok', scheduler: 'ok' });
    // Nothing about jobs or errors leaks to an unauthenticated caller.
    expect(JSON.stringify(body)).not.toMatch(/outbox|scheduled-actions|boom/);

    clock.advance(6 * 60_000);
    expect(await (await app.request('/health')).json()).toEqual({
      status: 'ok',
      scheduler: 'stale',
    });
  });
});

describe('GET /deployment/scheduler', () => {
  it('shows each sweep to the deployment admin', async () => {
    const { ctx, app } = build();
    await tick(ctx, 'queue unavailable');
    const res = await app.request('/deployment/scheduler', {
      headers: { Authorization: 'Bearer admin' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scheduler: string;
      jobs: { job: string; lastError?: string }[];
    };
    expect(body.scheduler).toBe('ok');
    expect(body.jobs.map((j) => j.job)).toEqual(['outbox-relay', 'scheduled-actions']);
    expect(body.jobs[1]?.lastError).toBe('queue unavailable');
  });

  it('refuses a space’s own keys and anonymous callers', async () => {
    const { app } = build();
    const asKey = await app.request('/deployment/scheduler', {
      headers: { Authorization: 'Bearer cma' },
    });
    expect(asKey.status).toBe(403);
    expect((await app.request('/deployment/scheduler')).status).toBe(401);
  });
});

describe('MCP scheduler_status', () => {
  const hasher = { hash: (v: string) => createHash('sha256').update(v).digest('hex') };

  async function connect(deps: McpDeps, principal: Principal) {
    const server = buildServer(deps, principal);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    return client;
  }

  function deps(ctx: McpDeps['ctx']): McpDeps {
    const ai = new StubAIProvider(() => ({}));
    return {
      ctx,
      ai,
      rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
      hasher,
      adminToken: 'admin',
      agents: new InProcessAgentRuntime(makeActivities({ ctx, ai })),
    };
  }

  it('answers the same as the route for the root token, and refuses a space key', async () => {
    const { ctx, app } = build();
    await tick(ctx, 'queue unavailable');
    const route = await (
      await app.request('/deployment/scheduler', { headers: { Authorization: 'Bearer admin' } })
    ).json();

    const root = await connect(deps(ctx), { spaceId: '*', kind: 'admin', scopes: [] });
    const result = await root.callTool({ name: 'scheduler_status', arguments: {} });
    const content = result.content as { type: string; text?: string }[];
    expect(JSON.parse(content.find((c) => c.type === 'text')?.text ?? 'null')).toEqual(route);

    const scoped = await connect(deps(ctx), {
      spaceId: 's1',
      kind: 'cma',
      scopes: ['space:admin'],
    });
    expect((await scoped.callTool({ name: 'scheduler_status', arguments: {} })).isError).toBe(true);
  });
});
