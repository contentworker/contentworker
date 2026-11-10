# @contentworker/sdk-web

> A private workspace package. It ships on npm inside [`@contentworker/sdk`](../sdk/README.md) as `@contentworker/sdk/react`; the examples below use that name.

React hooks and components over `@contentworker/sdk`: `useEntry`, `useEntries`,
`useAsset`, `useSemanticSearch`, an `<Image>` for delivered assets, `<Blocks>` for blocks fields
([Rendering blocks](https://docs.contentworker.app/guides/blocks-from-code/#rendering-blocks)), and
inline editing on previews. Fetching happens on the client, so server rendering is predictable.

```sh
npm install @contentworker/sdk react
```

```tsx
import {
  ContentworkerProvider,
  createDeliveryClient,
  Image,
  useAsset,
} from '@contentworker/sdk/react';

const client = createDeliveryClient({ baseUrl, space, environment: 'main', token });

function Hero({ id }: { id: string }) {
  const { data } = useAsset(id, { locale: 'en-US' });
  // Nothing renders until the asset arrives. srcset, sizes, width/height, alt (alt text, else the
  // title, else decorative), lazy loading unless `priority`, focal point and placeholder colour.
  return <Image asset={data} sizes="(min-width: 960px) 960px, 100vw" priority />;
}

// <ContentworkerProvider client={client}><Hero id="…" /></ContentworkerProvider>
```

The focal point arrives as `object-position`; give the image `object-fit: cover` in a box of
another shape to use it. Other `<img>` attributes pass through, and your `alt` and `style` win.

**Local development.** A local stack has no media origin, so assets have an empty `srcset` and no
renditions, and `<Image>` renders the one signed `src`.

## Docs

- [SDKs guide](https://docs.contentworker.app/guides/sdks/)
- [Build an image component](https://docs.contentworker.app/guides/delivering-assets/#build-an-image-component)
