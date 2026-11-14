import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

interface Check {
  id: string;
  status: 'pass' | 'warn' | 'fail' | 'info';
  label: string;
  detail: string;
}

// The built-in extension is a classic script the admin serves as is: run it the way a page would,
// without a document, and take the `review` it publishes.
const source = readFileSync(
  new URL('../public/extensions/discoverability.js', import.meta.url),
  'utf8',
);
const sandbox: { cwDiscoverability?: { review: (context: unknown) => Check[] } } = {};
runInNewContext(source, sandbox);
const review = (context: unknown) => {
  const checks = sandbox.cwDiscoverability?.review(context) ?? [];
  return Object.fromEntries(checks.map((c) => [c.id, c]));
};

const fields = [
  { apiId: 'title', name: 'Title', type: 'Symbol' },
  { apiId: 'slug', name: 'Slug', type: 'Slug' },
  { apiId: 'summary', name: 'Summary', type: 'Text' },
  { apiId: 'body', name: 'Body', type: 'RichText' },
];
const en = (v: unknown) => ({ 'en-US': v });
const text = (value: string) => ({ nodeType: 'text', value, marks: [] });
const p = (...content: unknown[]) => ({ nodeType: 'paragraph', content });
const h = (level: number, value: string) => ({
  nodeType: `heading-${level}`,
  content: [text(value)],
});
const link = (value: string) => ({
  nodeType: 'hyperlink',
  data: { uri: 'https://x.test' },
  content: [text(value)],
});
const doc = (...content: unknown[]) => ({ nodeType: 'document', content });
const lorem = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

const entry = (values: Record<string, unknown>) => ({
  target: 'sidebar',
  locale: 'en-US',
  displayField: 'title',
  fields,
  values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, en(v)])),
});

describe('the discoverability extension', () => {
  it('passes an entry that is titled, summarized, addressed, sectioned and linked', () => {
    const checks = review(
      entry({
        title: 'How to pick a winter tyre',
        slug: 'how-to-pick-a-winter-tyre',
        summary: 'Winter tyres grip below 7 °C. Pick by tread depth, size and the snowflake mark.',
        body: doc(
          p(text('Winter tyres grip better in the cold. '), link('Our tyre size guide'), text('.')),
          h(2, 'Tread'),
          p(text(lorem(200))),
          h(3, 'Depth'),
          p(text(lorem(150))),
        ),
      }),
    );
    expect(Object.values(checks).map((c) => [c.id, c.status])).toEqual([
      ['title', 'pass'],
      ['summary', 'pass'],
      ['slug', 'pass'],
      ['substance', 'pass'],
      ['opening', 'pass'],
      ['structure', 'pass'],
      ['links', 'pass'],
    ]);
  });

  it('says what is missing from an empty entry', () => {
    const checks = review(entry({}));
    expect(checks.title?.status).toBe('fail');
    expect(checks.summary?.status).toBe('fail');
    expect(checks.slug?.status).toBe('fail');
    expect(checks.substance?.status).toBe('fail');
  });

  it('flags a long title, an id for an address, skipped headings and vague links', () => {
    const checks = review(
      entry({
        title: `${'A'.repeat(20)} ${'b'.repeat(60)}`,
        slug: '0193a7c2-5e1f-7c3a-9d2b-8f00aa11bb22',
        summary: 'Short.',
        body: doc(
          p(text(lorem(40)), link('click here')),
          h(2, 'One'),
          h(4, 'Three'),
          p(text(lorem(200))),
        ),
      }),
    );
    expect(checks.title?.status).toBe('warn');
    expect(checks.slug?.status).toBe('warn');
    expect(checks.summary?.status).toBe('warn');
    expect(checks.structure?.detail).toMatch(/skipped/);
    expect(checks.links?.status).toBe('warn');
  });

  it('asks for the answer first when the opening paragraph runs long', () => {
    const checks = review(
      entry({ title: 'Tyres in winter, explained', body: doc(p(text(lorem(120)))) }),
    );
    expect(checks.opening?.status).toBe('warn');
  });

  it('reads the form’s locale, and leaves out checks the type has no field for', () => {
    const checks = review({
      target: 'sidebar',
      locale: 'de-DE',
      displayField: 'name',
      fields: [{ apiId: 'name', name: 'Name', type: 'Symbol' }],
      values: { name: { 'en-US': 'Winter tyres for small cars', 'de-DE': 'Winterreifen' } },
    });
    expect(checks.title?.status).toBe('warn');
    expect(checks.summary?.status).toBe('info');
    expect(checks.slug).toBeUndefined();
    expect(checks.substance).toBeUndefined();
  });
});
