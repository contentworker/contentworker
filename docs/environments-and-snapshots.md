# Environments and snapshots

How an environment is exported, imported, cloned and deleted, and how content from other formats
is imported. The routes are in the [API reference](./api-reference.md#environment-snapshots);
restore points for the database are in [Backup & restore](./backup-and-restore.md).

## Snapshots

`GET …/export` produces portable JSON for one environment, `POST …/import` replays it into this one
and `POST …/clone` does both, including across spaces (`packages/application/src/snapshots.ts`
and `snapshot-jobs.ts`).

A snapshot carries the content model, entries (with taxonomy metadata), taxonomy, workflows, and
asset **metadata**. It deliberately never carries **credentials** (API keys, OAuth clients and
grants, preview tokens, webhook signing secrets), because a snapshot is a file people move around.
Asset **binaries** stay in the blob store: a restore into a space pointing at the same bucket
works, and one pointing elsewhere has dangling files, which is visible rather than silent. The
import report names everything it did not carry.

**Import replays domain operations** rather than injecting rows: entries go through `createEntry`
and are republished through `publishEntry`. That is slower than a bulk insert, and deliberate:
validation, the reference graph, the delivery read model, the outbox and the search index all reach
the state they would have reached organically. A snapshot is therefore not a back door: content the
current model would reject fails the import loudly.

Import requires a target environment with **no content types**, and the target environment must
exist (create it first). Merging two content models is a different and much harder operation; use
`compare`/`merge` for the intra-space case. Cloning is the cross-space case those cannot cover, and
the target space is authorized separately so a clone cannot cross a tenancy boundary.

What an import preserves:

- **Ids.** Entries and asset records keep their ids (every table is keyed per environment), so
  links between them resolve in the target unchanged, and comparing or merging the copy against
  its source matches entries one to one. Taxonomy ids are remapped.
- **Every entry.** The export reads every page of entries and assets, not the store's first page.
- **Live and draft versions.** A `changed` entry (published, with edits since) carries its live
  version's fields too: the import publishes those, then applies the draft, so the copy has the
  same live content and the same pending edits. Snapshots from before this carry no live version,
  and their changed entries land as drafts.
- **Assets** as records, published as they were; their files stay where they are.

### Checks before any write

Every entry is validated against the snapshot's content model and the target space's locales, and
every link in what will be published must point at an entry or asset the snapshot carries. Any
problem refuses the import with a `422` that lists them (up to 50, each naming its entry) and
writes nothing, so the target stays empty and a corrected retry works. `?dryRun=true` runs the same
checks and answers `200`. A failure the checks can't foresee (a plugin hook refusing an entry, an
infrastructure error) is reported per entry in the job's report.

### Import and clone run as jobs

Replaying every entry through the use-cases is far more than one request can hold for an
environment of any size. After the checks, the import request writes the content model, taxonomy
and workflows (small, and everything else depends on them) and answers `202` with
`{ report, job, publishJobId }`. The assets and entries are staged in the blob store in chunks of
100 before the model is written (so a staging failure leaves the target empty and a retry works),
and written by bulk jobs, with progress at `…/bulk/jobs/:id` and per-item failures at
`…/bulk/jobs/:id/report` in the **target** environment. The chunks run in the engine as
`bulk.chunk_due` events.

1. `job` creates the asset records and entries, as drafts, under their own ids.
2. `publishJobId` starts when `job` completes, in the same write that finalizes it: it publishes
   what the snapshot had published (assets, then entries), then lays each changed entry's draft on
   top. It waits because publishing an entry needs every entry and asset it links to to exist, and
   chunks run concurrently. It starts only if `job` completes with no failures (otherwise `job`'s
   report names what failed, and nothing is published); it never starts if `job` is cancelled, and
   it is `null` when nothing is published (`?publish=false`, or a snapshot of drafts).

Staged work is removed as each chunk finishes, and whatever is left (a chunk that failed for good, a
publishing job that never started, a cancelled job) when the job completes or is cancelled. Each
imported entry is created and published through the use-cases, so it emits its own events (webhooks,
search and vector indexing) as an entry written by hand would.

Every chunk step is safe to run again after a crash: an entry already created isn't created twice,
and one already published (or already carrying its draft) isn't published again. A snapshot with no
entries or assets answers `job: null`. Without a blob store (local fakes), import and clone run
synchronously and answer `201` with the report.

