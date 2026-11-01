import { describe, expect, it } from 'vitest';
import {
  defineContentType,
  extractReferences,
  extractRichTextTargets,
  isRichTextDocument,
  MAX_RICH_TEXT_BYTES,
  MAX_RICH_TEXT_DEPTH,
  RICH_TEXT_BLOCK_NODE_TYPES,
  RICH_TEXT_INLINE_NODE_TYPES,
  type RichTextDocument,
  type RichTextNode,
  richTextToPlainText,
  safeLinkUri,
  validateEntryFields,
  validateRichText,
} from '../src/index';

const ctx = { defaultLocale: 'en-US', locales: ['en-US'] };

const doc = (content: RichTextDocument['content']): RichTextDocument => ({
  nodeType: 'document',
  content,
});

const paragraph = (text: string) => ({
  nodeType: 'paragraph',
  content: [{ nodeType: 'text', value: text, marks: [{ type: 'bold' }] }],
});

const embeddedEntry = (id: string) => ({
  nodeType: 'embedded-entry-block',
  data: { target: { id, linkType: 'Entry' as const } },
  content: [],
});

describe('rich text document', () => {
  it('recognises a well-formed document', () => {
    expect(isRichTextDocument(doc([paragraph('hi')]))).toBe(true);
    expect(isRichTextDocument({ nodeType: 'paragraph' })).toBe(false);
    expect(isRichTextDocument('not a doc')).toBe(false);
  });

  it('validates node structure and reference targets', () => {
    expect(validateRichText(doc([paragraph('ok')]))).toEqual([]);
    // A text node without a string value is invalid.
    expect(
      validateRichText(doc([{ nodeType: 'paragraph', content: [{ nodeType: 'text' }] }])),
    ).not.toEqual([]);
    // A reference node missing its target is invalid.
    expect(validateRichText(doc([{ nodeType: 'embedded-entry-block' }]))).not.toEqual([]);
  });

  it('accepts every node type in the vocabulary', () => {
    const text = { nodeType: 'text', value: 'x', marks: [] };
    const target = (linkType: 'Entry' | 'Asset') => ({ target: { id: 't1', linkType } });
    const node = (nodeType: string): RichTextNode => {
      if (nodeType === 'text') return text;
      if (nodeType === 'hyperlink')
        return { nodeType, data: { uri: 'https://example.com' }, content: [text] };
      if (nodeType.includes('asset')) return { nodeType, data: target('Asset'), content: [] };
      if (nodeType.includes('entry')) return { nodeType, data: target('Entry'), content: [] };
      return { nodeType, content: [text] };
    };
    const value = doc([
      ...RICH_TEXT_BLOCK_NODE_TYPES.map(node),
      { nodeType: 'paragraph', content: RICH_TEXT_INLINE_NODE_TYPES.map(node) },
    ]);
    expect(validateRichText(value)).toEqual([]);
  });

  it('refuses a node type outside the vocabulary, wherever it sits', () => {
    expect(validateRichText(doc([{ nodeType: 'script', content: [] }]))).toEqual([
      'content[0]: unknown nodeType "script"',
    ]);
    const nested = doc([
      {
        nodeType: 'paragraph',
        content: [{ nodeType: 'footnote-ref', data: { note: 'n1' }, content: [] }],
      },
    ]);
    expect(validateRichText(nested)).toEqual([
      'content[0].content[0]: unknown nodeType "footnote-ref"',
    ]);
    // A second root inside the tree is not a node type either.
    expect(validateRichText(doc([{ nodeType: 'document', content: [] }]))).not.toEqual([]);
  });

  it('refuses malformed content and data instead of throwing', () => {
    expect(validateRichText(doc([{ nodeType: 'paragraph', content: 'oops' } as never]))).toEqual([
      'content[0]: content must be an array',
    ]);
    expect(validateRichText(doc([{ nodeType: 'paragraph', data: 'x' } as never]))).toEqual([
      'content[0]: data must be an object',
    ]);
    expect(validateRichText(doc([null as never]))).toEqual([
      'content[0]: node is missing a nodeType',
    ]);
  });

  it('requires a hyperlink to carry a safe uri', () => {
    const link = (data: Record<string, unknown> | undefined) =>
      doc([
        {
          nodeType: 'paragraph',
          content: [{ nodeType: 'hyperlink', data, content: [{ nodeType: 'text', value: 'x' }] }],
        },
      ]);
    for (const uri of [
      'https://example.com/a?b=1&c=2',
      'mailto:a@example.com',
      '/relative',
      '#top',
    ])
      expect(validateRichText(link({ uri })), uri).toEqual([]);
    for (const data of [
      undefined,
      {},
      { uri: '' },
      { uri: 42 },
      { uri: 'javascript:alert(1)' },
      { uri: ' JaVaScRiPt:alert(1)' },
      { uri: 'java\tscript:alert(1)' },
      { uri: 'data:text/html,<script>alert(1)</script>' },
      { uri: 'vbscript:msgbox' },
      { uri: 'javascript&colon;alert(1)' },
    ]) {
      expect(validateRichText(link(data)), JSON.stringify(data)).toEqual([
        'content[0].content[0]: hyperlink requires data.uri with an http, https, mailto or tel URI',
      ]);
    }
  });

  it('shares one link-safety rule with the HTML import', () => {
    expect(safeLinkUri('  https://example.com  ')).toBe('https://example.com');
    expect(safeLinkUri('javascript:alert(1)')).toBeUndefined();
    expect(safeLinkUri(undefined)).toBeUndefined();
  });

  it('caps serialized size', () => {
    const big = 'x'.repeat(MAX_RICH_TEXT_BYTES);
    expect(validateRichText(doc([paragraph(big)]))).toEqual([
      `Rich text exceeds ${MAX_RICH_TEXT_BYTES} bytes`,
    ]);
    expect(validateRichText(doc([paragraph('x'.repeat(MAX_RICH_TEXT_BYTES / 2))]))).toEqual([]);
  });

  it('caps nesting depth', () => {
    const nest = (levels: number): RichTextNode => {
      let node: RichTextNode = {
        nodeType: 'paragraph',
        content: [{ nodeType: 'text', value: 'x' }],
      };
      for (let i = 1; i < levels; i++) node = { nodeType: 'blockquote', content: [node] };
      return node;
    };
    // The text node sits one level below the innermost paragraph.
    expect(validateRichText(doc([nest(MAX_RICH_TEXT_DEPTH - 1)]))).toEqual([]);
    const issues = validateRichText(doc([nest(MAX_RICH_TEXT_DEPTH)]));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(`nodes nest more than ${MAX_RICH_TEXT_DEPTH} deep`);
    // Far past the cap: refused, not a stack overflow.
    expect(validateRichText(doc([nest(10_000)]))).not.toEqual([]);
  });

  it('extracts embedded entry/asset targets (deep)', () => {
    const value = doc([
      paragraph('intro'),
      {
        nodeType: 'blockquote',
        content: [
          embeddedEntry('e2'),
          {
            nodeType: 'asset-hyperlink',
            data: { target: { id: 'a1', linkType: 'Asset' } },
            content: [],
          },
        ],
      },
    ]);
    expect(extractRichTextTargets(value)).toEqual([
      { id: 'e2', linkType: 'Entry' },
      { id: 'a1', linkType: 'Asset' },
    ]);
  });
});

