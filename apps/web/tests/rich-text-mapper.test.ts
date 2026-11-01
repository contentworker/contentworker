import type { RichTextDocument, RichTextNode } from '@contentworker/domain';
import { getSchema } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { buildExtensions } from '~/cms/components/rich-text/extensions';
import { type PmNode, toDocument, toTiptap } from '~/cms/lib/rich-text-mapper';

const doc = (content: RichTextNode[]): RichTextDocument => ({ nodeType: 'document', content });

const text = (value: string, marks: { type: string }[] = []): RichTextNode => ({
  nodeType: 'text',
  value,
  marks,
});

const paragraph = (...content: RichTextNode[]): RichTextNode => ({
  nodeType: 'paragraph',
  content,
});

const embeddedEntry = (id: string): RichTextNode => ({
  nodeType: 'embedded-entry-block',
  data: { target: { id, linkType: 'Entry' } },
  content: [],
});

/** Documents in the exact shape the previous block editor emitted. */
const oldEditorCorpus: RichTextDocument = doc([
  { nodeType: 'heading-1', content: [text('Title')] },
  paragraph(text('Intro paragraph')),
  { nodeType: 'heading-2', content: [text('Section')] },
  embeddedEntry('e1'),
  {
    nodeType: 'embedded-asset-block',
    data: { target: { id: 'a1', linkType: 'Asset' } },
    content: [],
  },
  paragraph(text('Outro')),
]);

