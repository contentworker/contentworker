import { describe, expect, it } from 'vitest';
import { createParsedPage } from '../src/index';

const html = `<!doctype html>
<html>
  <head>
    <title>  Pricing |  Example </title>
    <meta name="description" content="Plans and prices">
    <meta property="og:image" content="/img/og.png">
    <meta name="Description" content="a second one, ignored">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Pro"}</script>
    <script type="application/ld+json">{"@graph":[{"@type":"Organization"},{"@type":"WebPage"}]}</script>
    <script type="application/ld+json">{ not json</script>
  </head>
  <body>
    <main>
      <h1 class="title">  Plans
        for teams </h1>
      <section class="card"><h2>Free</h2><p>For <b>one</b> person.</p><a href="../signup?plan=free">Go</a></section>
      <section class="card"><h2>Pro</h2><img src="img/pro.png" alt=" Pro badge "></section>
      <a href="javascript:alert(1)">x</a>
      <a href="mailto:a@example.com">mail</a>
    </main>
  </body>
</html>`;

const page = createParsedPage({ url: 'https://www.example.com/pricing/teams', html });

describe('ParsedPage', () => {
  it('reads the title and text with whitespace collapsed', () => {
    expect(page.title).toBe('Pricing | Example');
    expect(page.text('h1')).toBe('Plans for teams');
    expect(page.text('.missing')).toBe('');
  });

  it('queries the document or within an element, as arrays', () => {
    const cards = page.queryAll('section.card');
    expect(cards).toHaveLength(2);
    expect(Array.isArray(cards)).toBe(true);
    expect(page.text(page.query('h2', cards[1]))).toBe('Pro');
    expect(page.queryAll('h2', cards[0]).map((el) => page.text(el))).toEqual(['Free']);
  });

  it('returns a rich-text fragment as inner HTML, for the caller to convert', () => {
    expect(page.html(page.query('section.card p'))).toBe('For <b>one</b> person.');
    expect(page.html('.missing')).toBe('');
  });

  it('reads attributes trimmed, undefined when absent', () => {
    expect(page.attr('img', 'alt')).toBe('Pro badge');
    expect(page.attr('img', 'title')).toBeUndefined();
    expect(page.attr('.missing', 'src')).toBeUndefined();
  });

  it('resolves references against the page, and refuses non-web ones', () => {
    expect(page.absolute(page.attr('section.card a', 'href'))).toBe(
      'https://www.example.com/signup?plan=free',
    );
    expect(page.absolute(page.attr('img', 'src'))).toBe(
      'https://www.example.com/pricing/img/pro.png',
    );
    expect(page.absolute('javascript:alert(1)')).toBeUndefined();
    expect(page.absolute('mailto:a@example.com')).toBeUndefined();
    expect(page.absolute('data:text/plain,hi')).toBeUndefined();
    expect(page.absolute('  ')).toBeUndefined();
    expect(page.absolute(undefined)).toBeUndefined();
  });

  it('honours <base href>', () => {
    const based = createParsedPage({
      url: 'https://www.example.com/a/b',
      html: '<head><base href="https://cdn.example.com/assets/"></head><body><img src="x.png"></body>',
    });
    expect(based.absolute(based.attr('img', 'src'))).toBe('https://cdn.example.com/assets/x.png');
  });

  it('reads meta tags by name or property, first one per name', () => {
    expect(page.meta('description')).toBe('Plans and prices');
    expect(page.meta('OG:IMAGE')).toBe('/img/og.png');
    expect(page.meta('keywords')).toBeUndefined();
    expect(page.metas()).toEqual({ description: 'Plans and prices', 'og:image': '/img/og.png' });
  });

  it('parses JSON-LD, flattening @graph and skipping invalid blocks', () => {
    expect(page.jsonLd()).toEqual([
      { '@context': 'https://schema.org', '@type': 'Product', name: 'Pro' },
      { '@type': 'Organization' },
      { '@type': 'WebPage' },
    ]);
  });

  it('parses a fragment or broken markup leniently', () => {
    const loose = createParsedPage({ url: 'https://x.example/', html: '<p>one<p>two <b>bold' });
    expect(loose.queryAll('p').map((p) => loose.text(p))).toEqual(['one', 'two bold']);
    expect(loose.title).toBe('');
  });
});
