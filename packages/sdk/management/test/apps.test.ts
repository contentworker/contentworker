import { describe, expect, it, vi } from 'vitest';
import { createManagementClient } from '../src/index.js';

const base = { baseUrl: 'https://cms.test', space: 's1', environment: 'main', token: 'cma' };

describe('@contentworker/sdk-management apps', () => {
  it('lists and invokes app operations on their routes', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(
        `${init?.method ?? 'GET'} ${String(input).replace('https://cms.test/spaces/s1/environments/main', '')}${init?.body ? ` ${init.body}` : ''}`,
      );
      return Response.json({ items: [], output: { html: '<p>' } });
    }) as unknown as typeof fetch;
    const client = createManagementClient({ ...base, fetch: fetchImpl });
    await client.apps.operations();
    const { output } = await client.apps.invoke<{ html: string }>('com.example.render', 'render', {
      entryId: 'e1',
    });
    expect(output.html).toBe('<p>');
    expect(calls).toEqual([
      'GET /apps/operations',
      'POST /apps/com.example.render/operations/render {"entryId":"e1"}',
    ]);
  });
});
