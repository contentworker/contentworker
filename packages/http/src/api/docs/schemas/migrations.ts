import { MIGRATION_DRIVER_STATUSES, MIGRATION_PAGE_STAGES } from '@contentworker/domain';
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
    .enum(['created', 'inventoried', 'clustered', 'stopped', 'failed'])
    .describe(
      'The step that last finished; `stopped` when its background driver ended without publishing',
    ),
  threshold: z.number().describe('Score a page needs to count as validated (0..1)'),
  inventory: z
    .object({
      discovered: z.int().describe('Pages the source listed or the crawl reached'),
      added: z.int().describe('Pages added to the run'),
      skipped,
      warnings: z.array(z.string()),
    })
    .nullable(),
  error: z.string().nullable().describe('Why the run failed or stopped'),
  releaseId: z
    .string()
    .nullable()
    .describe('The release its entries were added to, when publishing goes through one'),
  clusteringHeldAt: z.iso
    .datetime()
    .nullable()
    .describe('When its templates were taken on in the background: it isn’t clustered again after'),
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

const actor = z
  .union([
    z.object({ kind: z.literal('key'), keyId: z.string() }),
    z.object({ kind: z.literal('member'), memberId: z.string() }),
    z.object({ kind: z.literal('deployment') }),
  ])
  .describe('Who, by reference: an API key, a team member, or the deployment');

const trySummary = z.object({
  at: z.iso.datetime(),
  scriptSha256: z.string().describe('The script that was tried'),
  pages: z.int(),
  ok: z.int().describe('Pages whose output had the right shape for the model'),
  passed: z.int().describe('Pages scored at or above the run’s threshold'),
  meanScore: z.number(),
  problems: z.array(z.string()).describe('The first few failures and issues, one line each'),
});

