---
paths:
  - packages/sdk/**
---

# Public SDKs (`packages/sdk/*`)

- These ship to customers' browsers, apps and Workers (`@contentworker/sdk-core`, `sdk-web`,
  `sdk-vue`, `sdk-react-native`, `sdk-edge`, `sdk-management`, `sdk-codegen`). They import only
  other `@contentworker/sdk-*` packages (framework SDKs build on `sdk-core`), never domain, ports,
  application, http, platform or adapters. Types mirroring server shapes are redeclared here, not
  imported.
- Public exports are an API contract: don't rename or remove an export, or narrow a parameter type,
  without calling it out as a breaking change.
- Keep `sdk-core` and `sdk-edge` runtime-agnostic (`fetch`, no `node:*`), so they run in browsers
  and on workerd.
- A new management route in `packages/http/src/api/routes` usually needs a matching
  `sdk-management` method and test.
- Docs: `apps/docs/src/content/guides/sdks.mdx` and `docs/sdks.md`.
