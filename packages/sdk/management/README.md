# @contentworker/sdk-management

> A private workspace package. It ships on npm inside [`@contentworker/sdk`](../sdk/README.md) as `@contentworker/sdk/management`; the examples below use that name.

The client for ContentWorker's Management API: content types, entries and their versions, the
asset library, bulk jobs, releases, scheduled actions, webhooks, environments and keys. No
dependencies; it runs on `fetch`. Keep it on a server: a Management token never belongs in a
browser or app bundle.

```sh
npm install @contentworker/sdk
```

```ts
import { createManagementClient } from '@contentworker/sdk/management';

const cma = createManagementClient({
  baseUrl: 'https://api.cms.example.com',
  space: 'your-space',
  environment: 'main',
  token: process.env.CONTENTWORKER_CMA_TOKEN!,
});

const { entry } = await cma.entries.create({
  contentTypeApiId: 'article',
  fields: { title: { 'en-US': 'Hello, world' } },
});
await cma.entries.publish(entry.id, { expectedVersion: entry.currentVersion });
```

The client is exactly as powerful as its token; the server checks every call. A read after the
client's own write sees it (it echoes the api's `x-cw-bookmark`).

## Assets

```ts
// Any size: one signed upload up to 100 MiB, a multipart upload above it, each part retried.
const asset = await cma.assets.upload(
  { fileName: 'hero.jpg', contentType: 'image/jpeg', body: file },
  { onProgress: ({ loaded, total }) => console.log(`${loaded}/${total}`) },
);
await cma.assets.setMetadata(asset.id, { altText: { 'en-US': 'A hand holding a cup' } });
await cma.assets.publish(asset.id);

// A new file, whatever its size: the asset at its next version.
await cma.assets.replaceFile(asset.id, {
  fileName: 'hero-v2.jpg',
  contentType: 'image/jpeg',
  body,
});

for await (const a of cma.assets.iterate({ kind: 'image' })) {
  // the whole library, fetched a page at a time as the loop reads
}
for await (const a of cma.assets.collections.iterateAssets(collectionId)) {
  // a collection's members, in its order
}
```

`assets` also has `versions` and `restoreVersion`, `setRights`, `usage`, `transformUrl`,
`generateAltText` and `autoTag`, `videos`, `bulk` (followed with `bulkJobs`), and the `folders`,
`collections`, `shareLinks`, `zips` and `renditions` namespaces. `Asset` is fully typed: `file`
(`AssetFile`, with `video` on a hosted video), `metadata`, `rights`, `ingestStatus` and the rest.

A signed upload URL stores its file once; a second `PUT` through it is a `412`. On a retry,
`upload` and `replaceFile` count that 412 as stored (an earlier attempt's bytes landed and only its
answer was lost); on a first attempt they throw it.

## Site migration

```ts
const run = await cma.migrations.create({
  source: { kind: 'sitemap', url: 'https://example.com', exclude: ['/blog/**'] },
});
await cma.migrations.inventory(run.id);
// One bounded batch a call (`limit` 1..10, default 10): fetch again while pages wait.
for (let more = true; more; ) {
  const batch = await cma.migrations.fetchPages(run.id);
  more = batch.more && !batch.unavailable;
}
const { templates } = await cma.migrations.cluster(run.id); // `{ threshold }` 0..1, default 0.6
```

`create` also takes `agentTokenCap`, the tokens a background run's authoring agents may take in all; `get`
answers it in `agentTokens` with what they have spent.

`migrations` also has `list`, `get`, `pages` (by `stage` or `template`, paged with `nextCursor`) and
`templates`. Running a step needs `migration:run`; reading a run needs it or `content:manage`.
Pages carry the hash and size of their stored HTML, never the HTML.

Each template becomes a content type with an import script, and a person approves it:

```ts
const t = templates[0];
await cma.migrations.proposeModel(run.id, t.id, model); // one blocks field, a urlPattern
await cma.migrations.setScript(run.id, t.id, script); // text, at most 256 KiB
const { summary } = await cma.migrations.tryScript(run.id, t.id); // outputs with rich text resolved
// As someone with content:manage, approving what they read:
const { reviewDigest } = await cma.migrations.template(run.id, t.id);
await cma.migrations.approve(run.id, t.id, reviewDigest); // 409 if it changed since

// Then the pages, ten a call (or `start(run.id)` to run it all in the background):
let after: string | undefined;
do {
  ({ next: after } = await cma.migrations.transform(run.id, t.id, after ? { after } : {}));
} while (after);
for (let more = true; more; ) more = (await cma.migrations.load(run.id, t.id)).more;
await cma.migrations.relink(run.id);
await cma.migrations.redirects(run.id);
await cma.migrations.publish(run.id, { viaRelease: true, releaseTitle: 'Site launch' });
```

`transform`, `relink` and `publish` (including `viaRelease`) page with `after: next`; `load` needs `content:write` and `assets:write`,
`redirects` `content:manage` and `publish` `content:publish`. After `start`, `approvePublish` is the
driver's go-ahead to publish: a run takes one, and sending the same one again is safe (do, after
`signalled: false`). `get`'s `driver` says where the background run is, who started it and whether the
go-ahead was given. `reopen(run, template, reviewDigest)` (`content:manage`) takes an
approved template back to `authoring`, to change its model or script and approve it again; its
`apiId` stays. `transform` then retakes its pages that aren't loaded, and `load` leaves pages of an
earlier version where they are (`stale`). `template`'s `pageVersions` counts both.

## Errors

A failed call throws `ManagementError` with `status`, the API's error `code`, the parsed `error`
object and the raw `body`. Guards narrow it to the details a code carries:

```ts
import { isAssetInUse, isAssetRightsError } from '@contentworker/sdk/management';

try {
  await cma.assets.archive(id); // deleting needs an archived asset
  await cma.assets.delete(id);
} catch (err) {
  if (isAssetInUse(err)) {
    console.log(`Linked from ${err.error.total} entries`, err.error.usage);
  } else throw err;
}
```

`isAssetInUse` (`usage`, `total`), `isAssetRightsError` (`embargoUntil` or `expiresAt`),
`isValidationError` (`issues`), `isConflict`, `isNotFound` and `isRateLimited`.

## Docs

- [SDKs guide](https://docs.contentworker.app/guides/sdks/#writing-content)
- [Media and assets](https://docs.contentworker.app/guides/media/)
- [REST API errors](https://docs.contentworker.app/reference/rest-api/#errors)