**A clone runs entirely as jobs.** An import's snapshot arrives in the request body, so its checks
run there; a clone's source is read from the database, so even the export and the checks move off
the request. `POST …/clone` checks only that both environments exist and the target holds no
content types, and answers `202` with `{ job, createJobId, publishJobId }`. `job` (one `prepare`
chunk, in the engine) exports the source, runs every check, stages the work, writes the model and
starts `createJobId`, as an import's request would, under create and publish job ids fixed when the
clone started (so a re-run after the create job exists does nothing). A snapshot the checks refuse
fails `job`, and its report (`…/bulk/jobs/:id/report`) names the problems; nothing is written.
`publishJobId` starts when `createJobId` completes cleanly, and only exists if anything is
published. A dry run (`dryRun: true` on the MCP tool) still exports and checks in the request.

## Deleting an environment

`DELETE …/environments/:env?confirm=:env` (MCP `environment_delete`) removes the environment and
everything in it: content model, entries and versions, assets, references, releases, schedules,
workflows and runs, taxonomy, comments, tasks and jobs, and the webhooks scoped to it (space-wide
ones stay). Its audit history stays. `confirm` must
repeat the environment id. It takes a person holding `space:admin` in that space (signed in, or
through their OAuth or personal access token) or the deployment admin token; a plain API key gets
`403`, even one with `space:admin`. It refuses `main` (`422`) and any environment an alias points
at (`409`: repoint or remove the alias first).

One atomic write takes the environment out of the registry, so from that moment it answers `404`
to reads and writes on every surface. The same write records an `environment.deleted` audit row
naming the caller (on both surfaces, so a deletion never commits unrecorded), appends
`environment.deleted` events (published entry ids in chunks of 500) and the first
`environment.purge_due`. From the first, the engine removes the entries' search documents and
vectors and purges the delivery cache. Search results only ever include entries published now, so
an index document that outlives its entry is never served.

