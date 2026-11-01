import { describe, expect, it } from 'vitest';
import {
  assetGateKey,
  createKvAssetGate,
  GATE_READ_TTL_SECONDS,
  type KvGateBinding,
} from '../../src/asset-gate-kv/index';

function fakeKv() {
  const values = new Map<string, string>();
  const reads: { key: string; cacheTtl?: number }[] = [];
  const kv: KvGateBinding = {
    async get(key, options) {
      reads.push({ key, ...(options?.cacheTtl ? { cacheTtl: options.cacheTtl } : {}) });
      return values.get(key) ?? null;
    },
    async put(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
  };
  return { kv, values, reads };
}

const scope = { spaceId: 'shop', environmentId: 'main' };
const entry = { v: 2, r2Key: 'shop/main/a/x.png', contentType: 'image/png', fileName: 'x.png' };

describe('the KV asset gate', () => {
  it('keeps one entry per published asset under its scope', async () => {
    const { kv, values, reads } = fakeKv();
    const gate = createKvAssetGate(kv);
    await gate.put(scope, 'a', { ...entry, focal: { x: 0.5, y: 0.5 } });
    expect([...values.keys()]).toEqual([assetGateKey(scope, 'a')]);
    expect(assetGateKey(scope, 'a')).toBe('asset-gate:shop:main:a');
    expect(await gate.get(scope, 'a')).toEqual({ ...entry, focal: { x: 0.5, y: 0.5 } });
    // Reads use KV's edge cache for the minimum the engine's second purge waits out.
    expect(reads.at(-1)?.cacheTtl).toBe(GATE_READ_TTL_SECONDS);
    expect(await gate.get({ ...scope, environmentId: 'staging' }, 'a')).toBeNull();
    await gate.delete(scope, 'a');
    expect(await gate.get(scope, 'a')).toBeNull();
  });

  it('gates nothing for an entry it can’t read', async () => {
    const { kv, values } = fakeKv();
    values.set(assetGateKey(scope, 'a'), 'not json');
    values.set(assetGateKey(scope, 'b'), JSON.stringify({ v: 'one' }));
    const gate = createKvAssetGate(kv);
    expect(await gate.get(scope, 'a')).toBeNull();
    expect(await gate.get(scope, 'b')).toBeNull();
  });
});
