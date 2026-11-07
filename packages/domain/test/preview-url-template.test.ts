import { describe, expect, it } from 'vitest';
import {
  checkPreviewTemplate,
  defineContentType,
  type FieldDefinition,
  fillPreviewTemplate,
  MAX_PREVIEW_TEMPLATE_LENGTH,
  previewOrigin,
  previewTemplateFields,
  reviseContentType,
  ValidationError,
} from '../src/index';

const field = (apiId: string, type: FieldDefinition['type'], position = 0): FieldDefinition => ({
  apiId,
  name: apiId,
  type,
  localized: false,
  required: false,
  position,
});

const FIELDS = [field('title', 'Symbol'), field('slug', 'Slug', 1), field('body', 'Text', 2)];
const TEMPLATE = 'https://site.example/__preview?entry={id}&token={token}';

const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ValidationError) {
      expect(err.issues[0]?.field).toBe('preview.urlTemplate');
      return err.issues.map((i) => i.message).join('; ');
    }
    throw err;
  }
  throw new Error('expected a ValidationError');
};

const check = (t: string) => checkPreviewTemplate(t, FIELDS);

describe('preview URL template', () => {
  it('takes an https template with every placeholder', () => {
    const t =
      'https://site.example/{locale}/blog/{field:slug}?entry={id}&token={token}' +
      '&space={space}&env={environment}#{field:title}';
    expect(check(`  ${t} `)).toBe(t);
  });

  it('takes plain http only on localhost and 127.0.0.1', () => {
    expect(check('http://localhost:3000/__preview?token={token}')).toBeTruthy();
    expect(check('http://127.0.0.1:4321/p/{id}?token={token}')).toBeTruthy();
    expect(refusal(() => check('http://site.example/?token={token}'))).toMatch(/https/);
    expect(refusal(() => check('http://localhost.evil.example/?token={token}'))).toMatch(/https/);
  });

  it('refuses other schemes, relative URLs and credentials', () => {
    for (const t of [
      'javascript:alert(1)//{token}',
      'data:text/html,{token}',
      '//site.example/?token={token}',
      '/__preview?token={token}',
      'https://user:pw@site.example/?token={token}',
      'not a url {token}',
      `https://site.example/${'a'.repeat(MAX_PREVIEW_TEMPLATE_LENGTH)}?t={token}`,
    ]) {
      expect(() => check(t), t).toThrow(ValidationError);
    }
  });

  it('refuses a placeholder in the scheme, host or port: the origin must be fixed', () => {
    for (const t of [
      'https://{space}.site.example/?token={token}',
      'https://site.{field:slug}/?token={token}',
      'https://site.example:{id}/?token={token}',
      '{field:slug}://site.example/?token={token}',
    ]) {
      expect(() => check(t), t).toThrow(ValidationError);
    }
  });

  it('requires {token} and knows only its placeholders', () => {
    expect(refusal(() => check('https://site.example/p/{id}'))).toMatch(/\{token\}/);
    expect(refusal(() => check('https://site.example/?t={token}&x={secret}'))).toMatch(
      /\{secret\} is not/,
    );
    expect(refusal(() => check('https://site.example/?t={token}&x={field:nope}'))).toMatch(
      /names no field/,
    );
    // Long text isn't a URL value.
    expect(refusal(() => check('https://site.example/?t={token}&x={field:body}'))).toMatch(/Slug/);
    expect(refusal(() => check('https://site.example/?t={token}}'))).toMatch(/\{name\}/);
  });

  it('reads its origin, or null for anything the admin must not frame', () => {
    expect(previewOrigin(TEMPLATE)).toBe('https://site.example');
    expect(previewOrigin('https://Site.Example:8443/x/{id}?t={token}')).toBe(
      'https://site.example:8443',
    );
    expect(previewOrigin('http://localhost:3000/?t={token}')).toBe('http://localhost:3000');
    expect(previewOrigin('https://{space}.site.example/')).toBeNull();
    expect(previewOrigin('http://site.example/')).toBeNull();
    expect(previewOrigin('ftp://site.example/')).toBeNull();
    expect(previewOrigin('nonsense')).toBeNull();
  });

  it('fills each placeholder URL-encoded', () => {
    const url = fillPreviewTemplate(
      'https://site.example/{locale}/{field:slug}?entry={id}&token={token}&s={space}&e={environment}&n={field:n}',
      {
        id: 'e 1',
        token: 'pw_a&b=c',
        locale: 'en-US',
        space: 's/1',
        environment: 'main',
        fields: { slug: 'hello world?', n: 3 },
      },
    );
    expect(url).toBe(
      'https://site.example/en-US/hello%20world%3F?entry=e%201&token=pw_a%26b%3Dc&s=s%2F1&e=main&n=3',
    );
    // A value can't move the URL to another origin.
    expect(
      new URL(
        fillPreviewTemplate('https://site.example/{field:slug}?t={token}', {
          id: 'x',
          token: 't',
          locale: 'en',
          space: 's',
          environment: 'e',
          fields: { slug: '//evil.example/@x' },
        }) as string,
      ).origin,
    ).toBe('https://site.example');
  });

  it('fills nothing while a field it names is empty', () => {
    const values = { id: 'e1', token: 't', locale: 'en', space: 's', environment: 'e' };
    const t = 'https://site.example/{field:slug}?t={token}';
    expect(fillPreviewTemplate(t, { ...values, fields: {} })).toBeNull();
    expect(fillPreviewTemplate(t, { ...values, fields: { slug: '' } })).toBeNull();
    expect(fillPreviewTemplate(t, { ...values, fields: { slug: { not: 'text' } } })).toBeNull();
    expect(previewTemplateFields(t)).toEqual(['slug']);
  });
});

describe('a content type’s preview setting', () => {
  const define = (preview: unknown) =>
    defineContentType({
      apiId: 'article',
      name: 'Article',
      displayField: 'title',
      fields: FIELDS,
      // biome-ignore lint/suspicious/noExplicitAny: an unchecked request body
      preview: preview as any,
    });

  it('is kept, trimmed, on a define and a revision that leaves it out', () => {
    const ct = define({ urlTemplate: ` ${TEMPLATE}` });
    expect(ct.preview).toEqual({ urlTemplate: TEMPLATE });
    expect(reviseContentType(ct, { name: 'Post' }).preview).toEqual({ urlTemplate: TEMPLATE });
  });

  it('is cleared by null or a blank template', () => {
    const ct = define({ urlTemplate: TEMPLATE });
    expect(reviseContentType(ct, { preview: null }).preview).toBeUndefined();
    expect(reviseContentType(ct, { preview: { urlTemplate: '  ' } }).preview).toBeUndefined();
    expect(define(null).preview).toBeUndefined();
  });

  it('refuses a bad template, and a revision that removes the field a kept one names', () => {
    expect(() => define({ urlTemplate: 'http://site.example/?t={token}' })).toThrow(
      ValidationError,
    );
    expect(() => define({ urlTemplate: 42 })).toThrow(ValidationError);
    const ct = define({ urlTemplate: 'https://site.example/{field:slug}?t={token}' });
    expect(
      refusal(() => reviseContentType(ct, { fields: FIELDS.filter((f) => f.apiId !== 'slug') })),
    ).toMatch(/names no field/);
  });
});
