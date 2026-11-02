# @contentworker/sdk-edge

A tiny, dependency-free Delivery client for edge functions, kiosks and devices. It always asks
for one locale, so field values come back flat, and can project to the fields you name.

```sh
npm install @contentworker/sdk-edge
```

```ts
import { createEdgeClient } from '@contentworker/sdk-edge';

const edge = createEdgeClient({
  baseUrl: 'https://cdn.your-workspace.contentworker.app',
  space: 'your-space',
  environment: 'main',
  token: process.env.CONTENTWORKER_CDA_TOKEN!,
  locale: 'en-US',
});
const posts = await edge.list('article', { limit: 10, pick: ['title', 'slug', 'hero'] });
```

## Assets

The edge client doesn't embed linked assets: an asset field is the link `{ id, linkType:
'Asset' }`. Where a device shows images, fetch the asset with
`@contentworker/sdk-core` and render it with its `imageProps`:

```ts
import { createDeliveryClient, imageProps } from '@contentworker/sdk-core';

const hero = await client.getAsset(post.fields.hero.id, { locale: 'en-US' });
const props = imageProps(hero, { width: 480 });
```

**Local development.** A local stack has no media origin, so assets have an empty `srcset` and
`imageProps` gives the one signed `src`.

## Docs

- [SDKs guide](https://docs.contentworker.app/guides/sdks/)
- [Delivering assets](https://docs.contentworker.app/guides/delivering-assets/)
