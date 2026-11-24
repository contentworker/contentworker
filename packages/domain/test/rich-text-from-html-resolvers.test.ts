import { describe, expect, it } from 'vitest';
import { richTextFromHtml, validateRichText } from '../src/index';

/**
 * Inputs covering every reading the converter has (blocks, marks, lists, tables, links, media,
 * embeds, WordPress's blank-line paragraphs and figures), whose output without resolvers is pinned
 * in `rich-text-from-html.golden.json`, written by the converter as it was before resolvers.
 */
const CORPUS = [
  '<h2>Title</h2><p>Body with <strong>bold</strong>, <em>italic</em> and <code>code</code>.</p>',
  'First paragraph\nwith a break.\n\nSecond paragraph.',
  '<p>Unclosed<p>paragraphs<ul><li>one<li>two</ul>',
  '<ol><li><p>Item</p><ul><li>nested</li></ul></li></ol>',
  '<blockquote>Quoted\n\nTwice</blockquote><hr><pre>  code\n  block\n</pre>',
  '<table><caption>Prices</caption><thead><tr><th>A</th><th colspan="2">B</th></tr></thead><tbody><tr><td>1</td><td><img src="https://cdn.example.com/c.png" alt="cell"></td><td></td></tr></tbody></table>',
  '<p>See <a href="https://example.com/about">about</a> and <a href="/docs/start">the docs</a>.</p>',
  '<p><a href="javascript:alert(1)">bad</a> <a href="mailto:a@example.com">mail</a></p>',
  '<p>Before <img src="https://cdn.example.com/a.png" alt="A cat"> after</p>',
  '<img src="/wp-content/uploads/b.jpg" alt="Top level">',
  '<p><a href="https://cdn.example.com/full.jpg"><img src="https://cdn.example.com/thumb.jpg" alt="Thumb"></a></p>',
  '<figure class="wp-block-image"><img src="https://cdn.example.com/f.jpg" alt="Figure"><figcaption>A caption</figcaption></figure>',
  '<figure><a href="https://cdn.example.com/big.jpg"><img src="https://cdn.example.com/small.jpg" alt=""></a><figcaption>Linked</figcaption></figure>',
  '<picture><source srcset="x.webp"><img src="https://cdn.example.com/p.jpg" alt="Pic"></picture>',
  '<video><source src="https://cdn.example.com/v.mp4"></video><audio src="https://cdn.example.com/a.mp3"></audio>',
  '<h3>Heading <img src="https://cdn.example.com/h.png"></h3>',
  '<ul><li><img src="https://cdn.example.com/li.png" alt="In a list"></li></ul>',
  '<p><strong><img src="https://cdn.example.com/nested.png" alt="Nested"></strong></p>',
  '<p><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe></p>',
  '<figure class="wp-block-embed"><div class="wp-block-embed__wrapper">https://vimeo.com/76979871</div><figcaption>Video</figcaption></figure>',
  'Intro\n\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ\n\nOutro',
  '<blockquote class="twitter-tweet"><p>Post</p><a href="https://twitter.com/x/status/123">link</a></blockquote>',
  '<p>Entities: &amp; &lt; &copy; &#169; &#x2014; &unknown;</p>',
  '<div><section><p>Deep <a href="https://example.com"><em>link</em> <a href="https://inner.example.com">inner</a></a></p></section></div>',
  '<p><a href="https://example.com/empty"></a><img alt="no source"></p>',
  '<script>x()</script><style>p{}</style><p>Kept</p><!-- wp:paragraph -->',
];

describe('reading HTML without resolvers', () => {
  it('is what the converter produced before resolvers existed, byte for byte', async () => {
    const out = CORPUS.map((html) => richTextFromHtml(html));
    await expect(`${JSON.stringify(out, null, 2)}\n`).toMatchFileSnapshot(
      './rich-text-from-html.golden.json',
    );
  });
});