describe('rich text plain-text extraction', () => {
  it('joins blocks with blank lines and ignores marks', () => {
    const value = doc([
      { nodeType: 'heading-1', content: [{ nodeType: 'text', value: 'Title' }] },
      paragraph('Body text'),
    ]);
    expect(richTextToPlainText(value)).toBe('Title\n\nBody text');
  });

  it('reads a block with inline nodes as one block', () => {
    const value = doc([
      {
        nodeType: 'paragraph',
        content: [
          { nodeType: 'text', value: 'See ' },
          {
            nodeType: 'hyperlink',
            data: { uri: 'https://example.com' },
            content: [{ nodeType: 'text', value: 'the docs' }],
          },
          { nodeType: 'text', value: ' for more.' },
        ],
      },
    ]);
    expect(richTextToPlainText(value)).toBe('See the docs for more.');
  });

  it('descends into nested block containers', () => {
    const value = doc([
      {
        nodeType: 'unordered-list',
        content: [
          {
            nodeType: 'list-item',
            content: [{ nodeType: 'paragraph', content: [{ nodeType: 'text', value: 'One' }] }],
          },
          {
            nodeType: 'list-item',
            content: [{ nodeType: 'paragraph', content: [{ nodeType: 'text', value: 'Two' }] }],
          },
        ],
      },
    ]);
    expect(richTextToPlainText(value)).toBe('One\n\nTwo');
  });

  it('renders hard breaks as newlines within a block', () => {
    const value = doc([
      {
        nodeType: 'paragraph',
        content: [
          { nodeType: 'text', value: 'line one' },
          { nodeType: 'hard-break' },
          { nodeType: 'text', value: 'line two' },
        ],
      },
    ]);
    expect(richTextToPlainText(value)).toBe('line one\nline two');
  });

  it('keeps a paragraph made only of hyperlinks as one block', () => {
    const value = doc([
      {
        nodeType: 'paragraph',
        content: [
          {
            nodeType: 'hyperlink',
            data: { uri: 'https://a' },
            content: [{ nodeType: 'text', value: 'Read' }],
          },
          {
            nodeType: 'hyperlink',
            data: { uri: 'https://b' },
            content: [{ nodeType: 'text', value: ' more' }],
          },
        ],
      },
    ]);
    expect(richTextToPlainText(value)).toBe('Read more');
  });

  it('embeds contribute nothing; non-documents yield empty', () => {
    expect(richTextToPlainText(doc([embeddedEntry('e1'), paragraph('after')]))).toBe('after');
    expect(richTextToPlainText('plain string')).toBe('');
    expect(richTextToPlainText(undefined)).toBe('');
    expect(richTextToPlainText(doc([]))).toBe('');
  });
});

