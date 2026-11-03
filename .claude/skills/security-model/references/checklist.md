# Security checklist, by boundary

Run the sections the diff touches. Each item is a question with the place to look; a "no" is a
candidate finding that still needs a concrete attacker before it is reported.

## Web → api (`x-cw-principal`)

- Does every path the gateway forwards (`isApiPath` in `apps/web/app/lib/gateway.server.ts`)
  delete a caller-sent `x-cw-principal` first, and sign a new one only for a same-origin request
  with a live session, **for its own path**?
- Does a bearer request pass through with no principal header at all?
- Does the api verify with every key in `principalKeys` (current and previous), check `path`
  against the path it was actually called on, and refuse an expired, future-dated (beyond the skew)
  or unsigned header? `grep -rn "PRINCIPAL_HEADER" packages/http/src`.
- Does anything widen `PRINCIPAL_TTL_S`, accept a missing `exp`, or fall back to
  `DEV_PRINCIPAL_KEY` outside local development?
- Does any cookie or session id reach the api?

## Delivery

- Is the `Delivery` entrypoint still reachable only from the gateway in `apps/delivery/src/index.ts`
  (no route, no `services` binding to it from another worker)?
- Does the gateway authenticate **every** request before the cache, and is the cached principal
  invalidated when a key is revoked or a role changes (`invalidateCachedPrincipals`)?
- Does the canonical cache URL include everything that changes the response (visibility profile,
  space, environment, sorted query), so a cached response can't leak across profiles?
- Does a purge for a publish reach every tag that response was cached under?

## Keys, scopes, spaces

- New route: which scope does it require, is `requireScope` applied, and is the space the one in
  the route (not one from the body)?
- New MCP tool: the same scope and the same use-case as the HTTP route?
- Can a key for space A read or write space B (`api-key-tenancy.test.ts`)? Can a CDA key reach
  preview or management data?
- Is a revoked or expired key, PAT or OAuth token refused on its next use, including through the
  delivery principal cache?
- Entries: are `authorizeContent`, field masking and writable-field checks applied on every new
  read or write path?

## Human sign-in (apps/web)

- Passwords, passkeys, TOTP, OIDC, SCIM, setup: throttled (`rate-limit.ts`, `throttle.ts`), errors
  that don't reveal whether an account exists, the setup token single-use and only while there
  are no people.
- OIDC fails closed on a misconfiguration (`oidc-fail-closed.test.ts`); SCIM tokens hashed.
- Sessions: idle and absolute limits; the session id never in a URL, a log or the api.
- State-changing routes check origin (`origin.ts`); redirects go only to same-origin paths
  (`next-path.ts`); CSP unchanged or tightened, no new inline script or `unsafe-*`.

## OAuth and MCP

- Is a token granted for one resource refused at another (`OAUTH_RESOURCE`)? Does consent grant
  no more than the approver's own role?
- Are refresh tokens rotated and access-token TTLs unchanged (`OAUTH_ACCESS_TOKEN_TTL_SECONDS`)?
- Does `MCP_TOKEN` stay a deployment secret, never logged or returned?

## Outbound requests and webhooks

- Is every user-configurable URL validated with `assertSafeExternalUrl` before it is stored and
  again before it is fetched? Can a space admin point a webhook or function at the deployment's own
  hosts and have it act with platform authority?
- Are outbound webhooks signed, and is the signing secret sealed at rest?
- Inbound webhooks (video streaming service): signature verified on the raw body before parsing
  (`verifyStreamWebhook`), with a replay tolerance.

## Plugins and functions

- Does a new capability a plugin can request map to a narrow, checked binding
  (`plugin-capabilities.test.ts`)? Can a plugin reach another space's data, the network beyond its
  grant, or a secret?
- Are install sources limited to `PLUGIN_SOURCE_HOSTS` and the minimum release age honoured?

## Secrets and data at rest

- New stored secret: sealed with `createSecretSealer` under the right `secretContext`, readable
  through a `DATA_KEY_PREVIOUS` rotation (`secrets-at-rest.test.ts`)?
- Does anything log, return in a response, or put in an error message a secret, a token, a session
  id or a password hash? Does it pass through `packages/redaction` first?
- New `vars` in `wrangler.jsonc`: no secrets there (secrets come from the GitHub environment via
  `scripts/fleet.ts secrets`).

## Models and untrusted input

- Does new text from content, an import, an uploaded document or a web page reach a prompt only
  through `wrapUntrusted`?
- Is the model's answer validated against the content model before it is saved, and bounded
  before it drives an action (a workflow branch, an agent tool call)?
- Is AI use metered through `CostGuardDO` (`AI_MAX_REQUESTS_PER_WINDOW`, the stricter agent ceiling)?

## Supply chain and CI

- New dependency: needed, maintained, added to the pnpm catalog, and does
  `pnpm audit --prod --audit-level high` stay clean?
- Workflows: actions pinned by full SHA, `permissions` minimal, no secrets in `pull_request` jobs
  from forks, no untrusted input interpolated into `run:` (`${{ github.event.* }}`).
