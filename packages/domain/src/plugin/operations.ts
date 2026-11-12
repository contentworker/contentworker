import { type PermissionScope, SCOPES } from '../auth/auth';
import { DomainError } from '../errors';

/**
 * Plugin operations: named, typed calls a plugin offers to API clients and agents (manifest v2).
 *
 * A hook runs inside someone else's write; an operation is something a caller asks for by name
 * (`POST …/apps/:plugin/operations/:op`, or MCP's `app_operation_invoke`). The manifest declares
 * each one with the scope a caller must hold and the JSON shape of its input and output, so REST,
 * OpenAPI and MCP are all generated from that one declaration and both surfaces stay equal.
 *
 * An operation never adds authority. It runs with the plugin's approved grant narrowed to what the
 * caller holds (`operationGrant`), under the caller's content grants: a caller who cannot write
 * cannot make a plugin write for them.
 */

/**
 * How an operation runs. `sync` answers within the request (about 10 s); `async` is accepted at
 * once as a job (`AppOperationJob`) that the engine runs on a durable Workflow, and its caller
 * polls for the output.
 */
export const PLUGIN_OPERATION_MODES = ['sync', 'async'] as const;
export type PluginOperationMode = (typeof PLUGIN_OPERATION_MODES)[number];

/** One operation a manifest declares. */
export interface PluginOperation {
  /** Stable name, as callers address it: `renderHtml`, `schedule_post`. */
  readonly name: string;
  readonly title: string;
  /** What it does, for the consent screen, the OpenAPI document and an agent choosing a tool. */
  readonly description: string;
  /** The scope a caller must hold to invoke it. */
  readonly requires: PermissionScope;
  /** The input, an `object` schema in the subset {@link OperationSchema} describes. */
  readonly input: OperationSchema;
  /** The output, checked before it is returned. Absent: any JSON value. */
  readonly output?: OperationSchema;
  /** Defaults to `sync`. An `async` operation returns a job, its output read from the job later. */
  readonly mode?: PluginOperationMode;
}

/**
 * The JSON Schema subset operations are described in: enough for real inputs, small enough to
 * validate by hand in the domain and to hand an MCP client unchanged. Objects are closed (no
 * properties beyond those declared), every node may carry a `description`, and nothing else
 * (`$ref`, `oneOf`, `pattern`, `format`) is accepted, so what a human approves is what is checked.
 */
export type OperationSchema =
  | {
      readonly type: 'object';
      readonly properties: Readonly<Record<string, OperationSchema>>;
      readonly required?: readonly string[];
      readonly description?: string;
    }
  | {
      readonly type: 'array';
      readonly items: OperationSchema;
      readonly maxItems?: number;
      readonly description?: string;
    }
  | {
      readonly type: 'string';
      readonly enum?: readonly string[];
      readonly minLength?: number;
      readonly maxLength?: number;
      readonly description?: string;
    }
  | {
      readonly type: 'number' | 'integer';
      readonly minimum?: number;
      readonly maximum?: number;
      readonly description?: string;
    }
  | { readonly type: 'boolean'; readonly description?: string };

/** Longest a caller's input or a plugin's output may be, serialized. */
export const MAX_OPERATION_PAYLOAD_BYTES = 64 * 1024;
/** Operations one manifest may declare. */
export const MAX_PLUGIN_OPERATIONS = 32;
/** How deep a schema may nest. */
const MAX_SCHEMA_DEPTH = 8;
const NAME_PATTERN = /^[a-z][a-zA-Z0-9_]{0,63}$/;
/** Scopes public delivery keys hold, which an operation may not require. */
const PUBLIC_SCOPES: readonly string[] = [SCOPES.deliveryRead, SCOPES.searchRead];
const KEYS: Record<string, readonly string[]> = {
  object: ['type', 'properties', 'required', 'description'],
  array: ['type', 'items', 'maxItems', 'description'],
  string: ['type', 'enum', 'minLength', 'maxLength', 'description'],
  number: ['type', 'minimum', 'maximum', 'description'],
  integer: ['type', 'minimum', 'maximum', 'description'],
  boolean: ['type', 'description'],
};

type Issue = { field: string; message: string };

