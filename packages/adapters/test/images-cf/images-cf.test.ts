import { describe, expect, it } from 'vitest';
import {
  type CfImageTransform,
  type CfOutputFormat,
  cdnCgiOptions,
  createCfImageTransformer,
  type ImagesBindingLike,
  negotiateFormat,
  parseTransformParams,
  transformImage,
} from '../../src/images-cf/index.js';

/** Signer stand-in: deterministic, records what was signed. */
function fakeSigner() {
  const signed: { key: string; params: string }[] = [];
  return {
    signed,
    async sign(_m: 'GET', key: string, params: URLSearchParams) {
      signed.push({ key, params: params.toString() });
      return 'SIG';
    },
  };
}

/** Images binding fake: records the transform chain and output options. */
function fakeImages() {
  const calls: {
    transforms: CfImageTransform[];
    output?: { format: CfOutputFormat; quality?: number };
  } = { transforms: [] };
  const handle = {
    transform(t: CfImageTransform) {
      calls.transforms.push(t);
      return handle;
    },
    async output(o: { format: CfOutputFormat; quality?: number }) {
      calls.output = o;
      return {
        response: () => new Response('out', { headers: { 'content-type': o.format } }),
      };
    },
  };
  const images: ImagesBindingLike = { input: () => handle };
  return { images, calls };
}

describe('createCfImageTransformer', () => {
  it('re-signs a /media URL with transform params, focal point as gravity, auto format by default', async () => {
    const signer = fakeSigner();
    const t = createCfImageTransformer({ signer });
    const url = await t.transformUrl(
      'https://api.example/media/s/main/a1/pic%20one.jpg?sig=OLD',
      { width: 400, height: 300, fit: 'crop' },
      { x: 0.25, y: 0.75 },
    );
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://api.example/media/s/main/a1/pic%20one.jpg');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      w: '400',
      h: '300',
      fit: 'crop',
      fm: 'auto',
      g: '0.25x0.75',
      sig: 'SIG',
    });
    expect(signer.signed[0]?.key).toBe('s/main/a1/pic one.jpg');
  });

  it('keeps root-relative media URLs relative', async () => {
    const t = createCfImageTransformer({ signer: fakeSigner() });
    expect(await t.transformUrl('/media/a/b.png?sig=x', { width: 10 })).toMatch(
      /^\/media\/a\/b\.png\?w=10&fm=auto&sig=SIG$/,
    );
  });

  it('uses /cdn-cgi/image on the configured zone for foreign sources, else passes through', async () => {
    const withZone = createCfImageTransformer({
      signer: fakeSigner(),
      zoneOrigin: 'https://img.example',
    });
    expect(
      await withZone.transformUrl(
        'https://bucket.example/a.jpg',
        { width: 100, fit: 'crop', format: 'webp', quality: 80 },
        { x: 0.5, y: 0.1 },
      ),
    ).toBe(
      'https://img.example/cdn-cgi/image/width=100,fit=cover,format=webp,quality=80,gravity=0.5x0.1/https://bucket.example/a.jpg',
    );
    const noZone = createCfImageTransformer({ signer: fakeSigner() });
    expect(await noZone.transformUrl('https://bucket.example/a.jpg', { width: 1 })).toBe(
      'https://bucket.example/a.jpg',
    );
  });
});

describe('transform params', () => {
  it('maps provider-neutral fits and clamps garbage', () => {
    expect(
      parseTransformParams(new URLSearchParams('w=200&h=100&fit=crop&g=0.2x0.8&q=70&fm=avif')),
    ).toEqual({
      transform: {
        width: 200,
        height: 100,
        fit: 'cover',
        gravity: { x: 0.2, y: 0.8, mode: 'box-center' },
      },
      format: 'avif',
      quality: 70,
    });
    expect(parseTransformParams(new URLSearchParams('w=-1&fit=bogus&g=2x2&q=500'))).toBeNull();
    expect(cdnCgiOptions({ fit: 'max', format: 'jpg' })).toBe('fit=scale-down,format=jpeg');
  });

  it('negotiates auto format from Accept', () => {
    expect(negotiateFormat('auto', 'image/avif,image/webp,*/*', 'image/jpeg')).toBe('image/avif');
    expect(negotiateFormat('auto', 'image/webp,*/*', 'image/jpeg')).toBe('image/webp');
    expect(negotiateFormat('auto', '*/*', 'image/png')).toBe('image/png');
    expect(negotiateFormat(undefined, null, 'image/gif')).toBe('image/gif');
    expect(negotiateFormat(undefined, null, 'image/tiff')).toBe('image/jpeg');
  });
});

describe('transformImage', () => {
  const body = () => new Response('bytes').body as ReadableStream<Uint8Array>;

  it('runs the binding chain and marks auto responses Vary: Accept', async () => {
    const { images, calls } = fakeImages();
    const res = await transformImage(
      images,
      body(),
      'image/jpeg',
      new URLSearchParams('w=320&fit=crop&g=0.5x0.5&fm=auto&q=60'),
      'image/webp',
    );
    expect(calls.transforms).toEqual([
      { width: 320, fit: 'cover', gravity: { x: 0.5, y: 0.5, mode: 'box-center' } },
    ]);
    expect(calls.output).toEqual({ format: 'image/webp', quality: 60 });
    expect(res?.headers.get('vary')).toBe('Accept');
    expect(res?.headers.get('cache-control')).toContain('max-age');
  });

  it('serves the original (null) for SVG or empty params', async () => {
    const { images } = fakeImages();
    expect(
      await transformImage(images, body(), 'image/svg+xml', new URLSearchParams('w=10'), null),
    ).toBeNull();
    expect(
      await transformImage(images, body(), 'image/png', new URLSearchParams(''), null),
    ).toBeNull();
  });
});