export const migrationTemplate = z.object({
  id: z.string(),
  runId: z.string(),
  label: z.string(),
  status: z
    .enum(['pending', 'authoring', 'approving', 'approved'])
    .describe(
      '`approving` while an approval writes its content type; `authoring` again once reopened',
    ),
  pageCount: z.int(),
  samplePageIds: z.array(z.string()).describe('Representative pages, spread over the template'),
  contentTypeId: z
    .string()
    .nullable()
    .describe('The content type its pages become, once approved; kept when it is reopened'),
  script: artifact.nullable().describe('Its import script, once written'),
  proposal: z
    .record(z.string(), z.unknown())
    .nullable()
    .describe('The content type its pages are proposed to become (a content type definition)'),
  lastTry: trySummary.nullable().describe('How its script did the last time it was tried'),
  approvedBy: actor.nullable().describe('Who approved it: its pages are loaded as them'),
  reviewDigest: z
    .string()
    .describe('SHA-256 of the proposal and script version: what `reviewed` names to approve it'),
  pageVersions: z
    .object({
      toTransform: z
        .int()
        .describe('Pages never transformed, or transformed by an earlier approved version'),
      loadedEarlier: z
        .int()
        .describe('Pages loaded or published from an earlier version, left as they are'),
    })
    .nullable()
    .optional()
    .describe('On a read of one template, once approved: where its pages stand against it'),
  version: z.int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const migrationTemplateList = z.object({ items: z.array(migrationTemplate) });

export const migrationDriver = z.object({
  state: z
    .enum(MIGRATION_DRIVER_STATUSES)
    .describe(
      'Its background run: `none` (it has none), `running`, `waiting` (for an approval, the ' +
        'go-ahead, a site it can’t read or a retry), `paused`, `finished`, or `unknown` (it ' +
        'couldn’t be asked now)',
    ),
  startedBy: actor.nullable().describe('Null when never started, or started before this was kept'),
  startedAt: z.iso.datetime().nullable(),
  startedByYou: z.boolean(),
  goAhead: z.object({
    status: z
      .enum(['none', 'given', 'unknown'])
      .describe('`unknown`: one may have been given before go-aheads were recorded'),
    approvedBy: actor.optional(),
    approvedAt: z.iso.datetime().optional(),
    byYou: z.boolean().optional().describe('You gave it, so you can send the same one again'),
    viaRelease: z.literal(true).optional().describe('Added to a release rather than published'),
    releaseId: z.string().optional(),
    releaseTitle: z.string().optional(),
    delivered: z
      .boolean()
      .optional()
      .describe('It certainly reached the background run; false when that isn’t known'),
  }),
});

export const migrationRunView = z.object({
  run: migrationRun,
  driver: migrationDriver,
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

export const migrationScript = z.object({
  script: z.string().nullable().describe('The import script as text; null before one is written'),
  sha256: z.string().nullable(),
});

const output = z
  .object({
    fields: z.record(z.string(), z.unknown()).describe('Field values; rich text as documents'),
    blocks: z.array(z.object({ variant: z.string(), fields: z.record(z.string(), z.unknown()) })),
    assets: z.array(z.object({ url: z.string(), alt: z.string().optional() })),
    links: z.array(z.object({ href: z.string() })),
  })
  .describe('The script’s output, resolved: every `$html` fragment is a RichTextDocument');

export const migrationTryResult = z.object({
  summary: trySummary,
  results: z.array(
    z.object({
      pageId: z.string(),
      url: z.string(),
      ok: z.boolean().describe('The output has the right shape for the model'),
      output: output.optional(),
      score: score.optional(),
      issues: z.array(z.string()).describe('Shape and model problems'),
      error: z.string().optional().describe('Why the script produced no output'),
      logs: z.array(z.string()).describe('What the script logged: the page’s text, untrusted'),
    }),
  ),
});

export const migrationApproval = z.object({
  template: migrationTemplate,
  signalled: z.boolean().describe('The run’s driver was told'),
  reason: z
    .enum(['no-driver', 'driver-finished', 'unreachable'])
    .optional()
    .describe(
      'Why it wasn’t: no driver (a run taken step by step), its driver has finished, or it ' +
        'couldn’t be reached now (approve again to tell it)',
    ),
});

const pageFailure = z.object({ pageId: z.string(), url: z.string(), error: z.string() });

export const migrationTransformResult = z.object({
  transformed: z.int(),
  validated: z.int(),
  needsFix: z.int(),
  failed: z.array(pageFailure).describe('Pages with no usable output, now needs-fix'),
  next: z.string().optional().describe('Pass as `after` to go on; absent at the end'),
  more: z.boolean(),
});

export const migrationLoadResult = z.object({
  loaded: z.int(),
  failed: z.array(pageFailure).describe('Pages refused, now needs-fix with the reason'),
  assetFailures: z.array(pageFailure).describe('Files not brought in; their pages loaded without'),
  unresolvedLinks: z.int().describe('Links to pages with no entry yet, for the relink pass'),
  deferred: z.array(pageFailure).describe('Pages that kept losing a race, left for the next call'),
  stale: z
    .int()
    .describe('Pages left as they are: an earlier version made their output. Transform them first'),
  more: z.boolean(),
});

export const migrationRelinkResult = z.object({
  checked: z.int(),
  relinked: z.int(),
  unresolvedLinks: z.int(),
  skipped: z.array(pageFailure).describe('Entries edited since they were read'),
  next: z.string().optional().describe('Pass as `after` to go on; absent at the end'),
});

export const migrationRedirectsResult = z.object({
  created: z.int(),
  updated: z.int(),
  unchanged: z.int(),
  skipped: z.object({
    identity: z.int().describe('The old path is the new one'),
    noUrlPattern: z.int().describe('The type has no URL pattern'),
    unresolved: z.int().describe('No path could be made for the entry'),
  }),
  chains: z.array(z.object({ id: z.string(), via: z.array(z.string()), destination: z.string() })),
});

export const migrationPublishResult = z.object({
  published: z.int(),
  added: z.int().describe('Entries added to the release'),
  releaseId: z.string().optional(),
  failed: z.array(pageFailure).describe('Pages whose entry wasn’t published: they stay loaded'),
  next: z.string().optional().describe('Pass as `after` to go on; absent at the end'),
});

export const migrationStartResult = z.object({
  started: z.boolean().describe('False when the run’s driver was running already'),
});

export const migrationPublishApproval = z.object({
  accepted: z.literal(true).describe('The go-ahead is recorded on the run'),
  signalled: z.boolean().describe('Whether the run’s driver was told, now or before'),
  reason: z
    .literal('unreachable')
    .optional()
    .describe('Why it wasn’t: send the same go-ahead again to tell it'),
});
