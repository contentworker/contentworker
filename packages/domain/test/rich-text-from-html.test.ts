import { describe, expect, it } from 'vitest';
import {
  type RichTextNode,
  richTextFromHtml,
  richTextToPlainText,
  validateRichText,
} from '../src/index.js';

/** The tree without the bookkeeping, so a test reads as the structure it pins. */
function shape(node: RichTextNode): unknown {
  if (node.nodeType === 'text') {
    const marks = (node.marks ?? []).map((m) => m.type);
    return marks.length ? { text: node.value, marks } : node.value;
  }
  const uri = node.data?.uri;
  return {
    [node.nodeType]: (node.content ?? []).map(shape),
    ...(typeof uri === 'string' ? { uri } : {}),
  };
}
const read = (html: string) => richTextFromHtml(html).content.map(shape);

describe('reading HTML as rich text', () => {
  it('maps paragraphs and headings', () => {
    expect(read('<h2>Title</h2><p>Body</p>')).toEqual([
      { 'heading-2': ['Title'] },
      { paragraph: ['Body'] },
    ]);
  });

  it('carries inline formatting as marks, nesting included', () => {
    expect(read('<p>a <strong>b <em>c</em></strong></p>')).toEqual([
      {
        paragraph: [
          'a ',
          { text: 'b ', marks: ['bold'] },
          { text: 'c', marks: ['bold', 'italic'] },
        ],
      },
    ]);
  });

  it('turns links into hyperlinks', () => {
    expect(read('<p>See <a href="https://x.test/a?b=1&amp;c=2">this</a></p>')).toEqual([
      { paragraph: ['See ', { hyperlink: ['this'], uri: 'https://x.test/a?b=1&c=2' }] },
    ]);
  });

  it('maps lists, and closes list items the source left open', () => {
    expect(read('<ul><li>one<li>two</ul><ol><li>three</li></ol>')).toEqual([
      {
        'unordered-list': [
          { 'list-item': [{ paragraph: ['one'] }] },
          { 'list-item': [{ paragraph: ['two'] }] },
        ],
      },
      { 'ordered-list': [{ 'list-item': [{ paragraph: ['three'] }] }] },
    ]);
  });

  it('keeps preformatted text exactly', () => {
    expect(read('<pre><code>if (a) {\n  b();\n}</code></pre>')).toEqual([
      { 'code-block': ['if (a) {\n  b();\n}'] },
    ]);
  });

  it('maps quotes and rules', () => {
    expect(read('<blockquote>Said.</blockquote><hr>')).toEqual([
      { blockquote: [{ paragraph: ['Said.'] }] },
      { hr: [] },
    ]);
  });

  it('ignores the block comments the WordPress editor writes', () => {
    const gutenberg =
      '<!-- wp:paragraph -->\n<p>One</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:paragraph -->\n<p>Two</p>\n<!-- /wp:paragraph -->';
    expect(read(gutenberg)).toEqual([{ paragraph: ['One'] }, { paragraph: ['Two'] }]);
  });

  it('reads blank-line-separated text as paragraphs, as WordPress renders it', () => {
    // The classic editor stores paragraphs with no tags at all.
    expect(read('First para\nsame para\n\nSecond <em>para</em>')).toEqual([
      { paragraph: ['First para', { 'hard-break': [] }, 'same para'] },
      { paragraph: ['Second ', { text: 'para', marks: ['italic'] }] },
    ]);
  });

  it('reads plain text as a paragraph', () => {
    expect(read('Just words.')).toEqual([{ paragraph: ['Just words.'] }]);
  });

  it('keeps an image as a link to it, rather than losing it', () => {
    // There is no asset to point an embed at yet; a link is visible and fixable.
    expect(
      read(
        '<figure><img src="https://x.test/cat.jpg" alt="A cat"><figcaption>Cat</figcaption></figure>',
      ),
    ).toEqual([
      { paragraph: [{ hyperlink: ['A cat'], uri: 'https://x.test/cat.jpg' }] },
      { paragraph: ['Cat'] },
    ]);
  });

  it('keeps the text of elements it does not know', () => {
    expect(read('<p><span class="x">kept</span> <mark>too</mark></p>')).toEqual([
      { paragraph: ['kept', ' ', 'too'] },
    ]);
  });

  it('drops scripts and styles with what is inside them', () => {
    expect(
      read('<p>a</p><script>alert(1)</script><style>p{}</style><SCRIPT>x</SCRIPT><p>b</p>'),
    ).toEqual([{ paragraph: ['a'] }, { paragraph: ['b'] }]);
  });

  it('decodes entities, and leaves an unknown one visible', () => {
    expect(read('<p>&ldquo;Hi&rdquo; &mdash; &#8217;&#x41; &bogus;</p>')).toEqual([
      { paragraph: ['“Hi” — ’A &bogus;'] },
    ]);
  });

  it('reads a "<" that starts no tag as text', () => {
    expect(read('<p>a < b</p>')).toEqual([{ paragraph: ['a < b'] }]);
  });

  it('survives nesting deep enough to overflow a naive reader', () => {
    const deep = `${'<div>'.repeat(100_000)}deep${'</div>'.repeat(100_000)}`;
    expect(richTextToPlainText(richTextFromHtml(deep))).toBe('deep');
  });

  it('keeps the text of a link whose scheme is not safe, but not the link', () => {
    // Imported HTML is someone else's; a hostile export must not become stored
    // script links that delivery clients render.
    const hostile =
      '<p><a href="javascript:alert(1)">a</a> <a href=" JaVa\tScRiPt:x">b</a> ' +
      '<a href="data:text/html,x">c</a> <a href="vbscript:x">d</a> <img src="javascript:x" alt="e"></p>';
    expect(read(hostile)).toEqual([{ paragraph: ['a', ' ', 'b', ' ', 'c', ' ', 'd', ' ', 'e'] }]);
  });

  it('keeps links with safe or no scheme', () => {
    const links = [
      'https://x.test',
      'mailto:a@x.test',
      'tel:+1555',
      '/relative',
      '#top',
      'page.html',
    ];
    const html = links.map((uri) => `<a href="${uri}">l</a>`).join(' ');
    const [paragraph] = richTextFromHtml(`<p>${html}</p>`).content;
    const uris = (paragraph?.content ?? [])
      .filter((n) => n.nodeType === 'hyperlink')
      .map((n) => n.data?.uri);
    expect(uris).toEqual(links);
  });

  it('reads an image inside a link as one link, not a link within a link', () => {
    // WordPress writes a linked thumbnail this way on nearly every gallery post.
    expect(
      read(
        '<p><a href="https://x.test/full.jpg"><img src="https://x.test/t.jpg" alt="Cat"></a></p>',
      ),
    ).toEqual([{ paragraph: [{ hyperlink: ['Cat'], uri: 'https://x.test/full.jpg' }] }]);
    expect(
      read('<p><a href="https://x.test/a">one <a href="https://x.test/b">two</a></a></p>'),
    ).toEqual([{ paragraph: [{ hyperlink: ['one ', 'two'], uri: 'https://x.test/a' }] }]);
  });

  it('refuses a scheme hidden behind an entity it does not decode', () => {
    // `&colon;` is a colon to a careless renderer; here it is not a link at all.
    expect(read('<p><a href="javascript&colon;alert(1)">x</a></p>')).toEqual([
      { paragraph: ['x'] },
    ]);
  });

  it('opens a link whose unquoted href ends in a slash', () => {
    expect(read('<p><a href=/about/>About</a> more</p>')).toEqual([
      { paragraph: [{ hyperlink: ['About'], uri: '/about/' }, ' more'] },
    ]);
  });

  it('keeps a video given by its source element as a link', () => {
    expect(read('<video controls><source src="https://x.test/v.mp4"></video>')).toEqual([
      { paragraph: [{ hyperlink: ['https://x.test/v.mp4'], uri: 'https://x.test/v.mp4' }] },
    ]);
  });

  it('drops a link with nothing in it', () => {
    expect(read('<p>a<a href="https://x.test"></a></p>')).toEqual([{ paragraph: ['a'] }]);
  });

  it('closes an open paragraph when the next one starts', () => {
    expect(read('<p>a<p>b')).toEqual([{ paragraph: ['a'] }, { paragraph: ['b'] }]);
  });

  it('closes open list items without escaping a nested list', () => {
    expect(read('<ul><li>a<ul><li>b<li>c</ul><li>d</ul>')).toEqual([
      {
        'unordered-list': [
          {
            'list-item': [
              { paragraph: ['a'] },
              {
                'unordered-list': [
                  { 'list-item': [{ paragraph: ['b'] }] },
                  { 'list-item': [{ paragraph: ['c'] }] },
                ],
              },
            ],
          },
          { 'list-item': [{ paragraph: ['d'] }] },
        ],
      },
    ]);
  });

  it('produces documents the field validator accepts', () => {
    const messy =
      '<h1>T</h1><p>a<p>b<ul><li>c</ul></p><table><tr><td>d</td></tr></table><img src=x.png>\n\ne';
    expect(validateRichText(richTextFromHtml(messy))).toEqual([]);
  });

  it('produces an empty document from nothing', () => {
    expect(richTextFromHtml('')).toEqual({ nodeType: 'document', data: {}, content: [] });
    expect(richTextFromHtml('  <p> </p> ').content).toEqual([]);
  });
});
