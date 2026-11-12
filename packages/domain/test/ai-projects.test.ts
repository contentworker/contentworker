import { describe, expect, it } from 'vitest';
import {
  AI_PROJECT_MAX_REFERENCES,
  type AiProject,
  aiProjectNameKey,
  aiProjectPartsFor,
  checkAiProjectInput,
  decodeUtf8Range,
  diffAiProjects,
  takesAiProject,
  ValidationError,
} from '../src/index';

const issuesOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ValidationError) return err.issues.map((i) => i.field);
    throw err;
  }
  return [];
};

const project = (over: Partial<AiProject> = {}): AiProject => ({
  id: 'p1',
  name: 'Northwind launch',
  description: null,
  instructions: 'Say "spec sheet", never "datasheet".',
  writer: { name: 'Northwind product team', description: 'Plain, confident.' },
  reader: null,
  references: [{ assetId: 'a1', version: 1 }],
  isDefault: false,
  version: 1,
  createdAt: '2026-11-11T00:00:00.000Z',
  createdBy: 'ed@example.com',
  updatedAt: '2026-11-11T00:00:00.000Z',
  updatedBy: 'ed@example.com',
  ...over,
});

describe('AI project input', () => {
  it('normalizes what it keeps: names on one line, text trimmed, empty text as null', () => {
    const draft = checkAiProjectInput({
      name: '  Northwind   launch ',
      description: '  ',
      instructions: 'Line one\r\nLine two  ',
      writer: { name: ' Team ', description: ' Plain. ' },
      reader: null,
      references: [{ assetId: 'a1' }, { assetId: 'a2', version: 3 }],
    });
    expect(draft).toEqual({
      name: 'Northwind launch',
      description: null,
      instructions: 'Line one\nLine two',
      writer: { name: 'Team', description: 'Plain.' },
      reader: null,
      references: [{ assetId: 'a1' }, { assetId: 'a2', version: 3 }],
    });
  });

  it('names each part out of bounds, whatever surface sent it', () => {
    expect(
      issuesOf(() =>
        checkAiProjectInput({
          name: 'x'.repeat(101),
          description: 'd'.repeat(501),
          instructions: 'i'.repeat(4001),
          writer: { name: '', description: 'ok' },
          reader: { name: 'Lead', description: 'r'.repeat(1001) },
          references: [{ assetId: 'a1' }, { assetId: 'a1' }, { assetId: 'a2', version: 0 }],
        }),
      ),
    ).toEqual([
      'name',
      'description',
      'instructions',
      'writer.name',
      'reader.description',
      'references[1].assetId',
      'references[2].version',
    ]);
    expect(issuesOf(() => checkAiProjectInput({ name: '' }))).toEqual(['name']);
  });

  it('holds a project to ten references', () => {
    const refs = Array.from({ length: AI_PROJECT_MAX_REFERENCES + 1 }, (_, i) => ({
      assetId: `a${i}`,
    }));
    expect(issuesOf(() => checkAiProjectInput({ name: 'P', references: refs }))).toEqual([
      'references',
    ]);
  });

  it('compares names case-folded, so "Northwind" and "NORTHWIND " are one name', () => {
    expect(aiProjectNameKey('NORTHWIND  Launch ')).toBe(aiProjectNameKey('northwind launch'));
  });
});

describe('capabilities that take a project', () => {
  it('are the six of decision 6, amended: not media, search or workflows', () => {
    expect(takesAiProject('drafting')).toBe(true);
    expect(takesAiProject('agents')).toBe(true);
    expect(takesAiProject('media')).toBe(false);
    expect(takesAiProject('search')).toBe(false);
    expect(takesAiProject('workflows')).toBe(false);
  });

  it('give translation the instructions and the reader only', () => {
    expect(aiProjectPartsFor('translation')).toEqual({
      instructions: true,
      writer: false,
      reader: true,
      references: false,
    });
    expect(aiProjectPartsFor('drafting').references).toBe(true);
  });
});

describe('the audit diff of a project', () => {
  it('names the parts and the pins that moved, never the text', () => {
    const before = project();
    const after = project({
      version: 2,
      instructions: 'Something else',
      references: [
        { assetId: 'a1', version: 2 },
        { assetId: 'a3', version: 1 },
      ],
    });
    const change = diffAiProjects(before, after);
    expect(change).toEqual({
      projectId: 'p1',
      from: 1,
      to: 2,
      changed: ['instructions', 'references'],
      references: [
        { assetId: 'a1', from: 1, to: 2 },
        { assetId: 'a3', from: null, to: 1 },
      ],
    });
    expect(JSON.stringify(change)).not.toContain('Something else');
  });

  it('reads deleting the default as a default change too', () => {
    const change = diffAiProjects(project({ isDefault: true }), null);
    expect(change.to).toBe(0);
    expect(change.changed).toContain('isDefault');
    expect(change.references).toEqual([{ assetId: 'a1', from: 1, to: null }]);
  });
});

describe('a ranged read of UTF-8 text', () => {
  const bytes = new TextEncoder().encode('aé日𝄞z');
  // a(1) é(2) 日(3) 𝄞(4) z(1): offsets 0, 1, 3, 6, 10.

  it('rounds the start forward past a split character', () => {
    expect(decodeUtf8Range(bytes.subarray(2), 2)).toEqual({ text: '日𝄞z', start: 3, end: 11 });
  });

  it('rounds the end back before a character the range only holds part of', () => {
    expect(decodeUtf8Range(bytes.subarray(0, 8), 0)).toEqual({ text: 'aé日', start: 0, end: 6 });
  });

  it('gives the next read its start, so pages join with nothing lost or doubled', () => {
    let at = 0;
    let text = '';
    while (at < bytes.length) {
      const page = decodeUtf8Range(bytes.subarray(at, at + 4), at);
      text += page.text;
      at = page.end > at ? page.end : at + 4;
    }
    expect(text).toBe('aé日𝄞z');
  });
});
