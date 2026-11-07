---
name: security-model
description: ContentWorker's trust boundaries and what to check at each, for security review of a diff or a design. Covers the signed x-cw-principal header from the web Worker to the api, the delivery gateway and its unroutable Delivery entrypoint, API keys and scopes per space, the admin and MCP tokens, OAuth for MCP, human sign-in (passwords, passkeys, TOTP, OIDC, SCIM, setup), preview tokens and signed media URLs, outbound webhooks and fetches, plugins on Worker Loader, secrets at rest under DATA_KEY, untrusted content in model prompts, and CI's supply chain. Preloaded by the security-reviewer agent; use it directly when a change touches auth, roles, scopes, signing, secrets, webhooks, external fetches, plugins or model prompts.
---

# ContentWorker security model

ContentWorker is one dedicated deployment per customer (no sharing across customers), so the
boundaries that matter are _inside_ a deployment: the public internet → the Workers, between the
web Worker and the api, between spaces and environments, between API keys of different kinds and
scopes, and between the platform and the code it runs for a customer (plugins, functions, models).
Read [references/checklist.md](references/checklist.md) for the per-boundary checks; this page is
the map.

## The boundaries

```
browser          API client / SDK / MCP client / OAuth client          Delivery client
   │  session cookie       │  Authorization: Bearer (API key, PAT, OAuth, admin/MCP token)   │ CDA key
   ▼                       ▼                                                                  ▼
apps/web (public) ─── API service binding ──► apps/api (public)                  apps/delivery (public)
  strips caller x-cw-principal;               believes x-cw-principal only        gateway: auth every request
  session → signed x-cw-principal             if HMAC(PRINCIPAL_KEY), path-bound,   (KV-cached principal)
  (60 s, path-bound); bearer passes as is     < 60 s old; else authenticates bearer      │ x-cw-delivery-principal
                                                    │                             Delivery entrypoint (cached,
                                                    ▼                             never routable, D1 replicas)
                                     apps/engine (no route; DOs, Workflows, queues, cron)
                                       │  webhooks out, functions, plugins (Worker Loader),
                                       ▼  Workers AI via AI Gateway, Email, Stream, Images
                                     outside world
```

## The rules a change must keep

1. **The api trusts a forwarded person only through a valid signature.** `x-cw-principal` is
   believed only when signed with `PRINCIPAL_KEY` (or `PRINCIPAL_KEY_PREVIOUS` during a rotation),
   naming the exact path, under 60 s old (`packages/security/src/principal.ts`; signed by
   `apps/web/app/lib/gateway.server.ts` + `principal.server.ts`; verified in
   `packages/http/src/api/auth.ts`). The gateway always removes a caller-sent copy; a bearer
   request never carries one; cookies never cross the binding.
2. **The `Delivery` entrypoint is unreachable from outside.** It trusts `x-cw-delivery-principal`
   only because the gateway in the same Worker is its only caller (`apps/delivery/src/delivery.ts`).
   Never add a route, a service binding from another Worker, or a trusted header to a publicly
   routed handler. Its cache key is the canonical URL built from the visibility profile, so one
   caller's view can't be served to another with less access.
3. **Scopes are checked against the route's space.** `requireScope` → `authorize(principal, scope,
   space)` (`packages/domain/src/auth/auth.ts`). Key kinds (CMA, CDA, CPA) get their default scopes
   from `scopesForKind`; the admin token is the only wildcard principal; content-level rules
   (`authorizeContent`, field masking) apply to entries. MCP tools go through the same checks.
4. **Credentials are stored as hashes or sealed.** API keys and tokens are hashed with
   `TOKEN_PEPPER` (`createHasher`, `packages/application/src/token-crypto.ts`) and compared in
   constant time (`secureTokenEqual`); passwords are PBKDF2 (`PASSWORD_PEPPER`). Secrets the
   platform must use later (webhook secrets, plugin and OIDC credentials) are sealed with
   `DATA_KEY` (`createSecretSealer`, `secretContext`, `packages/application/src/secret-sealer.ts`),
   bound to their row, readable through a rotation. `assertSecureSecrets` refuses dev defaults
   when `REQUIRE_SECURE_SECRETS` is on.
5. **Outbound URLs are safe.** Every user-configurable destination passes `assertSafeExternalUrl`
   (`packages/application/src/url-safety.ts`); the engine and api run with
   `global_fetch_strictly_public` as a backstop. Outbound webhooks are signed
   (`packages/adapters/src/http-effects/webhook-sender.ts`).
6. **Customer code is sandboxed.** Plugins run on Worker Loader isolates with only the
   capabilities their manifest grants (`packages/adapters/src/plugins-cf-loader`,
   `packages/domain/src/plugin/`); `PLUGIN_SOURCE_HOSTS` and `PLUGIN_MIN_RELEASE_AGE_HOURS` gate
   what may be installed.
7. **Untrusted text reaches a model only as data.** Content, imports and documents go into a
   prompt through `wrapUntrusted` / `UNTRUSTED_CONTENT_GUARD` (`packages/application/src/ai-prompt.ts`);
   a model's output is validated like a human edit before it changes anything; AI spend is capped
   by `CostGuardDO`.
8. **Nothing secret is logged.** `packages/redaction` (`redactCredentials`, `redactBearerTokens`,
   `redactApiTokens`) runs on anything that may carry a credential before it reaches a log,
   an audit row or an error.
9. **The admin is hardened.** CSP (`apps/web/app/lib/csp.ts`), same-origin checks for state
   changes (`origin.ts`), same-origin redirects only (`next-path.ts`), sign-in throttling
   (`rate-limit.ts`, `throttle.ts`, `RateLimiterDO`), step-up for sensitive actions.

## How to review

1. Classify each changed file by boundary (the rules map's trust-boundary row lists the files).
2. For each, run the matching checks in [references/checklist.md](references/checklist.md).
3. Report only what you can tie to a line and a concrete attacker: who they are (anonymous, a CDA
   key holder, a member of another space, a signed-in member, a malicious plugin author, a document
   sender), what they send, and what they get. A finding that needs `PRINCIPAL_KEY`, `DATA_KEY` or
   Cloudflare account access is not a finding.
4. Name the test that would have caught it (`packages/http/test/api/web-principal.test.ts`,
   `api-key-tenancy.test.ts`, `oidc-fail-closed.test.ts`, `plugin-capabilities.test.ts`,
   `apps/web/tests/{principal,gateway,csp,origin,sessions}.test.ts`,
   `packages/db/test/secrets-at-rest.test.ts`) and whether it exists.

Vulnerabilities in a deployed service are reported privately (SECURITY.md); a review finding in a
PR never includes a working exploit against a live deployment.