describe('rich-text mapper round-trips', () => {
  it('round-trips the old-editor corpus unchanged', () => {
    expect(toDocument(toTiptap(oldEditorCorpus))).toEqual(oldEditorCorpus);
  });

  it('round-trips marks, preserving bold/italic/underline/code/strikethrough', () => {
    const value = doc([
      paragraph(
        text('plain '),
        text('bold', [{ type: 'bold' }]),
        text(' and ', []),
        text('mixed', [{ type: 'italic' }, { type: 'strikethrough' }]),
      ),
    ]);
    expect(toDocument(toTiptap(value))).toEqual(value);
  });

  it('round-trips lists, code blocks, and horizontal rules', () => {
    const value = doc([
      {
        nodeType: 'unordered-list',
        content: [
          { nodeType: 'list-item', content: [paragraph(text('One'))] },
          { nodeType: 'list-item', content: [paragraph(text('Two'))] },
        ],
      },
      {
        nodeType: 'ordered-list',
        content: [{ nodeType: 'list-item', content: [paragraph(text('First'))] }],
      },
      { nodeType: 'code-block', content: [text('const x = 1;')], data: { language: 'ts' } },
      { nodeType: 'hr', content: [] },
      paragraph(text('after')),
    ]);
    expect(toDocument(toTiptap(value))).toEqual(value);
  });

  it('converts hyperlink nodes to link marks and groups them back', () => {
    const value = doc([
      paragraph(
        text('See '),
        {
          nodeType: 'hyperlink',
          data: { uri: 'https://example.com' },
          content: [text('the docs', [{ type: 'bold' }]), text(' here')],
        },
        text(' for more.'),
      ),
    ]);
    const pm = toTiptap(value);
    const inline = pm.content?.[0]?.content ?? [];
    // Flattened: link text carries a link mark alongside its other marks.
    expect(inline.map((n) => n.text)).toEqual(['See ', 'the docs', ' here', ' for more.']);
    expect(inline[1]?.marks).toEqual([
      { type: 'bold' },
      { type: 'link', attrs: { href: 'https://example.com' } },
    ]);
    expect(toDocument(pm)).toEqual(value);
  });

  it('splits adjacent links with different targets into separate hyperlink nodes', () => {
    const pm: PmNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a', marks: [{ type: 'link', attrs: { href: 'https://a' } }] },
            { type: 'text', text: 'b', marks: [{ type: 'link', attrs: { href: 'https://b' } }] },
          ],
        },
      ],
    };
    expect(toDocument(pm)?.content[0]?.content).toEqual([
      { nodeType: 'hyperlink', data: { uri: 'https://a' }, content: [text('a')] },
      { nodeType: 'hyperlink', data: { uri: 'https://b' }, content: [text('b')] },
    ]);
  });

  it('round-trips unknown block and inline nodes byte-identically', () => {
    const table: RichTextNode = {
      nodeType: 'table',
      content: [{ nodeType: 'table-row', content: [text('cell')] }],
      data: { rows: 1 },
    };
    const footnote: RichTextNode = {
      nodeType: 'footnote-ref',
      data: { note: 'n1' },
      content: [],
    };
    const value = doc([table, paragraph(text('before '), footnote, text(' after'))]);
    expect(toDocument(toTiptap(value))).toEqual(value);
  });

  it('round-trips entry and asset hyperlinks as first-class marks', () => {
    const value = doc([
      paragraph(
        text('see '),
        {
          nodeType: 'entry-hyperlink',
          data: { target: { id: 'e9', linkType: 'Entry' } },
          content: [text('the entry', [{ type: 'bold' }])],
        },
        text(' and '),
        {
          nodeType: 'asset-hyperlink',
          data: { target: { id: 'a3', linkType: 'Asset' } },
          content: [text('the asset')],
        },
      ),
    ]);
    const pm = toTiptap(value);
    const inline = pm.content?.[0]?.content ?? [];
    expect(inline[1]?.marks).toEqual([
      { type: 'bold' },
      { type: 'entryLink', attrs: { targetId: 'e9' } },
    ]);
    expect(toDocument(pm)).toEqual(value);
  });

  it('round-trips an inline entry embed mid-sentence', () => {
    const value = doc([
      paragraph(
        text('as shown in '),
        {
          nodeType: 'embedded-entry-inline',
          data: { target: { id: 'e7', linkType: 'Entry' } },
          content: [],
        },
        text(' above'),
      ),
    ]);
    expect(toDocument(toTiptap(value))).toEqual(value);
  });

  it('keeps the innermost link when reference links nest inside a hyperlink', () => {
    const value = doc([
      paragraph({
        nodeType: 'hyperlink',
        data: { uri: 'https://outer' },
        content: [
          text('plain'),
          {
            nodeType: 'entry-hyperlink',
            data: { target: { id: 'e1', linkType: 'Entry' } },
            content: [text('inner')],
          },
        ],
      }),
    ]);
    // The outer hyperlink survives around 'plain'; 'inner' keeps its entry link.
    expect(toDocument(toTiptap(value))).toEqual(
      doc([
        paragraph(
          { nodeType: 'hyperlink', data: { uri: 'https://outer' }, content: [text('plain')] },
          {
            nodeType: 'entry-hyperlink',
            data: { target: { id: 'e1', linkType: 'Entry' } },
            content: [text('inner')],
          },
        ),
      ]),
    );
  });

  it('resolves stacked link marks by priority (entryLink over link) and strips both', () => {
    const pm: PmNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'both',
              marks: [
                { type: 'link', attrs: { href: 'https://x' } },
                { type: 'entryLink', attrs: { targetId: 'e1' } },
              ],
            },
          ],
        },
      ],
    };
    expect(toDocument(pm)?.content[0]?.content).toEqual([
      {
        nodeType: 'entry-hyperlink',
        data: { target: { id: 'e1', linkType: 'Entry' } },
        content: [text('both')],
      },
    ]);
  });

  it('carries malformed reference links (no target) through raw', () => {
    const value = doc([
      paragraph({ nodeType: 'entry-hyperlink', data: {}, content: [text('broken')] }),
    ]);
    expect(toDocument(toTiptap(value))).toEqual(value);
  });

  it('carries hyperlinks without a uri through raw (never dropped, though validation refuses them)', () => {
    const value = doc([
      paragraph(
        text('before '),
        { nodeType: 'hyperlink', data: {}, content: [text('bare')] },
        { nodeType: 'hyperlink', data: { uri: '' }, content: [text('empty')] },
      ),
    ]);
    expect(toDocument(toTiptap(value))).toEqual(value);
  });

  it('does not let a valueless inner link strip a valid outer reference link', () => {
    const value = doc([
      paragraph({
        nodeType: 'entry-hyperlink',
        data: { target: { id: 'e1', linkType: 'Entry' } },
        content: [text('a'), { nodeType: 'hyperlink', data: {}, content: [text('b')] }, text('c')],
      }),
    ]);
    const out = toDocument(toTiptap(value));
    // The outer entry link must survive around the raw inner node.
    expect(JSON.stringify(out)).toContain('entry-hyperlink');
    expect(JSON.stringify(out)).toContain('"value":"a"');
    expect(JSON.stringify(out)).toContain('"value":"b"');
  });

  it('wraps stray inline children of block containers in a paragraph', () => {
    // The previous editor emitted blockquotes with direct text children.
    const legacy = doc([{ nodeType: 'blockquote', content: [text('quoted')] }]);
    expect(toDocument(toTiptap(legacy))).toEqual(
      doc([{ nodeType: 'blockquote', content: [paragraph(text('quoted'))] }]),
    );
  });

  it('returns undefined for empty documents', () => {
    expect(toDocument({ type: 'doc', content: [{ type: 'paragraph' }] })).toBeUndefined();
    expect(toDocument({ type: 'doc', content: [] })).toBeUndefined();
    expect(toDocument(toTiptap(undefined))).toBeUndefined();
    expect(toDocument(toTiptap('not a document'))).toBeUndefined();
  });

  it('drops embeds without a target on serialize', () => {
    const pm: PmNode = {
      type: 'doc',
      content: [
        { type: 'embeddedEntryBlock', attrs: { targetId: '' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'kept' }] },
      ],
    };
    expect(toDocument(pm)).toEqual(doc([paragraph(text('kept'))]));
  });
});