The rows themselves go afterwards, in bounded steps, because D1 refuses one statement that modifies
hundreds of thousands of rows. Each step deletes at most 500 rows from each of the environment's
tables (`PURGE_ROWS_PER_TABLE`), and each `environment.purge_due` runs up to 20 steps
(`PURGE_STEPS_PER_EVENT`) before handing on to the next. When nothing is left, the environment's
asset files go from the blob store (keeping any another environment's asset records still point at,
as a clone's do) and its id is free again. Until then, creating an environment with that id is
refused (`409`). A purge whose event is lost is restarted by the engine's cron after five minutes
without progress (`PURGE_STALE_SECONDS`). The pending purges are the `environment_purges` table
(`0003_environment_purges.sql`).

## Importing from other formats

Snapshots move content between contentworker environments. This moves it _in_, from a format
someone else produced. The routes are `GET …/imports/sources`, `POST …/imports/analyze`,
`POST …/imports` and `POST …/imports/job` (all `content:write`).

Both POSTs take the same body, so analyzing and running are the same request to two paths:

```jsonc
{
  "source": "csv", // or "json", "wxr"
  "payload": "sku,title\nA-1,Widget\n", // the file, as text
  "mapping": {
    "contentTypeApiId": "product",
    "fields": { "name": "title", "sku": "sku" }, // target apiId -> source field
    "identityField": "sku", // what makes a re-run recognise its own work
    "locale": "en-US" // default: the space's default locale
  },
  "sourceOptions": { "identityField": "sku" },
  "conflicts": "skip" // skip (default) | update | fail
}
```

The admin drives exactly this, from the entries list of any content type. It reads a file by
analyzing it with an **empty mapping** (every source field then comes back as unmapped, which is the
column list) rather than parsing it locally, so the names offered for mapping cannot disagree with
the names the import sees.

**Two phases, one computation.** `analyze` and the run share the same planner, so the report is not
a prediction: it is the run, without the commit. A migration is irreversible in practice, and the
decision to start one should be made while looking at its consequences.

The analysis reports what would be created, updated and skipped, plus three things that are only
findable beforehand:

- **`unmappedSourceFields`**: columns nothing maps to. This is the data the import throws away.
- **`missingRequiredFields`** / **`unknownTargetFields`**: a mapping that cannot work at all.
  These block execution; per-record failures do not.
- **`issues`**: a bounded sample of records that would fail, each named by its source id.

**Re-running is safe when `identityField` is set.** With it, a second run matches what the first
created and skips (or updates) it. Without it, every run creates everything again, which the
analysis makes visible rather than leaving to be discovered.

Entries arrive as **drafts**. Publishing them is the existing bulk job, which is resumable,
cancellable and reportable, none of which a flag on the import would be. A record that fails
validation is skipped and reported rather than aborting the run, and trashed entries are never
matched as conflicts: an import must not silently revive something someone deleted.

**Text for a RichText field is read as HTML.** Paragraphs, headings, lists, quotes, code blocks,
rules, tables, links and inline marks map to their rich-text nodes; a blank-line-separated block of
plain text becomes paragraphs, as WordPress renders it. The reader is lenient (unclosed tags and stray
end tags are recovered the way a browser recovers them) and keeps the text of any element it does not
know. Images and embeds become **links to their source**, since there is no asset to point an embed at
yet; a link is visible and fixable, where a dropped image is neither. A `<table>` becomes a `table`
(rows from `thead`, `tbody` and `tfoot` alike, `th` as header cells, `colspan`/`rowspan` kept); its
caption becomes a paragraph before it, and a table with no cells or over the size limits keeps its
text as paragraphs instead. A value that is already a rich-text document is left alone.

### WordPress exports (`wxr`)

The file from WordPress's _Tools → Export_. It holds posts, pages, attachments, menu items and
revisions in one list, and a mapping targets one content type, so the source reads one kind at a time:

```jsonc
"sourceOptions": {
  "postType": "page",           // default "post"; a list reads several
  "statuses": ["publish"]       // default: everything except auto-draft and trash
}
```

What it passed over is **named in `warnings`** ("Not read (other post types): page (12),
attachment (40)") along with comments, which are not imported. An export where the pages silently did
not come across is the failure this guards against.

Each item becomes flat fields: `id` (the WordPress post id, which is the identity, so map it to a field and
set `identityField` to make re-runs safe), `title`, `slug`, `content` (the post's HTML as stored),
`excerpt`, `status`, `date`/`modified` (ISO-8601; the GMT time when WordPress recorded one),
`author`/`authorName`, `link`, `parentId`, `menuOrder`, `sticky`, `categories` and `tags` (lists of
names), `terms.<taxonomy>` for custom taxonomies, `featuredImage` (the attachment's URL, resolved
within the file), `attachmentUrl` when reading attachments, and `meta.<key>` for custom fields.
WordPress's own bookkeeping meta (`_edit_lock` and the like) is left out; other underscore keys are
kept, since plugins store real content that way, and show up in `unmappedSourceFields` for you to
decide on.

The XML reader does not process a document type's internal subset, so a file cannot define entities
(the mechanism behind entity-expansion and local-file-read attacks), and an error names the line it
happened on, and says when the file looks truncated.

Payload size is bounded by `MAX_BODY_BYTES` (default 5 MB) on HTTP, and by the source's own 20 MB
cap elsewhere. The synchronous run refuses a file with more than 10,000 records; past that, use the
durable path.

### Bigger than one request

`POST …/imports/job` takes the same body and returns the same report, chunked into a resumable
job: `202` with `{ job, analysis }`. The analysis is the same one `analyze` returns, and the job is
an ordinary bulk job, so progress polls at `…/bulk/jobs/:id`, per-record failures at
`…/bulk/jobs/:id/report`, and cancellation at `…/bulk/jobs/:id/cancel`, exactly as for a bulk
publish. Reading those requires `content:write` rather than `content:publish`, because someone who
can start an import must be able to watch it.

Planning is still one pass over the whole file (a report describing only part of a file is worse
than no report), so the durable path bounds memory, not time, at 250,000 records. What it chunks is
the writing. Records the report already counted as skipped are never staged: a job whose progress bar
counts work it will refuse reads as slower than it is.

Chunk work is staged in the blob store at plan time, once. Every chunk re-reading and re-parsing the
source file would make a 40,000-row import quadratic. **A consumer without a blob store leaves import
chunks claimable** rather than reporting an import that did not run, visible as a job that does not
progress. On a deployment that means `MEDIA_BUCKET` (R2), where chunks are staged under `imports/`.
