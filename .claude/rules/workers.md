---

paths:

- apps/api/**
- apps/delivery/**
- apps/engine/**
- apps/media/**
- packages/platform/**
- packages/adapters/**
- scripts/install.ts
- scripts/setup.sh
- scripts/deploy.sh
- .env.example

---

# The Workers (api, delivery, engine) and their platform

- Apps are thin composition entries; shared code lives in packages. `packages/platform/src/wire.ts`
  (`wireEdge`) binds adapters to ports; `EdgeEnv` (`src/env.ts`) is the typed binding and var
  surface for every Worker.
- Split by traffic profile: `apps/api` is HTTP only (Management, Preview, MCP, OAuth, media, live)
  with Smart Placement; `apps/delivery` is the public Delivery API (gateway authenticates every
  request, then the cached, unroutable `Delivery` entrypoint reads D1 replicas); `apps/engine` has
  no route and owns every queue consumer, the cron, and every Durable Object and Workflow class,
  which api and delivery bind by `script_name: "contentworker-engine"`.
- Each `wrangler.jsonc` is the template `scripts/install.ts` renders for the install
  (`apps/<app>/wrangler.deploy.json`); never deploy it by hand. A new resource is created in
  `scripts/setup.sh` (and named in `shellVars` in `install.ts`), and operators re-run
  `pnpm cw:setup` before deploying the release that binds it (`infra-change`).
- A deploy (`scripts/deploy.sh`, run by the operator as `pnpm cw:deploy` or by the optional Deploy
  workflow) goes engine → media → api → delivery → web and rolls back engine first; the engine
  can't roll back past a Durable Object migration. DO migration tags only append (`apps/engine/wrangler.jsonc` and
  `scripts/do-migrations.test.ts`, same change).
- A new var or binding: `EdgeEnv`, config, every Worker that reads it, the local stack's vars in
  `apps/web/vite.config.ts`; if it varies per install, `toInstall`/`common()` in
  `scripts/install.ts`, `.env.example` and the job env of `.github/workflows/deploy.yml`; and
  `docs/configuration.md`. Secrets only through the install's secrets file or CI secrets
  (`install.ts` `SECRETS`, plus deploy.yml's Deploy step env), never `vars`.
- Workers rules: no floating promises (`ctx.waitUntil` for background work), no request state in
  module globals, no Node servers or filesystem (`nodejs_compat` only), Workflow effects only inside
  `step.do`. Check a bundle with `pnpm --filter @contentworker/<app> exec wrangler deploy --dry-run --outdir /tmp/<app>`.
- The Cloudflare account holds other projects: filter by the `contentworker` name prefix before any
  read of Workers, KV, queues, R2 or Vectorize, and never create or delete them from a session.
- Review with the `workers-reviewer` agent.
