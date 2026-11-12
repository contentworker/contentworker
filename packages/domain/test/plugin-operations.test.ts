import { describe, expect, it } from 'vitest';
import {
  assertValidManifest,
  type OperationSchema,
  operationGrant,
  operationSchemaIssues,
  operationsWiden,
  operationValueIssues,
  type PluginManifest,
  type PluginOperation,
  SCOPES,
  type ValidationError,
} from '../src/index';

const input: OperationSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', maxLength: 5 },
    tone: { type: 'string', enum: ['plain', 'warm'] },
    count: { type: 'integer', minimum: 1, maximum: 3 },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
    draft: { type: 'boolean' },
  },
  required: ['title'],
};
const op: PluginOperation = {
  name: 'render',
  title: 'Render',
  description: 'Renders',
  requires: SCOPES.previewRead,
  input,
};
const manifest = (over: Partial<PluginManifest> = {}): PluginManifest => ({
  manifestVersion: 2,
  id: 'com.example.ops',
  name: 'Ops',
  version: '1.0.0',
  capabilities: [],
  allowedHosts: [],
  hooks: [],
  entrypoint: 'index.js',
  operations: [op],
  ...over,
});
const issuesOf = (m: PluginManifest) => {
  try {
    assertValidManifest(m);
    return [];
  } catch (err) {
    return (err as ValidationError).issues.map((i) => i.field);
  }
};

describe('operation schemas', () => {
  it('accepts the subset and refuses anything outside it', () => {
    expect(operationSchemaIssues(input, 'input')).toEqual([]);
    expect(operationSchemaIssues({ type: 'string', pattern: '.*' }, 'input')[0]?.message).toMatch(
      /"pattern" is not supported/,
    );
    expect(operationSchemaIssues({ type: 'null' }, 'input')).toHaveLength(1);
    expect(
      operationSchemaIssues({ type: 'object', properties: {}, required: ['x'] }, 'input'),
    ).toHaveLength(1);
  });

  it('refuses a schema nested past the limit', () => {
    let deep: OperationSchema = { type: 'string' };
    for (let i = 0; i < 10; i++) deep = { type: 'array', items: deep };
    expect(operationSchemaIssues(deep, 'input').some((i) => /deeper/.test(i.message))).toBe(true);
  });

  it('checks values: required, closed objects, enums, bounds, integers and lists', () => {
    expect(operationValueIssues(input, { title: 'ok', tone: 'warm', count: 2 }, 'input')).toEqual(
      [],
    );
    const fields = (v: unknown) => operationValueIssues(input, v, 'input').map((i) => i.field);
    expect(fields({})).toEqual(['input.title']);
    expect(fields({ title: 'ok', other: 1 })).toEqual(['input.other']);
    expect(fields({ title: 'toolong' })).toEqual(['input.title']);
    expect(fields({ title: 'ok', tone: 'loud' })).toEqual(['input.tone']);
    expect(fields({ title: 'ok', count: 1.5 })).toEqual(['input.count']);
    expect(fields({ title: 'ok', count: 9 })).toEqual(['input.count']);
    expect(fields({ title: 'ok', tags: ['a', 'b', 'c'] })).toEqual(['input.tags']);
    expect(fields({ title: 'ok', tags: ['a', 2] })).toEqual(['input.tags[1]']);
    expect(fields('nope')).toEqual(['input']);
  });
});

describe('manifest v2 operations', () => {
  it('accepts a valid v2 manifest, and v1 manifests without operations as before', () => {
    expect(issuesOf(manifest())).toEqual([]);
    expect(issuesOf(manifest({ manifestVersion: undefined, operations: undefined }))).toEqual([]);
  });

  it('needs manifestVersion 2 for operations', () => {
    expect(issuesOf(manifest({ manifestVersion: 1 }))).toEqual(['operations']);
    expect(issuesOf(manifest({ manifestVersion: undefined }))).toEqual(['operations']);
  });

  it('refuses bad names, duplicates, unknown scopes, unknown modes and non-object inputs', () => {
    const bad = (o: Partial<PluginOperation>) =>
      issuesOf(manifest({ operations: [{ ...op, ...o }] }));
    expect(bad({ name: 'Render' })).toEqual(['operations[0].name']);
    expect(issuesOf(manifest({ operations: [op, op] }))).toEqual(['operations[1].name']);
    expect(bad({ requires: 'everything' as never })).toEqual(['operations[0].requires']);
    expect(bad({ mode: 'later' as never })).toEqual(['operations[0].mode']);
    expect(bad({ mode: 'async' })).toEqual([]);
    expect(bad({ input: { type: 'string' } })).toEqual(['operations[0].input']);
    expect(bad({ description: ' ' })).toEqual(['operations[0].description']);
  });
});

describe('what widens an operation surface', () => {
  it('is a new operation or a changed `requires`, not a removal or a retitle', () => {
    expect(operationsWiden([op], [op, { ...op, name: 'other' }])).toBe(true);
    expect(operationsWiden([op], [{ ...op, requires: SCOPES.contentWrite }])).toBe(true);
    expect(operationsWiden(undefined, [op])).toBe(true);
    expect(operationsWiden([op], [])).toBe(false);
    expect(operationsWiden([op], [{ ...op, title: 'New title' }])).toBe(false);
  });
});

describe('the grant an operation runs with', () => {
  it('drops every capability whose scope the caller lacks, keeping the scope-free ones', () => {
    const viewer = (s: string) => s === SCOPES.previewRead || s === SCOPES.assetsRead;
    expect(
      operationGrant(['content:read', 'content:write', 'network:request', 'kv:storage'], viewer),
    ).toEqual(['content:read', 'network:request', 'kv:storage']);
  });
});

describe('hardening', () => {
  it('reads only a schema’s own properties, so prototype names are undeclared, not a crash', () => {
    for (const name of ['constructor', 'toString', '__proto__']) {
      const value = JSON.parse(`{"title":"ok","${name}":1}`);
      expect(operationValueIssues(input, value, 'input').map((i) => i.field)).toEqual([
        `input.${name}`,
      ]);
    }
  });

  it('refuses `required` naming an inherited property', () => {
    expect(
      operationSchemaIssues({ type: 'object', properties: {}, required: ['constructor'] }, 'input'),
    ).toHaveLength(1);
  });

  it('refuses an operation callable with a public delivery key', () => {
    for (const requires of [SCOPES.deliveryRead, SCOPES.searchRead]) {
      expect(issuesOf(manifest({ operations: [{ ...op, requires }] }))).toEqual([
        'operations[0].requires',
      ]);
    }
  });
});
