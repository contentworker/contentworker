# contentworker documentation

These are the maintainer docs: how contentworker is built and how to run, extend and integrate
with it. They are not published; the public site is `apps/docs`. contentworker runs entirely on
Cloudflare, one isolated stack per customer: four Workers (`apps/web`, `apps/api`,
`apps/delivery`, `apps/engine`) on D1, with R2, KV, Queues, Durable Objects, Workflows,
Vectorize, Workers AI through AI Gateway, Images, Stream, Email Sending and Worker Loader.

## Contents

1. **[Architecture](./architecture.md)**: the Workers and why they are split, data placement,
   the hexagonal layers and package map, request and event flow, editorial workflow runs, media,
   and the hook seam.
2. **[Domain model](./domain-model.md)**: field types, the validation engine, the entry publish
   state machine, localization and fallback, references, assets, platform aggregates and domain
   events.
3. **[API reference](./api-reference.md)**: every Management, Delivery and Preview endpoint, which
   host serves it, the query language, hybrid search, Live Content SSE and error mapping.
4. **[Auth & RBAC](./auth-and-rbac.md)**: web sign-in (passwords, passkeys, TOTP, OIDC, SCIM,
   setup), the signed web principal, API key kinds, scopes, roles, OAuth 2.1, and the `authorize`
   decision.
5. **[AI, agents & search](./ai-agents-and-search.md)**: Workers AI, hybrid search (FTS5 search
   shards + Vectorize), the MCP server, its tools and skills, and the agent runtime.
6. **[Events & webhooks](./events-and-webhooks.md)**: the transactional outbox, lease-claimed
   relay, the engine's queue consumers, delivery cache purges, webhooks and event payloads.
7. **[Consistency & guarantees](./consistency.md)**: the D1 unit of work, read replicas and the
   `x-cw-bookmark` header, D1 limits, and the staleness bounds of delivery.
8. **[Configuration](./configuration.md)**: every binding, var and secret, and which Worker uses
   it.
9. **[Deployment](./deployment.md)**: the fleet registry, provisioning, secrets, the CI pipeline
   (migrate, deploy engine → api → delivery → web, smoke, rollback) and admin recovery.
10. **[Backup & restore](./backup-and-restore.md)**: what holds state, D1 Time Travel, environment
    snapshots, outbox replay and the restore runbook.
11. **[Development](./development.md)**: running the stack locally, test suites, conventions,
    adding a use-case, changing the D1 schema, and the schema reference.
12. **[Admin UI](./admin-ui.md)**: the React Router admin on the web Worker, sign-in routes,
    layout, features and its tests.
13. **[SDKs](./sdks.md)**: the Delivery clients (`@contentworker/sdk-core`, web, vue, edge,
    react-native), the Management client (`@contentworker/sdk-management`) and
    `contentworker-codegen`.
14. **[Plugins](./plugins.md)**: sandboxed write-path plugins on Worker Loader isolates:
    manifests, capabilities, hooks and distribution policy.

## Conventions used in these docs

- **Scope** means `{ spaceId, environmentId }`, the boundary carried through every operation. An
  _environment_ is a branch within a _space_ (e.g. `main`, `staging`). A _deployment_ is one
  customer's whole stack; spaces live inside it.
- **CMA / CDA / CPA** are the Content Management / Delivery / Preview API key kinds.
- Hosts: the admin at `<domain>`, the api at `api.<domain>`, public delivery at `cdn.<domain>`.
- Paths shown like `/spaces/:space/environments/:env/...` use `:param` for path segments.
- **`…`** abbreviates `/spaces/:space/environments/:env` in Management API tables.
