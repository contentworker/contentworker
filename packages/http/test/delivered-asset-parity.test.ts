/**
 * The delivered asset is declared four times: the domain's projection (what the api sends), the
 * zod schema behind the OpenAPI document, sdk-core's interface and codegen's prelude (what
 * clients compile against). Nothing else ties them together, so a field added to one and not
 * the others would ship as a silent gap; this compares their keys, optionality and the keys of
 * their inline objects.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateTypes } from '@contentworker/sdk-codegen';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { deliveredAsset } from '../src/api/docs/schemas';

interface Key {
  readonly optional: boolean;
  /** An inline object's own keys (`{ x, y } | null`, `{ width, url }[]`); absent for a named type. */
  readonly children?: Shape;
}
type Shape = Record<string, Key>;

/** The body of `export interface DeliveredAsset { … }` in a TypeScript source. */
function interfaceBody(source: string): string {
  const start = source.indexOf('export interface DeliveredAsset {');
  if (start < 0) {
    throw new Error(
      'no `export interface DeliveredAsset {` found: if it became a type alias or extends another, update this test to read the new shape',
    );
  }
  const open = source.indexOf('{', start);
  return source.slice(open, matchingBrace(source, open) + 1);
}

function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  throw new Error('unbalanced braces');
}

/** The top-level members of an object type literal, `{ … }`, comments ignored. */
function parseShape(literal: string): Shape {
  const body = literal
    .slice(1, -1)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const shape: Shape = {};
  let i = 0;
  while (i < body.length) {
    const m = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)(\??)\s*:\s*/.exec(body.slice(i));
    if (!m) break;
    i += m[0].length;
    const typeStart = i;
    let depth = 0;
    for (; i < body.length; i++) {
      const c = body[i];
      if (c === '{' || c === '(' || c === '[' || c === '<') depth++;
      else if (c === '}' || c === ')' || c === ']' || c === '>') depth--;
      else if (c === ';' && depth === 0) break;
    }
    const type = body.slice(typeStart, i).trim();
    i++;
    const inline = /^(?:Readonly<\s*)?(?:readonly\s+)?\{/.exec(type);
    const open = inline ? type.indexOf('{') : -1;
    shape[m[1] as string] = {
      optional: m[2] === '?',
      ...(open >= 0
        ? { children: parseShape(type.slice(open, matchingBrace(type, open) + 1)) }
        : {}),
    };
  }
  return shape;
}

type Schema = z.ZodType & { def: { type: string; innerType?: Schema; element?: Schema } };

/** The zod object a field holds, through `.optional()`, `.nullable()` and arrays. */
function objectOf(schema: Schema): z.ZodObject | undefined {
  const def = schema.def;
  if (def.type === 'object') return schema as unknown as z.ZodObject;
  if ((def.type === 'optional' || def.type === 'nullable') && def.innerType) {
    return objectOf(def.innerType);
  }
  if (def.type === 'array' && def.element) return objectOf(def.element);
  return undefined;
}

function zodShape(schema: z.ZodObject): Shape {
  const shape: Shape = {};
  for (const [name, field] of Object.entries(schema.shape)) {
    const inner = objectOf(field as Schema);
    shape[name] = {
      optional: (field as Schema).safeParse(undefined).success,
      // A record has no fixed keys to compare.
      ...(inner ? { children: zodShape(inner) } : {}),
    };
  }
  return shape;
}

/** `a`'s shape with inline children kept only where `b` also spells the object out inline. */
function comparable(a: Shape, b: Shape): Shape {
  const out: Shape = {};
  for (const [name, key] of Object.entries(a)) {
    const other = b[name];
    out[name] = {
      optional: key.optional,
      ...(key.children && other?.children
        ? { children: comparable(key.children, other.children) }
        : {}),
    };
  }
  return out;
}

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(here, path), 'utf8');

const definitions = {
  zod: zodShape(deliveredAsset),
  domain: parseShape(interfaceBody(read('../../domain/src/asset/delivered.ts'))),
  sdkCore: parseShape(interfaceBody(read('../../sdk/core/src/index.ts'))),
  codegen: parseShape(interfaceBody(generateTypes([]))),
};

describe('DeliveredAsset parity', () => {
  it('reads every definition (the parser found the fields)', () => {
    for (const shape of Object.values(definitions)) {
      expect(Object.keys(shape)).toEqual(expect.arrayContaining(['id', 'url', 'srcset', 'file']));
    }
    expect(definitions.codegen.video?.children?.thumbnailUrl).toEqual({ optional: true });
  });

  for (const name of ['domain', 'sdkCore', 'codegen'] as const) {
    it(`${name} has the zod schema's keys, optionality and inline object keys`, () => {
      const shape = definitions[name];
      expect(Object.keys(shape).sort()).toEqual(Object.keys(definitions.zod).sort());
      expect(comparable(shape, definitions.zod)).toEqual(comparable(definitions.zod, shape));
    });
  }

  it('the parser notices a missing, extra or newly optional key', () => {
    const drifted = parseShape('{ id: string; url?: string; extra: { a: number }; }');
    expect(drifted).toEqual({
      id: { optional: false },
      url: { optional: true },
      extra: { optional: false, children: { a: { optional: false } } },
    });
  });
});
