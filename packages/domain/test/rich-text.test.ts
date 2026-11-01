import { describe, expect, it } from 'vitest';
import {
  defineContentType,
  extractReferences,
  extractRichTextTargets,
  isRichTextDocument,
  type RichTextDocument,
  richTextToPlainText,
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

  it('extracts references embedded in a rich-text body', () => {
    const edges = extractReferences(
      'e1',
      { title: { 'en-US': 'T' }, body: { 'en-US': doc([embeddedEntry('e2')]) } },
      article,
    );
    expect(edges).toEqual([{ fromEntryId: 'e1', fromField: 'body', toId: 'e2', toType: 'Entry' }]);
  });
});