describe('mapper output is schema-legal', () => {
  const schema = getSchema(buildExtensions());
  const fixtures: Record<string, unknown> = {
    'old-editor corpus': oldEditorCorpus,
    'marks and links': doc([
      paragraph(text('x', [{ type: 'bold' }, { type: 'code' }]), {
        nodeType: 'hyperlink',
        data: { uri: 'https://x' },
        content: [text('y')],
      }),
    ]),
    'lists and code': doc([
      {
        nodeType: 'unordered-list',
        content: [{ nodeType: 'list-item', content: [paragraph(text('i'))] }],
      },
      { nodeType: 'code-block', content: [text('code')] },
      { nodeType: 'hr', content: [] },
    ]),
    'unknown nodes': doc([
      { nodeType: 'table', content: [], data: { x: 1 } },
      paragraph(text('a'), { nodeType: 'footnote-ref', data: { note: 'n1' }, content: [] }),
    ]),
    'reference links and inline embeds': doc([
      paragraph(
        {
          nodeType: 'entry-hyperlink',
          data: { target: { id: 'e1', linkType: 'Entry' } },
          content: [text('entry')],
        },
        {
          nodeType: 'asset-hyperlink',
          data: { target: { id: 'a1', linkType: 'Asset' } },
          content: [text('asset')],
        },
        {
          nodeType: 'embedded-entry-inline',
          data: { target: { id: 'e2', linkType: 'Entry' } },
          content: [],
        },
      ),
    ]),
    'nested links': doc([
      paragraph({
        nodeType: 'hyperlink',
        data: { uri: 'https://outer' },
        content: [
          {
            nodeType: 'entry-hyperlink',
            data: { target: { id: 'e1', linkType: 'Entry' } },
            content: [text('inner')],
          },
        ],
      }),
    ]),
    // API-authored shapes that need normalizing to satisfy content expressions.
    'list without list-items': doc([
      { nodeType: 'unordered-list', content: [paragraph(text('loose'))] },
      { nodeType: 'ordered-list', content: [text('bare inline')] },
    ]),
    'orphan list-item': doc([{ nodeType: 'list-item', content: [paragraph(text('stray'))] }]),
    'hyperlink with hard break': doc([
      paragraph({
        nodeType: 'hyperlink',
        data: { uri: 'https://x' },
        content: [text('a'), { nodeType: 'hard-break' }, text('b')],
      }),
    ]),
    empty: undefined,
  };

  for (const [name, value] of Object.entries(fixtures)) {
    it(`accepts ${name}`, () => {
      // check() enforces content expressions (nodeFromJSON alone does not).
      expect(() => schema.nodeFromJSON(toTiptap(value)).check()).not.toThrow();
    });
  }
});

describe('mapper normalization of API-authored shapes', () => {
  it('wraps loose list children in list items', () => {
    const value = doc([{ nodeType: 'unordered-list', content: [paragraph(text('loose'))] }]);
    expect(toDocument(toTiptap(value))).toEqual(
      doc([
        {
          nodeType: 'unordered-list',
          content: [{ nodeType: 'list-item', content: [paragraph(text('loose'))] }],
        },
      ]),
    );
  });

  it('resolves exclusive-mark conflicts: code wins over formatting, link over code', () => {
    const value = doc([
      paragraph(text('both', [{ type: 'bold' }, { type: 'code' }]), {
        nodeType: 'hyperlink',
        data: { uri: 'https://x' },
        content: [text('linked code', [{ type: 'code' }])],
      }),
    ]);
    expect(toDocument(toTiptap(value))).toEqual(
      doc([
        paragraph(text('both', [{ type: 'code' }]), {
          nodeType: 'hyperlink',
          data: { uri: 'https://x' },
          content: [text('linked code')],
        }),
      ]),
    );
  });

  it('keeps a hyperlink containing a hard break as one node on round trip', () => {
    const value = doc([
      paragraph({
        nodeType: 'hyperlink',
        data: { uri: 'https://x' },
        content: [text('a'), { nodeType: 'hard-break' }, text('b')],
      }),
    ]);
    expect(toDocument(toTiptap(value))).toEqual(value);
  });
});
