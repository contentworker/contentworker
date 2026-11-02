# @contentworker/sdk-codegen

Generates TypeScript types from your space's content model, so `entry.fields.title` is a `string`
rather than `unknown`. Ships the `contentworker-codegen` CLI.

```sh
npm install -D @contentworker/sdk-codegen

npx contentworker-codegen --url https://api.your-workspace.contentworker.app --space your-space \
  --environment main --token "$CONTENTWORKER_CPA_TOKEN" --out src/generated/content-types.ts
```

```ts
import type { ArticleFields } from './generated/content-types.js';

const article = await client.getEntry<ArticleFields>(id, { locale: 'en-US', include: 1 });
article.fields.title; // string
```

Each content type becomes a delivery shape (`ArticleFields`) and a management shape
(`ArticleDraftFields`, keyed by locale).

## Assets

An asset field in a delivery shape is `AssetLink | DeliveredAsset`: the link, or the asset itself
when `include` embeds it. `DeliveredAsset` is the same shape as `@contentworker/sdk-core`'s, so an
embedded asset goes straight into its `imageProps`:

```ts
import { imageProps } from '@contentworker/sdk-core';

const hero = article.fields.hero;
const props = hero && 'url' in hero ? imageProps(hero, { sizes: '100vw' }) : undefined;
```

**Local development.** A local stack has no media origin, so an embedded asset has an empty
`srcset` and no renditions, and `imageProps` gives the one signed `src`.

## Docs

- [SDKs guide](https://docs.contentworker.app/guides/sdks/#typed-content)
- [Delivering assets](https://docs.contentworker.app/guides/delivering-assets/)