/** What is wrong with a schema, as validation issues under `field`. */
export function operationSchemaIssues(schema: unknown, field: string, depth = 0): Issue[] {
  if (depth > MAX_SCHEMA_DEPTH)
    return [{ field, message: `nests deeper than ${MAX_SCHEMA_DEPTH}` }];
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return [{ field, message: 'must be a schema object' }];
  }
  const s = schema as Record<string, unknown>;
  const allowed = typeof s.type === 'string' ? KEYS[s.type] : undefined;
  if (!allowed) {
    return [{ field, message: 'type must be object, array, string, number, integer or boolean' }];
  }
  const issues: Issue[] = [];
  for (const key of Object.keys(s)) {
    if (!allowed.includes(key)) issues.push({ field, message: `"${key}" is not supported` });
  }
  if (s.description !== undefined && typeof s.description !== 'string') {
    issues.push({ field, message: 'description must be a string' });
  }
  const nonNegative = (k: string) => {
    const v = s[k];
    if (v !== undefined && !(Number.isInteger(v) && (v as number) >= 0)) {
      issues.push({ field, message: `${k} must be a non-negative integer` });
    }
  };
  switch (s.type) {
    case 'object': {
      const props = s.properties;
      if (typeof props !== 'object' || props === null || Array.isArray(props)) {
        issues.push({ field, message: 'properties is required' });
        break;
      }
      for (const [name, child] of Object.entries(props)) {
        issues.push(...operationSchemaIssues(child, `${field}.${name}`, depth + 1));
      }
      if (s.required !== undefined) {
        if (!Array.isArray(s.required)) issues.push({ field, message: 'required must be a list' });
        else
          for (const name of s.required) {
            if (typeof name !== 'string' || !Object.hasOwn(props, name)) {
              issues.push({ field, message: `required names "${String(name)}", not a property` });
            }
          }
      }
      break;
    }
    case 'array':
      issues.push(...operationSchemaIssues(s.items, `${field}[]`, depth + 1));
      nonNegative('maxItems');
      break;
    case 'string':
      if (
        s.enum !== undefined &&
        !(Array.isArray(s.enum) && s.enum.length > 0 && s.enum.every((v) => typeof v === 'string'))
      ) {
        issues.push({ field, message: 'enum must be a non-empty list of strings' });
      }
      nonNegative('minLength');
      nonNegative('maxLength');
      break;
    case 'number':
    case 'integer':
      for (const k of ['minimum', 'maximum']) {
        if (s[k] !== undefined && typeof s[k] !== 'number') {
          issues.push({ field, message: `${k} must be a number` });
        }
      }
      break;
  }
  return issues;
}

/**
 * What is wrong with `value` against `schema` (a schema that passed {@link operationSchemaIssues}),
 * as issues under `field`. Closed objects: an undeclared property is an issue, not ignored.
 */
export function operationValueIssues(
  schema: OperationSchema,
  value: unknown,
  field: string,
): Issue[] {
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return [{ field, message: 'must be an object' }];
      }
      const v = value as Record<string, unknown>;
      const issues: Issue[] = [];
      for (const name of schema.required ?? []) {
        if (!Object.hasOwn(v, name) || v[name] === undefined) {
          issues.push({ field: `${field}.${name}`, message: 'is required' });
        }
      }
      for (const [name, child] of Object.entries(v)) {
        // Own properties only: `constructor` or `__proto__` must not resolve to Object's.
        const sub = Object.hasOwn(schema.properties, name) ? schema.properties[name] : undefined;
        if (!sub) issues.push({ field: `${field}.${name}`, message: 'is not a declared property' });
        else if (child !== undefined) {
          issues.push(...operationValueIssues(sub, child, `${field}.${name}`));
        }
      }
      return issues;
    }
    case 'array': {
      if (!Array.isArray(value)) return [{ field, message: 'must be a list' }];
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return [{ field, message: `at most ${schema.maxItems} items` }];
      }
      return value.flatMap((item, i) => operationValueIssues(schema.items, item, `${field}[${i}]`));
    }
    case 'string': {
      if (typeof value !== 'string') return [{ field, message: 'must be a string' }];
      if (schema.enum && !schema.enum.includes(value)) {
        return [{ field, message: `must be one of ${schema.enum.join(', ')}` }];
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        return [{ field, message: `at least ${schema.minLength} characters` }];
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        return [{ field, message: `at most ${schema.maxLength} characters` }];
      }
      return [];
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return [{ field, message: 'must be a number' }];
      }
      if (schema.type === 'integer' && !Number.isInteger(value)) {
        return [{ field, message: 'must be an integer' }];
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        return [{ field, message: `at least ${schema.minimum}` }];
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        return [{ field, message: `at most ${schema.maximum}` }];
      }
      return [];
    }
    case 'boolean':
      return typeof value === 'boolean' ? [] : [{ field, message: 'must be true or false' }];
    default:
      return [{ field, message: 'has an unsupported schema' }];
  }
}

