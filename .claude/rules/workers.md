---
paths:
  - apps/api/**
  - apps/delivery/**
  - apps/engine/**
  - packages/platform/**
  - packages/adapters/**
  - deployments/**
  - scripts/fleet.ts
  - scripts/provision.sh
---

# The edge workers (api, delivery, engine) and their platform

- Apps are thin composition entries; shared code lives in packages. `packages/platform/src/wire.ts`
  (`wireEdge`) binds adapters to ports; `EdgeEnv` (`src/env.ts`) is the typed binding and var
  surface for every worker.
- Split by traffic profile: `apps/api` is HTTP only (Management, Preview, MCP, OAuth, media, live)
  placed near the primary database; `apps/delivery` is the public Delivery API (gateway
  authenticates every request, then the cached, unroutable `Delivery` entrypoint reads database
  replicas); `apps/engine` has no route and owns every queue consumer, the cron, and every
  stateful-object and durable workflow class, which api and delivery bind by `script_name:
  "contentworker-engine"`.
- Each `wrangler.jsonc` is the template `scripts/fleet.ts` renders per deployment
  (`deployments/*.jsonc`); never deploy it by hand. A new resource must be provisioned
  (`scripts/provision.sh`) in every deployment before the merge that binds it (`infra-change`).
- CI deploys engine → api → delivery → web and rolls back engine first; the engine can't roll back
  past a stateful-object migration. Stateful-object migration tags only append
  (`apps/engine/wrangler.jsonc` and `scripts/do-migrations.test.ts`, same change).
- A new var or binding: `EdgeEnv`, config, every worker that reads it, the local stack's vars in
  `apps/web/vite.config.ts`, `fleet.ts` if it varies per deployment, `docs/configuration.md`.
  Secrets only through the deployment's GitHub environment (`fleet.ts` `SECRETS`), never `vars`.
- Edge worker rules: no floating promises (`ctx.waitUntil` for background work), no request state in
  module globals, no Node servers or filesystem (`nodejs_compat` only), durable-workflow effects
  only inside `step.do`. Check a bundle with `pnpm --filter @contentworker/<app> exec wrangler
  deploy --dry-run --outdir /tmp/<app>`.
- The platform account holds other projects: filter by the `contentworker` name prefix before any
  read of workers, key-value namespaces, queues, buckets or vector indexes, and never create or
  delete them from a session.
- Review with the `workers-reviewer` agent.