describe('rich text in the content model', () => {
  const article = defineContentType({
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
      {
        apiId: 'body',
        name: 'Body',
        type: 'RichText',
        localized: false,
        required: false,
        position: 1,
      },
    ],
  });

  it('rejects an invalid rich-text field value', () => {
    const issues = validateEntryFields(
      article,
      { title: { 'en-US': 'T' }, body: { 'en-US': { nodeType: 'paragraph' } } },
      ctx,
    );
    expect(issues.some((i) => i.field === 'body')).toBe(true);
  });

  it('refuses a script link and an unknown node on every entry write', () => {
    const body = doc([
      {
        nodeType: 'paragraph',
        content: [
          {
            nodeType: 'hyperlink',
            data: { uri: 'javascript:alert(1)' },
            content: [{ nodeType: 'text', value: 'click' }],
          },
        ],
      },
      { nodeType: 'iframe', content: [] },
    ]);
    const issues = validateEntryFields(
      article,
      { title: { 'en-US': 'T' }, body: { 'en-US': body } },
      ctx,
    );
    expect(issues.filter((i) => i.field === 'body')).toHaveLength(2);
  });

  it('extracts references embedded in a rich-text body', () => {
    const edges = extractReferences(
      'e1',
      { title: { 'en-US': 'T' }, body: { 'en-US': doc([embeddedEntry('e2')]) } },
      article,
    );
    expect(edges).toEqual([{ fromEntryId: 'e1', fromField: 'body', toId: 'e2', toType: 'Entry' }]);
  });
});
