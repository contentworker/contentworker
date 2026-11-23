import type { AssetIngestParams, DocumentParser } from '@contentworker/ports';
import {
  FakeBlobStore,
  FakeWorkflowSteps,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
  StubAIProvider,
} from '@contentworker/test-kit';
import { expect, it } from 'vitest';
import {
  createAsset,
  createSpace,
  getDocumentPage,
  getDocumentTemplate,
  runAssetIngest,
  setDocumentTemplate,
} from '../src';

it('renders each page, reuses stored pages on retry, and exposes only the current file in its scope', async () => {
  const clock = new FixedClock();
  const ctx = { clock, store: new InMemoryContentStore(), ids: new SequenceIdGenerator('doc') };
  const scope = { spaceId: 'shop', environmentId: 'main' };
  await createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  const blob = new FakeBlobStore();
  const { asset } = await createAsset(ctx, blob, scope, {
    fileName: 'brief.pdf',
    contentType: 'application/pdf',
  });
  await blob.put(asset.r2Key!, 'pinned document', 'application/pdf');
  const rendered: number[] = [];
  const documentParser: DocumentParser = {
    async render(input) {
      rendered.push(input.page);
      const partial = input.page === 2;
      await blob.put(`${input.outputPrefix}media/${'f'.repeat(64)}`, 'image', 'image/png');
      await blob.put(
        `${input.outputPrefix}pages/${input.page}/manifest.json`,
        JSON.stringify({
          page: input.page,
          pages: 2,
          text: `Page ${input.page}`,
          textMethod: 'native',
          preview: 'preview.png',
          media: [{ part: 'image.png', sha256: 'f'.repeat(64) }],
          warnings: partial ? ['Missing media'] : [],
          status: partial ? 'partial' : 'complete',
        }),
        'application/json',
      );
      return { pages: 2, partial };
    },
  };
  const initial = await getDocumentTemplate(ctx, scope);
  expect(initial.version).toBe(0);
  expect((await setDocumentTemplate(ctx, scope, { ...initial, suggestTags: false })).version).toBe(
    1,
  );
  await expect(setDocumentTemplate(ctx, scope, initial)).rejects.toThrow(/changed/);
  const ai = new StubAIProvider(() => 'A short document description.');
  for (let attempt = 0; attempt < 2; attempt++) {
    const steps = new FakeWorkflowSteps(clock);
    await steps.run(() =>
      runAssetIngest(
        steps,
        ctx,
        { blob, documentParser, ai },
        { scope, assetId: asset.id, version: 1 },
      ),
    );
  }
  expect(rendered).toEqual([1, 2]);
  const retry = new FakeWorkflowSteps(clock);
  await retry.run(() =>
    runAssetIngest(
      retry,
      ctx,
      { blob, documentParser, ai },
      { scope, assetId: asset.id, version: 1, retryPartialPages: true },
    ),
  );
  expect(rendered).toEqual([1, 2, 2]);
  expect(ai.requests).toHaveLength(1);
  expect(ai.requests[0]?.prompt).toContain('Page 1');
  expect((await ctx.store.assets.get(scope, asset.id))?.description).toEqual({
    'en-US': 'A short document description.',
  });
  expect(await getDocumentPage(ctx, blob, scope, asset.id, 1)).toMatchObject({
    documentStatus: 'partial',
    firstPartialPage: 2,
    status: 'complete',
    version: 1,
    text: 'Page 1',
    media: [{ part: 'image.png', assetId: expect.any(String), url: expect.any(String) }],
    previewUrl: expect.any(String),
  });
  const children = (await ctx.store.assets.list(scope, {})).items.filter((a) => a.id !== asset.id);
  expect(children).toHaveLength(1);
  expect(children[0]).toMatchObject({
    status: 'draft',
    file: { fileName: 'image.png', contentType: 'image/png' },
  });
  expect(await blob.get(children[0]!.r2Key!)).toBe('image');
  await expect(
    getDocumentPage(ctx, blob, { ...scope, environmentId: 'other' }, asset.id, 1),
  ).rejects.toThrow();
  await expect(getDocumentPage(ctx, blob, scope, asset.id, 3)).rejects.toThrow();
  await blob.put(asset.r2Key!, 'different bytes', 'application/pdf');
  await expect(getDocumentPage(ctx, blob, scope, asset.id, 1)).rejects.toThrow();
});

it('continues at the first unprocessed page and preserves earlier partial results', async () => {
  const clock = new FixedClock();
  const ctx = { clock, store: new InMemoryContentStore(), ids: new SequenceIdGenerator('chunk') };
  const scope = { spaceId: 'library', environmentId: 'main' };
  await createSpace(ctx, { spaceId: 'library', name: 'Library', defaultLocale: 'en-US' });
  const blob = new FakeBlobStore();
  const { asset } = await createAsset(ctx, blob, scope, {
    fileName: 'book.pdf',
    contentType: 'application/pdf',
  });
  await blob.put(asset.r2Key!, 'book', 'application/pdf');
  const rendered: number[] = [];
  const documentParser: DocumentParser = {
    async render(input) {
      rendered.push(input.page);
      const partial = input.page === 4;
      await blob.put(
        `${input.outputPrefix}pages/${input.page}/manifest.json`,
        JSON.stringify({
          page: input.page,
          pages: 130,
          text: 'Page text',
          textMethod: 'native',
          preview: null,
          media: [],
          warnings: [],
          status: partial ? 'partial' : 'complete',
        }),
        'application/json',
      );
      return { pages: 130, partial };
    },
  };
  const starts: AssetIngestParams[] = [];
  const continuation = {
    instanceId: 'first',
    starter: {
      async start(_id: string, params: AssetIngestParams) {
        starts.push(params);
        return true;
      },
    },
  };
  const run = (params: AssetIngestParams) => {
    const steps = new FakeWorkflowSteps(clock);
    return steps.run(() =>
      runAssetIngest(steps, ctx, { blob, documentParser, continuation }, params),
    );
  };
  expect(await run({ assetId: asset.id, version: 1, scope })).toMatchObject({
    value: { outcome: 'continued' },
  });
  expect(starts).toHaveLength(1);
  expect(starts[0]?.documentCursor?.page).toBe(129);
  expect(await run(starts[0]!)).toMatchObject({ value: { outcome: 'ready' } });
  expect(rendered).toEqual(Array.from({ length: 130 }, (_, i) => i + 1));
  expect((await getDocumentPage(ctx, blob, scope, asset.id, 130)).documentStatus).toBe('partial');
});
