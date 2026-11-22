import type { DocumentParser } from '@contentworker/ports';
import {
  FakeBlobStore,
  FakeWorkflowSteps,
  FixedClock,
  InMemoryContentStore,
  SequenceIdGenerator,
} from '@contentworker/test-kit';
import { expect, it } from 'vitest';
import { createAsset, createSpace, getDocumentPage, runAssetIngest } from '../src';

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
  for (let attempt = 0; attempt < 2; attempt++) {
    const steps = new FakeWorkflowSteps(clock);
    await steps.run(() =>
      runAssetIngest(
        steps,
        ctx,
        { blob, documentParser },
        { scope, assetId: asset.id, version: 1 },
      ),
    );
  }
  expect(rendered).toEqual([1, 2]);
  expect(await getDocumentPage(ctx, blob, scope, asset.id, 1)).toMatchObject({
    documentStatus: 'partial',
    status: 'complete',
    version: 1,
    text: 'Page 1',
    media: [{ part: 'image.png', url: expect.any(String) }],
    previewUrl: expect.any(String),
  });
  await expect(
    getDocumentPage(ctx, blob, { ...scope, environmentId: 'other' }, asset.id, 1),
  ).rejects.toThrow();
  await expect(getDocumentPage(ctx, blob, scope, asset.id, 3)).rejects.toThrow();
  await blob.put(asset.r2Key!, 'different bytes', 'application/pdf');
  await expect(getDocumentPage(ctx, blob, scope, asset.id, 1)).rejects.toThrow();
});
