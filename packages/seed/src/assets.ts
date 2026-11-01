import {
  createAsset,
  listAssets,
  publishAsset,
  setAssetMetadata,
} from '@contentworker/application';
import type { BlobStore } from '@contentworker/ports';
import { logger } from '@contentworker/telemetry';
import { localized, pick } from './helpers.js';
import type { SeedRun } from './types.js';

const FILES = [
  { fileName: 'hero-coastline.jpg', contentType: 'image/jpeg', title: 'Coastline at dawn' },
  { fileName: 'team-offsite.png', contentType: 'image/png', title: 'Team offsite' },
  { fileName: 'product-shot-01.jpg', contentType: 'image/jpeg', title: 'Product shot 1' },
  { fileName: 'product-shot-02.jpg', contentType: 'image/jpeg', title: 'Product shot 2' },
  { fileName: 'product-shot-03.jpg', contentType: 'image/jpeg', title: 'Product shot 3' },
  { fileName: 'product-shot-04.jpg', contentType: 'image/jpeg', title: 'Product shot 4' },
  { fileName: 'architecture-diagram.png', contentType: 'image/png', title: 'Architecture diagram' },
  { fileName: 'workflow-flowchart.png', contentType: 'image/png', title: 'Workflow flowchart' },
  { fileName: 'dashboard-screenshot.png', contentType: 'image/png', title: 'Dashboard screenshot' },
  { fileName: 'launch-keynote.mp4', contentType: 'video/mp4', title: 'Launch keynote' },
  { fileName: 'demo-walkthrough.mp4', contentType: 'video/mp4', title: 'Demo walkthrough' },
  { fileName: 'whitepaper.pdf', contentType: 'application/pdf', title: 'Platform whitepaper' },
  { fileName: 'press-kit.pdf', contentType: 'application/pdf', title: 'Press kit' },
  { fileName: 'benchmark-report.pdf', contentType: 'application/pdf', title: 'Benchmark report' },
  { fileName: 'conference-stage.jpg', contentType: 'image/jpeg', title: 'Conference stage' },
  { fileName: 'speaker-portrait.jpg', contentType: 'image/jpeg', title: 'Speaker portrait' },
  { fileName: 'recipe-plating.jpg', contentType: 'image/jpeg', title: 'Plated dish' },
  { fileName: 'kitchen-prep.jpg', contentType: 'image/jpeg', title: 'Kitchen prep' },
  { fileName: 'city-skyline.jpg', contentType: 'image/jpeg', title: 'City skyline' },
  { fileName: 'brand-guidelines.pdf', contentType: 'application/pdf', title: 'Brand guidelines' },
] as const;

const DE_TITLES: Record<string, string> = {
  'Coastline at dawn': 'Küste im Morgengrauen',
  'Team offsite': 'Team-Offsite',
  'Architecture diagram': 'Architekturdiagramm',
  'Plated dish': 'Angerichtetes Gericht',
  'City skyline': 'Stadtsilhouette',
};

/**
 * Twenty demo assets across image/video/pdf types. The bytes are never
 * uploaded — publishing only snapshots metadata, and dev runs on the fake
 * blob store — so create → metadata → publish is enough. The last two stay
 * drafts so the media library shows both statuses. Returns published asset
 * ids for links.
 */
export async function seedAssets(run: SeedRun, blob: BlobStore): Promise<string[]> {
  const { ctx, scope, locale, hasDe } = run;

  const existing = await listAssets(ctx, scope, { limit: FILES.length + 10 });
  if (existing.length > 0) {
    return existing.filter((a) => a.status === 'published').map((a) => a.id);
  }

  const publishedIds: string[] = [];
  for (const [i, file] of FILES.entries()) {
    const de = hasDe ? DE_TITLES[file.title] : undefined;
    const { asset } = await createAsset(ctx, blob, scope, {
      fileName: file.fileName,
      contentType: file.contentType,
      title: localized(locale, file.title, de ? { 'de-DE': de } : undefined) as Record<
        string,
        string
      >,
      description: localized(
        locale,
        `${file.title} — demo media seeded for local development.`,
      ) as Record<string, string>,
    });
    if (i % 2 === 0) {
      await setAssetMetadata(ctx, scope, asset.id, {
        altText: localized(
          locale,
          `${file.title} (alt text)`,
          de ? { 'de-DE': `${de} (Alternativtext)` } : undefined,
        ) as Record<string, string>,
        tags: [pick(['brand', 'press', 'product', 'event', 'editorial'] as const, i)],
        focalPoint: { x: 0.25 + (i % 3) * 0.25, y: 0.35 + (i % 2) * 0.3 },
      });
    }
    const publish = i < FILES.length - 2;
    if (publish) {
      await publishAsset(ctx, scope, asset.id);
      publishedIds.push(asset.id);
    }
  }
  logger.info({ assets: FILES.length }, 'seed: created assets');
  return publishedIds;
}
