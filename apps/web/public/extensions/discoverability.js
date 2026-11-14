/*
 * Discoverability: a built-in sidebar extension. It reads the entry the editor sends it and says
 * how well search engines, assistants and agents can find, understand and quote it. Nothing leaves
 * the page: every check runs here, on the fields the admin posts in its `init` message.
 *
 * A classic script, not a module: the admin frames this page sandboxed (an opaque origin), where a
 * module script is a cross-origin fetch. `review` is pure, so the tests load this file and call it.
 */
(() => {
  const SUMMARY = /summary|description|excerpt|abstract|teaser|intro|dek|standfirst|lede/i;
  const BODY_TYPES = new Set(['RichText', 'Text']);
  const VAGUE_LINKS = new Set([
    'here',
    'click here',
    'read more',
    'more',
    'link',
    'this',
    'this link',
    'learn more',
  ]);

  const words = (s) => (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;

  /** The value of `apiId` in `locale`, else in the first locale that has one. */
  function fieldValue(values, apiId, locale) {
    const v = values?.[apiId];
    if (!v || typeof v !== 'object') return undefined;
    if (locale && v[locale] != null) return v[locale];
    return Object.values(v).find((x) => x != null);
  }

  const isDoc = (v) => v && typeof v === 'object' && v.nodeType === 'document';

  function textOf(node) {
    if (!node || typeof node !== 'object') return '';
    if (node.nodeType === 'text') return String(node.value ?? '');
    return (node.content ?? []).map(textOf).join(node.nodeType === 'paragraph' ? '' : ' ');
  }

  function walk(node, visit) {
    if (!node || typeof node !== 'object') return;
    visit(node);
    for (const child of node.content ?? []) walk(child, visit);
  }

  /** What the body fields add up to: words, headings in order, links and the opening paragraph. */
  function readBody(fields, values, locale, displayField) {
    const out = { words: 0, headings: [], links: [], opening: null, has: false };
    for (const f of fields) {
      if (!BODY_TYPES.has(f.type) || f.apiId === displayField || SUMMARY.test(f.apiId)) continue;
      const v = fieldValue(values, f.apiId, locale);
      if (f.type === 'Text' && typeof v === 'string' && v.trim()) {
        out.has = true;
        out.words += words(v);
        out.opening ??= v.split(/\n\s*\n/)[0];
      } else if (isDoc(v)) {
        out.has = true;
        walk(v, (n) => {
          const level = /^heading-([1-6])$/.exec(n.nodeType)?.[1];
          if (level) out.headings.push(Number(level));
          if (n.nodeType === 'hyperlink' || n.nodeType === 'entry-hyperlink') {
            out.links.push(textOf(n).trim());
          }
          if (n.nodeType === 'paragraph') {
            const t = textOf(n).trim();
            if (t) out.opening ??= t;
          }
        });
        out.words += words(textOf(v));
      }
    }
    return out;
  }

  /**
   * The checks for one entry. Each is `{ id, status, label, detail }`, status one of `pass`,
   * `warn`, `fail` or `info` (advice, not counted). Checks that don't apply to the type are left
   * out, so a type without a slug isn't told off for one.
   */
  function review(context) {
    const fields = Array.isArray(context?.fields) ? context.fields : [];
    const values = context?.values ?? {};
    const locale = context?.locale;
    const displayField = context?.displayField;
    const checks = [];
    const add = (id, status, label, detail) => checks.push({ id, status, label, detail });

    // The title: what a result, a citation or an agent's answer names the entry by.
    const title = String(fieldValue(values, displayField, locale) ?? '').trim();
    if (!title) add('title', 'fail', 'Title', 'Add a title. It is the name every result shows.');
    else if (title.length > 70)
      add('title', 'warn', 'Title', `${title.length} characters. Over 70 gets cut off in results.`);
    else if (words(title) < 3)
      add('title', 'warn', 'Title', 'Say what the entry is about in a few more words.');
    else add('title', 'pass', 'Title', `${title.length} characters.`);

    // The summary: what a result shows under the title, and what an agent quotes first.
    const summaryField = fields.find(
      (f) =>
        (f.type === 'Symbol' || f.type === 'Text') &&
        f.apiId !== displayField &&
        (SUMMARY.test(f.apiId) || SUMMARY.test(f.name ?? '')),
    );
    if (!summaryField) {
      add(
        'summary',
        'info',
        'Summary',
        'This type has no summary field, so results and agents write their own from the body.',
      );
    } else {
      const s = String(fieldValue(values, summaryField.apiId, locale) ?? '').trim();
      if (!s)
        add('summary', 'fail', 'Summary', `Fill in ${summaryField.name}, in a sentence or two.`);
      else if (s.length < 50)
        add(
          'summary',
          'warn',
          'Summary',
          'Too short to stand on its own. Aim for 50–160 characters.',
        );
      else if (s.length > 300)
        add(
          'summary',
          'warn',
          'Summary',
          `${s.length} characters. Keep it under 300 so it isn't cut.`,
        );
      else add('summary', 'pass', 'Summary', `${s.length} characters.`);
    }

    // The address: readable, stable, and the same words as the topic.
    const slugField = fields.find((f) => f.type === 'Slug');
    if (slugField) {
      const slug = String(fieldValue(values, slugField.apiId, locale) ?? '').trim();
      if (!slug) add('slug', 'fail', 'Address', `Fill in ${slugField.name}.`);
      else if (slug.length > 75)
        add('slug', 'warn', 'Address', 'A long address is hard to read and to share.');
      else if (/^[0-9a-f-]{20,}$/i.test(slug) || !/[a-z]{3}/i.test(slug))
        add('slug', 'warn', 'Address', 'Use words from the title, not an id.');
      else add('slug', 'pass', 'Address', slug);
    }

    const body = readBody(fields, values, locale, displayField);
    if (body.has || fields.some((f) => BODY_TYPES.has(f.type) && f.apiId !== displayField)) {
      // Enough to answer from: a thin page is rarely shown, and gives an agent nothing to cite.
      if (body.words === 0) add('substance', 'fail', 'Body', 'Write the body.');
      else if (body.words < 150)
        add(
          'substance',
          'warn',
          'Body',
          `${body.words} words. Under 150 gives little to answer from.`,
        );
      else add('substance', 'pass', 'Body', `${body.words} words.`);

      // The opening: snippets and agents lift the first paragraph, so it should answer.
      if (body.opening) {
        const n = words(body.opening);
        if (n > 80)
          add(
            'opening',
            'warn',
            'Opening',
            `The first paragraph is ${n} words. Lead with the answer in under 60.`,
          );
        else add('opening', 'pass', 'Opening', 'The first paragraph is short enough to quote.');
      }

      // Sections: headings are how a reader, a crawler or an agent finds the part it needs.
      if (body.headings.includes(1)) {
        add('structure', 'warn', 'Headings', 'The title is the page’s top heading. Start at H2.');
      } else if (body.headings.some((h, i) => i > 0 && h - body.headings[i - 1] > 1)) {
        add('structure', 'warn', 'Headings', 'A heading level is skipped. Go H2 → H3 in order.');
      } else if (body.words >= 300 && body.headings.length === 0) {
        add('structure', 'warn', 'Headings', 'Break a long body into sections with H2 headings.');
      } else if (body.headings.length > 0) {
        add('structure', 'pass', 'Headings', `${body.headings.length} in order.`);
      }

      // Links: text that says where it goes, so it still makes sense out of context.
      const vague = body.links.filter((t) => !t || VAGUE_LINKS.has(t.toLowerCase()));
      if (vague.length > 0)
        add(
          'links',
          'warn',
          'Links',
          `${vague.length} link${vague.length === 1 ? ' says' : 's say'} “here” or similar. Name the destination.`,
        );
      else if (body.links.length > 0)
        add('links', 'pass', 'Links', 'Every link names where it goes.');
      else if (body.words >= 300)
        add(
          'links',
          'info',
          'Links',
          'Link to related entries so readers and agents can go further.',
        );
    }

    return checks;
  }

  globalThis.cwDiscoverability = { review };

  // Below: the page itself, only when the admin frames it.
  if (typeof document === 'undefined' || window.parent === window) return;

  const ICON = { pass: '✓', warn: '!', fail: '×', info: 'i' };

  function render(context) {
    const checks = review(context);
    const counted = checks.filter((c) => c.status !== 'info');
    const ready = counted.filter((c) => c.status === 'pass').length;
    document.getElementById('score').textContent = counted.length
      ? `${ready} of ${counted.length} ready`
      : 'Nothing to check yet';
    const list = document.getElementById('checks');
    list.replaceChildren(
      ...checks.map((c) => {
        const li = document.createElement('li');
        li.className = c.status;
        const mark = document.createElement('span');
        mark.className = 'mark';
        mark.setAttribute('aria-hidden', 'true');
        mark.textContent = ICON[c.status];
        const text = document.createElement('div');
        const label = document.createElement('strong');
        label.textContent = c.label;
        const sr = document.createElement('span');
        sr.className = 'sr';
        sr.textContent = { pass: ' (ready)', warn: ' (improve)', fail: ' (missing)', info: '' }[
          c.status
        ];
        const detail = document.createElement('p');
        detail.textContent = c.detail;
        label.append(sr);
        text.append(label, detail);
        li.append(mark, text);
        return li;
      }),
    );
    resize();
  }

  function resize() {
    window.parent.postMessage(
      { type: 'contentworker-extension:resize', height: document.documentElement.scrollHeight },
      '*',
    );
  }

  window.addEventListener('message', (e) => {
    // Only the admin that framed this page: its window, on the origin that serves this file.
    if (e.source !== window.parent || e.origin !== location.origin) return;
    const data = e.data;
    if (data?.type !== 'contentworker-extension:init') return;
    if (data.context?.theme) document.documentElement.dataset.theme = data.context.theme;
    render(data.context);
  });
  window.parent.postMessage({ type: 'contentworker-extension:ready' }, '*');
})();