describe('reading HTML with resolvers', () => {
  const assets: Record<string, string> = {
    'https://cdn.example.com/a.png': 'asset-a',
    '/wp-content/uploads/b.jpg': 'asset-b',
    'https://cdn.example.com/full.jpg': 'asset-full',
    'https://cdn.example.com/f.jpg': 'asset-f',
    'https://cdn.example.com/p.jpg': 'asset-p',
    'https://cdn.example.com/li.png': 'asset-li',
    'https://cdn.example.com/c.png': 'asset-c',
    'https://cdn.example.com/nested.png': 'asset-nested',
    'https://cdn.example.com/doc.pdf': 'asset-doc',
  };
  const pages: Record<string, string> = {
    '/docs/start': 'entry-start',
    'https://example.com/about': 'entry-about',
  };
  const asked: { src: string; alt?: string }[] = [];
  const options = {
    resolveAsset: (src: string, alt?: string) => {
      asked.push({ src, ...(alt !== undefined ? { alt } : {}) });
      const id = assets[src];
      return id ? { id } : undefined;
    },
    resolveLink: (href: string) => {
      if (pages[href]) return { linkType: 'Entry' as const, id: pages[href] as string };
      if (assets[href]) return { linkType: 'Asset' as const, id: assets[href] as string };
      return undefined;
    },
  };
  const asset = (id: string) => ({
    nodeType: 'embedded-asset-block',
    data: { target: { id, linkType: 'Asset' } },
    content: [],
  });
  const read = (html: string) => {
    const doc = richTextFromHtml(html, options);
    expect(validateRichText(doc)).toEqual([]);
    return doc.content;
  };

  it('makes a top-level image an embedded asset, asking with its src and alt', () => {
    asked.length = 0;
    expect(read('<img src="/wp-content/uploads/b.jpg" alt="Top level">')).toEqual([
      asset('asset-b'),
    ]);
    expect(asked).toEqual([{ src: '/wp-content/uploads/b.jpg', alt: 'Top level' }]);
  });

  it('splits a paragraph around an inline image, keeping the text on both sides', () => {
    expect(
      read('<p>Before <img src="https://cdn.example.com/a.png" alt="A cat"> after</p>'),
    ).toEqual([
      { nodeType: 'paragraph', data: {}, content: [text('Before')] },
      asset('asset-a'),
      { nodeType: 'paragraph', data: {}, content: [text('after')] },
    ]);
  });

  it('embeds a figure’s image with its caption after it, and a picture’s image', () => {
    expect(
      read(
        '<figure class="wp-block-image"><img src="https://cdn.example.com/f.jpg"><figcaption>A caption</figcaption></figure>',
      ),
    ).toEqual([
      asset('asset-f'),
      { nodeType: 'paragraph', data: {}, content: [text('A caption')] },
    ]);
    expect(
      read('<picture><source srcset="x.webp"><img src="https://cdn.example.com/p.jpg"></picture>'),
    ).toEqual([asset('asset-p')]);
  });

  it('takes the full-size file a linked thumbnail points at', () => {
    expect(
      read(
        '<p><a href="https://cdn.example.com/full.jpg"><img src="https://cdn.example.com/thumb.jpg" alt="Thumb"></a></p>',
      ),
    ).toEqual([asset('asset-full')]);
  });

  it('keeps blocks valid in list items and table cells', () => {
    const [list] = read('<ul><li><img src="https://cdn.example.com/li.png"></li></ul>');
    expect(list?.content?.[0]?.content).toEqual([asset('asset-li')]);
    const [tableNode] = read(
      '<table><tr><td><img src="https://cdn.example.com/c.png"></td></tr></table>',
    );
    expect(tableNode?.content?.[0]?.content?.[0]?.content).toEqual([asset('asset-c')]);
  });

  it('links an image nested in inline formatting to its asset, which a line of text can hold', () => {
    expect(
      read('<p><strong><img src="https://cdn.example.com/nested.png" alt="Nested"></strong></p>'),
    ).toEqual([
      {
        nodeType: 'paragraph',
        data: {},
        content: [
          {
            nodeType: 'asset-hyperlink',
            data: { target: { id: 'asset-nested', linkType: 'Asset' } },
            content: [{ ...text('Nested'), marks: [{ type: 'bold' }] }],
          },
        ],
      },
    ]);
  });

  it('turns links to known pages into entry links and to known files into asset links', () => {
    const [paragraph] = read(
      '<p><a href="/docs/start">Start</a>, <a href="https://cdn.example.com/doc.pdf">the PDF</a> and <a href="https://elsewhere.example.com">out</a></p>',
    );
    expect(paragraph?.content).toEqual([
      {
        nodeType: 'entry-hyperlink',
        data: { target: { id: 'entry-start', linkType: 'Entry' } },
        content: [text('Start')],
      },
      text(', '),
      {
        nodeType: 'asset-hyperlink',
        data: { target: { id: 'asset-doc', linkType: 'Asset' } },
        content: [text('the PDF')],
      },
      text(' and '),
      {
        nodeType: 'hyperlink',
        data: { uri: 'https://elsewhere.example.com' },
        content: [text('out')],
      },
    ]);
  });

  it('leaves what a resolver does not know exactly as it reads without one', () => {
    const nothing = { resolveAsset: () => undefined, resolveLink: () => undefined };
    for (const html of CORPUS) {
      expect(JSON.stringify(richTextFromHtml(html, nothing))).toBe(
        JSON.stringify(richTextFromHtml(html)),
      );
    }
  });

  it('never resolves an unsafe link', () => {
    const seen: string[] = [];
    richTextFromHtml('<p><a href="javascript:alert(1)">x</a></p>', {
      resolveLink: (href) => {
        seen.push(href);
        return { linkType: 'Entry', id: 'e' };
      },
    });
    expect(seen).toEqual([]);
  });
});

function text(value: string) {
  return { nodeType: 'text', value, marks: [], data: {} };
}