/** What is wrong with a manifest's `operations`, as validation issues. */
export function operationsIssues(operations: unknown, manifestVersion: unknown): Issue[] {
  if (operations === undefined) return [];
  if (manifestVersion !== 2) {
    return [{ field: 'operations', message: 'operations need manifestVersion 2' }];
  }
  if (!Array.isArray(operations)) return [{ field: 'operations', message: 'must be a list' }];
  if (operations.length > MAX_PLUGIN_OPERATIONS) {
    return [{ field: 'operations', message: `At most ${MAX_PLUGIN_OPERATIONS} operations` }];
  }
  const issues: Issue[] = [];
  const seen = new Set<string>();
  const scopes = Object.values(SCOPES) as string[];
  operations.forEach((raw, i) => {
    const field = `operations[${i}]`;
    if (typeof raw !== 'object' || raw === null) {
      issues.push({ field, message: 'must be an object' });
      return;
    }
    const op = raw as Record<string, unknown>;
    const name = typeof op.name === 'string' ? op.name : '';
    if (!NAME_PATTERN.test(name)) {
      issues.push({
        field: `${field}.name`,
        message: 'name must start with a lowercase letter: letters, digits and _ (64 at most)',
      });
    } else if (seen.has(name)) {
      issues.push({ field: `${field}.name`, message: `Duplicate operation "${name}"` });
    }
    seen.add(name);
    if (typeof op.title !== 'string' || !op.title.trim()) {
      issues.push({ field: `${field}.title`, message: 'title is required' });
    }
    if (typeof op.description !== 'string' || !op.description.trim()) {
      issues.push({ field: `${field}.description`, message: 'description is required' });
    }
    if (typeof op.requires !== 'string' || !scopes.includes(op.requires)) {
      issues.push({ field: `${field}.requires`, message: 'requires must be a permission scope' });
    } else if (PUBLIC_SCOPES.includes(op.requires)) {
      // Delivery and search keys ship inside public front ends. An operation runs plugin code
      // with the operator's network access, storage and secrets, so it is never callable with one.
      issues.push({
        field: `${field}.requires`,
        message: `${op.requires} is held by public delivery keys; require preview:read or above`,
      });
    }
    if (
      op.mode !== undefined &&
      !(PLUGIN_OPERATION_MODES as readonly unknown[]).includes(op.mode)
    ) {
      issues.push({ field: `${field}.mode`, message: 'mode must be sync or async' });
    }
    const input = operationSchemaIssues(op.input, `${field}.input`);
    issues.push(...input);
    if (input.length === 0 && (op.input as { type: string }).type !== 'object') {
      issues.push({ field: `${field}.input`, message: 'input must be an object schema' });
    }
    if (op.output !== undefined)
      issues.push(...operationSchemaIssues(op.output, `${field}.output`));
  });
  return issues;
}

/** What decides whether an operation is new to callers: its name and who may call it. */
type OperationKey = { readonly name: string; readonly requires: string };

/**
 * True when `op` offers callers something `previous` did not: it is new, or its `requires`
 * changed (who may trigger it is part of what was approved).
 */
export function operationIsNew(
  previous: readonly OperationKey[] | undefined,
  op: OperationKey,
): boolean {
  return previous?.find((p) => p.name === op.name)?.requires !== op.requires;
}

/**
 * True when `next` offers callers something `previous` did not ({@link operationIsNew}). An
 * upgrade that does this is installed disabled, as one asking for more capabilities is.
 */
export function operationsWiden(
  previous: readonly OperationKey[] | undefined,
  next: readonly OperationKey[] | undefined,
): boolean {
  return (next ?? []).some((op) => operationIsNew(previous, op));
}

/** The operations `previous` offered that `next` no longer does, by name. */
export function removedOperations(
  previous: readonly OperationKey[] | undefined,
  next: readonly OperationKey[] | undefined,
): string[] {
  const kept = new Set((next ?? []).map((op) => op.name));
  return (previous ?? []).filter((op) => !kept.has(op.name)).map((op) => op.name);
}

/**
 * A plugin operation failed: it threw, ran past its time, or answered outside its declared output.
 * The plugin's fault, not the caller's, so the HTTP API answers 502.
 */
export class AppOperationFailedError extends DomainError {
  constructor(plugin: string, operation: string, reason: string) {
    super('app_operation_failed', `${plugin} ${operation} failed: ${reason}`, {
      plugin,
      operation,
    });
  }
}
