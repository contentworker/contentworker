import { MIGRATION_PAGE_STAGES } from '@contentworker/domain';
import { z } from 'zod';

// --- site migrations -----------------------------------------------------------

const artifact = z
  .object({
    sha256: z.string().describe('SHA-256 of the bytes, hex'),
    bytes: z.int(),
  })
  .describe('A stored file, by hash and size; its bytes are never sent inline');

const skipped = z.object({
  robots: z.int().describe('Disallowed by the site’s robots.txt'),
  filtered: z.int().describe('Left out by the include and exclude globs'),
  offOrigin: z.int().describe('On another origin than the source URL'),
  overLimit: z.int().describe('Over the run’s maxPages'),
  invalid: z.int().describe('Not a usable http(s) URL'),
});

export const migrationRun = z.object({
  id: z.string(),
  name: z.string(),
  source: z.object({
    kind: z.enum(['sitemap', 'crawl']),
    url: z.string(),
    include: z.array(z.string()),
    exclude: z.array(z.string()),
    maxPages: z.int(),
  }),
  status: z
    .enum(['created', 'inventoried', 'clustered', 'failed'])
    .describe('The step that last finished'),
  threshold: z.number().describe('Score a page needs to count as validated (0..1)'),
  inventory: z
    .object({
      discovered: z.int().describe('Pages the source listed or the crawl reached'),
      added: z.int().describe('Pages added to the run'),
      skipped,
      warnings: z.array(z.string()),
    })
    .nullable(),
  error: z.string().nullable(),
  releaseId: z
    .string()
    .nullable()
    .describe('The release its entries were added to, when publishing goes through one'),
  version: z.int().describe('Counts up with every write'),
  createdAt: z.iso.datetime(),
  createdBy: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});

export const migrationRunList = z.object({ items: z.array(migrationRun) });

const pageCounts = z.object({
  total: z.int(),
  fetched: z.int().describe('Pages with HTML'),
  failed: z.int().describe('Pages whose last step failed'),
  byStage: z.record(z.enum(MIGRATION_PAGE_STAGES), z.int()),
});

export const migrationTemplate = z.object({
  id: z.string(),
  runId: z.string(),
  label: z.string(),
  status: z.enum(['pending', 'authoring', 'approved']),
  pageCount: z.int(),
  samplePageIds: z.array(z.string()).describe('Representative pages, spread over the template'),
  contentTypeId: z.string().nullable().describe('The content type its pages become, once chosen'),
  script: artifact.nullable().describe('Its import script, once written'),
  version: z.int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const migrationTemplateList = z.object({ items: z.array(migrationTemplate) });

export const migrationRunView = z.object({
  run: migrationRun,
  pages: pageCounts,
  templates: z.array(migrationTemplate).describe('Largest first'),
});

const score = z.object({
  overall: z.number(),
  textCoverage: z.number(),
  imagesMissing: z.int(),
  imagesLost: z.int(),
  sourceLinks: z.int(),
  outputLinks: z.int(),
  issues: z.array(z.string()),
});

export const migrationPage = z.object({
  id: z.string(),
  runId: z.string(),
  url: z.string().describe('Absolute, without fragment or query'),
  path: z.string(),
  depth: z.int().describe('Links from a crawl’s start page; 0 for a sitemap’s pages'),
  stage: z.enum(MIGRATION_PAGE_STAGES),
  templateId: z.string().nullable(),
  title: z.string().nullable(),
  lastModified: z.string().nullable().describe('The sitemap’s lastmod, when it gave one'),
  httpStatus: z.int().nullable().describe('Status of the last fetch; 0 when no response came'),
  html: artifact.nullable().describe('The page as fetched'),
  output: artifact.nullable().describe('The import script’s structured output'),
  score: score.nullable(),
  entryId: z.string().nullable(),
  unresolvedLinks: z
    .int()
    .describe('Links in its entry to run pages that had no entry yet, left for the relink pass'),
  error: z.string().nullable().describe('Why its last step failed'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const migrationPageList = z.object({
  items: z.array(migrationPage),
  nextCursor: z.string().optional().describe('Present only while more pages follow'),
});

export const migrationFetchResult = z.object({
  fetched: z.int(),
  failed: z.int(),
  added: z.int().describe('Pages a crawl found on this batch’s pages and added'),
  more: z.boolean().describe('Pages are still waiting: call again while true'),
  unavailable: z
    .string()
    .optional()
    .describe('The site can’t be read now (robots.txt unreadable); nothing was written'),
});
