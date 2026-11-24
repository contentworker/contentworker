import { describe, expect, it } from 'vitest';
import {
  type ImportScriptOutput,
  importScriptOutputIssues,
  type RichTextDocument,
  scoreImportOutput,
  stageForScore,
} from '../src/index';

const SOURCE = `<html><body>
<header><nav><a href="/">Home</a><a href="/shop">Shop everything today</a></nav></header>
<main>
  <article>
    <header><h1>Brewing green tea</h1></header>
    <p>Green tea wants cooler water than black tea.</p>
    <p>Steep it for two minutes, then taste.</p>
    <img src="/img/cup.jpg" alt="A cup">
    <p>Read <a href="/guides/water">water guide</a>, <a href="/guides/leaves">leaf guide</a>,
       <a href="/guides/cups">cup guide</a> and <a href="https://example.org/more">more</a>.</p>
  </article>
  <form><label>Your email address</label><input name="e"><button>Subscribe now</button></form>
</main>
<footer>Copyright notices forever</footer>
</body></html>`;

const doc = (...paragraphs: RichTextDocument['content']): RichTextDocument => ({
  nodeType: 'document',
  data: {},
  content: paragraphs,
});
const p = (...content: RichTextDocument['content']) => ({
  nodeType: 'paragraph',
  data: {},
  content,
});
const text = (value: string) => ({ nodeType: 'text', value, marks: [], data: {} });
const link = (uri: string, value: string) => ({
  nodeType: 'hyperlink',
  data: { uri },
  content: [text(value)],
});

const full: ImportScriptOutput = {
  fields: { title: 'Brewing green tea', slug: 'brewing-green-tea' },
  blocks: [
    {
      variant: 'text',
      fields: {
        body: doc(
          p(text('Green tea wants cooler water than black tea.')),
          p(text('Steep it for two minutes, then taste.')),
          p(
            text('Read '),
            link('/guides/water', 'water guide'),
            text(', '),
            link('/guides/leaves', 'leaf guide'),
            text(', '),
            link('/guides/cups', 'cup guide'),
            text(' and '),
            link('https://example.org/more', 'more'),
            text('.'),
          ),
        ),
      },
    },
    { variant: 'image', fields: { image: { url: 'https://site.test/img/cup.jpg' } } },
  ],
  assets: [{ url: 'https://site.test/img/cup.jpg', alt: 'A cup' }],
  links: [],
};

describe('scoring an import script output', () => {
  it('scores a faithful output 1, reading text inside rich-text documents and blocks', () => {
    const score = scoreImportOutput(SOURCE, full);
    expect(score).toEqual({
      overall: 1,
      textCoverage: 1,
      imagesMissing: 0,
      imagesLost: 0,
      sourceLinks: 4,
      outputLinks: 4,
      issues: [],
    });
    expect(stageForScore(score, 0.8)).toBe('validated');
  });

  it('reads an $html fragment as the document it becomes, not its tags', () => {
    const score = scoreImportOutput(SOURCE, {
      fields: { title: 'Brewing green tea' },
      blocks: [
        {
          variant: 'text',
          fields: {
            body: {
              $html:
                '<p>Green tea wants cooler water than black tea.</p><p>Steep it for two minutes, then taste.</p><p>Read <a href="/guides/water">water guide</a>, <a href="/guides/leaves">leaf guide</a>, <a href="/guides/cups">cup guide</a> and <a href="https://example.org/more">more</a>.</p>',
            },
          },
        },
      ],
      assets: [{ url: '/img/cup.jpg' }],
      links: [],
    });
    expect(score).toMatchObject({ overall: 1, textCoverage: 1, outputLinks: 4, issues: [] });
  });

  it('leaves site chrome and widget text out of the source, but keeps the article header', () => {
    // No nav, footer or form words in the output, and still full coverage; the h1 inside the
    // article's own <header> counts (dropping the title would lower coverage).
    const noTitle = scoreImportOutput(SOURCE, { ...full, fields: { slug: 'x' } });
    expect(noTitle.textCoverage).toBeLessThan(1);
  });

  it('marks lost text, lost links and lost images, and the stage falls to needs-fix', () => {
    const score = scoreImportOutput(SOURCE, {
      fields: { title: 'Brewing green tea' },
      blocks: [
        { variant: 'text', fields: { body: doc(p(text('Green tea wants cooler water.'))) } },
      ],
      assets: [],
      links: [],
    });
    expect(score.textCoverage).toBeLessThan(0.5);
    expect(score.imagesLost).toBe(1);
    expect(score.outputLinks).toBe(0);
    expect(score.issues).toEqual([
      expect.stringMatching(/^text coverage \d+%$/),
      'links lost: 0 of 4 kept',
      '1 of 1 image(s) not in the output',
    ]);
    expect(stageForScore(score, 0.8)).toBe('needs-fix');
  });

  it('notices words run together across elements', () => {
    const score = scoreImportOutput(
      '<main><h2>Surfing</h2><p>Camp</p><p>lessons daily</p></main>',
      { fields: { body: 'surfingcamp lessons daily' }, blocks: [], assets: [], links: [] },
    );
    expect(score.issues).toContain('text ran together across elements: surfingcamp');
    expect(score.overall).toBeLessThan(score.textCoverage);
  });

  it('counts an asset with no URL as missing, and an embedded asset as kept', () => {
    const score = scoreImportOutput('<main><p>Hello there</p><img src="/a.png"></main>', {
      fields: {
        body: doc(p(text('Hello there')), {
          nodeType: 'embedded-asset-block',
          data: { target: { id: 'a1', linkType: 'Asset' } },
        }),
      },
      blocks: [],
      assets: [{ url: ' ' }],
      links: [],
    });
    expect(score.imagesMissing).toBe(1);
    expect(score.imagesLost).toBe(0);
    expect(score.overall).toBe(0.9);
  });

  it('scores an empty page as covered, and says when the output has no text', () => {
    expect(
      scoreImportOutput('<main></main>', { fields: {}, blocks: [], assets: [], links: [] }),
    ).toMatchObject({ overall: 1, issues: ['the output has no text'] });
  });
});

describe('the import script output shape', () => {
  it('accepts the contract and names what is wrong otherwise', () => {
    expect(importScriptOutputIssues(full)).toEqual([]);
    expect(importScriptOutputIssues('<main>html</main>')).toEqual([
      'the script must return an object { fields, blocks, assets, links }',
    ]);
    expect(
      importScriptOutputIssues({
        fields: [],
        blocks: [{ variant: '' }, { variant: 'hero', fields: 1 }],
        assets: [{ url: 1 }, { url: 'x', alt: 2 }],
        links: [{}],
      }),
    ).toEqual([
      'fields: must be an object of field values',
      'blocks[0].variant: must name a component variant',
      'blocks[1].fields: must be an object of field values',
      'assets[0].url: must be a URL',
      'assets[1].alt: must be text',
      'links[0].href: must be a URL',
    ]);
  });
});
