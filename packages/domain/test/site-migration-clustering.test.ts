import { describe, expect, it } from 'vitest';
import {
  clusterByStructure,
  MAX_FINGERPRINT_SHINGLES,
  pickSamples,
  readPageFacts,
  structureFingerprint,
  structureSimilarity,
} from '../src/index';

/** A page in one of two site templates, with its own words. */
const article = (title: string, paragraphs: string[]) => `<!doctype html>
<html><head><title>${title} | Site</title></head><body>
<header class="site-header"><nav><a href="/">Home</a><a href="/blog/">Blog</a></nav></header>
<main class="layout layout--wide js-main">
  <article class="post">
    <h1 class="post-title">${title}</h1>
    <div class="post-meta is-visible"><span class="author">Ada</span><time>2026</time></div>
    <div class="post-body">${paragraphs.map((p) => `<p>${p}</p>`).join('')}<figure><img src="/a.png"></figure></div>
  </article>
</main></body></html>`;

const product = (name: string) => `<!doctype html>
<html><head><title>${name}</title></head><body>
<main><section class="hero"><h2>${name}</h2><div class="price">10</div></section>
<section class="specs"><table><tr><td>Weight</td><td>1kg</td></tr></table></section>
<ul class="gallery"><li><img src="/1.png"></li><li><img src="/2.png"></li></ul>
<form class="buy"><button>Buy</button></form></main></body></html>`;

describe('structure fingerprints', () => {
  it('are the same for pages of one template whatever their text, and differ across templates', () => {
    const a = structureFingerprint(article('First', ['One.', 'Two.']));
    const b = structureFingerprint(article('Second', ['Three.', 'Four.']));
    const c = structureFingerprint(product('Kettle'));
    expect(a).toEqual(b);
    expect(structureSimilarity(a, b)).toBe(1);
    expect(structureSimilarity(a, c)).toBeLessThan(0.2);
  });

  it('ignore classes that vary page to page for the same structure', () => {
    const plain = structureFingerprint('<main><div class="card"><p>x</p></div></main>');
    const noisy = structureFingerprint(
      '<main><div class="card card--featured is-open js-card id-12345"><p>x</p></div></main>',
    );
    expect(noisy).toEqual(plain);
  });

  it('read under <main>, or <body> without one, and stay sorted and capped', () => {
    const many = `<body>${Array.from({ length: 400 }, (_, i) => `<div class="c${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}"><p></p></div>`).join('')}</body>`;
    const fp = structureFingerprint(many);
    expect(fp.length).toBe(MAX_FINGERPRINT_SHINGLES);
    expect([...fp].sort()).toEqual(fp);
    // The chrome outside <main> plays no part.
    expect(
      structureFingerprint('<header><nav><a>x</a></nav></header><main><p>a</p></main>'),
    ).toEqual(structureFingerprint('<main><p>b</p></main>'));
  });

  it('come with the title and the links a crawl follows', () => {
    const facts = readPageFacts(article('Tea &amp; cake', ['Hi <a href="/blog/tea">tea</a>']));
    expect(facts.title).toBe('Tea & cake | Site');
    expect(facts.hrefs).toEqual(['/', '/blog/', '/blog/tea']);
    expect(facts.fingerprint.length).toBeGreaterThan(5);
  });
});

describe('clustering pages by structure', () => {
  it('groups pages of one template together, largest template first, with spread samples', () => {
    const pages = [
      { id: 'p1', fingerprint: structureFingerprint(product('Kettle')) },
      ...Array.from({ length: 7 }, (_, i) => ({
        id: `a${i}`,
        fingerprint: structureFingerprint(article(`Post ${i}`, ['x'.repeat(i + 1)])),
      })),
      { id: 'p2', fingerprint: structureFingerprint(product('Toaster')) },
    ];
    const clusters = clusterByStructure(pages);
    expect(clusters.map((c) => c.pageIds)).toEqual([
      ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6'],
      ['p1', 'p2'],
    ]);
    expect(clusters[0]?.samplePageIds).toEqual(['a0', 'a2', 'a4']);
    expect(clusters[1]?.samplePageIds).toEqual(['p1', 'p2']);
    expect(clusters[1]?.fingerprint).toEqual(pages[0]?.fingerprint);
  });

  it('is deterministic: the same input gives the same clusters', () => {
    const pages = ['a', 'b', 'c', 'd'].map((id, i) => ({
      id,
      fingerprint: structureFingerprint(i % 2 ? product(id) : article(id, [id])),
    }));
    expect(clusterByStructure(pages)).toEqual(clusterByStructure(pages));
  });

  it('keeps a page apart below the threshold, and joins at it', () => {
    const base = ['a', 'b', 'c', 'd', 'e'];
    const near = ['a', 'b', 'c', 'd', 'x']; // 4 shared of 6: 0.667
    expect(
      clusterByStructure([
        { id: '1', fingerprint: base },
        { id: '2', fingerprint: near },
      ]).length,
    ).toBe(1);
    expect(
      clusterByStructure(
        [
          { id: '1', fingerprint: base },
          { id: '2', fingerprint: near },
        ],
        0.7,
      ).length,
    ).toBe(2);
    expect(clusterByStructure([])).toEqual([]);
  });

  it('picks samples evenly', () => {
    expect(pickSamples(['a', 'b'], 3)).toEqual(['a', 'b']);
    expect(pickSamples(['a', 'b', 'c', 'd', 'e', 'f'], 3)).toEqual(['a', 'c', 'e']);
  });
});
