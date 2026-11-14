# @contentworker/sdk

The ContentWorker SDK, in one package: read and render content in any framework or runtime,
verify webhooks, manage a space, generate types, and the `contentworker` command. Import only the
subpath you use; nothing else ends up in your bundle.

```sh
npm install @contentworker/sdk
```

```ts
import { createDeliveryClient, imageProps } from '@contentworker/sdk';
import { toHtml } from '@contentworker/sdk/rich-text';

const client = createDeliveryClient({
  baseUrl: 'https://cdn.cms.example.com',
  space: 'your-space',
  environment: 'main',
  token: process.env.CONTENTWORKER_CDA_TOKEN!,
});

const article = await client.getEntry(id, { locale: 'en-US', include: 1 });
const html = toHtml(article.fields.body, { entryHref: (t) => `/${t.fields?.slug}` });
```

| Import                            | What it is                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `@contentworker/sdk`              | The Delivery and Preview client, `imageProps` for delivered assets. Runs on `fetch` anywhere       |
| `@contentworker/sdk/rich-text`    | `toHtml`, `toMarkdown`, `toPlainText`, `excerpt` for `RichTextDocument` trees: escaped, safe links |
| `@contentworker/sdk/blocks`       | `renderBlocks`, `resolveBlocks`: a blocks field rendered with a function per block id              |
| `@contentworker/sdk/webhooks`     | `verifyWebhookSignature` for signed webhook deliveries                                             |
| `@contentworker/sdk/redirects`    | Resolve the space's redirects                                                                      |
| `@contentworker/sdk/inline-edit`  | Inline editing on previews                                                                         |
| `@contentworker/sdk/live-preview` | The live preview channel: `connectPreview`, `refAttrs`, `isSafeTokenValue` and the protocol        |
| `@contentworker/sdk/edge`         | A tiny Delivery client for edge functions and devices: one locale, flat fields                     |
| `@contentworker/sdk/management`   | The Management API client. Server only: a Management token never belongs in a bundle               |
| `@contentworker/sdk/react`        | React hooks (`useEntry`, `useEntries`, `useAsset`, …), `<Image>` and `<Blocks>`. Needs `react`     |
| `@contentworker/sdk/vue`          | Vue 3 composables, `<CwImage>` and `<CwBlocks>`. Needs `vue`                                       |
| `@contentworker/sdk/react-native` | An offline entry cache with delta sync and image helpers for React Native                          |
| `@contentworker/sdk/codegen`      | Generate TypeScript types from a content model, programmatically                                   |

React and Vue are optional peer dependencies: install the one you use.

## The `contentworker` command

Sign in to a workspace, keep the content model in a file, read and write entries, upload assets,
import files and generate types. Every command takes `--json` for scripts and agents. Node 24 or
later.

```sh
npx contentworker login --url https://api.cms.example.com
npx contentworker model export --out content-model.ts
npx contentworker types --out src/generated/content-types.ts
```

## Docs

- [SDKs guide](https://docs.contentworker.app/guides/sdks/)
- [Your own frontend](https://docs.contentworker.app/guides/your-own-frontend/)
- [CLI](https://docs.contentworker.app/guides/cli/)
