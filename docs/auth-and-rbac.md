# Authentication & RBAC

contentworker has two kinds of caller and one authorization model:

- **People** sign in to the admin web app (`apps/web`) with a password, a passkey, TOTP two-factor
  or OIDC single sign-on. The web Worker forwards their API calls to the api with a signed
  principal header.
- **Programs** (API clients, SDKs, MCP agents) present a bearer token: an API key, a personal
  access token or an OAuth access token.

Both resolve to a `Principal`, and authorization is enforced in the domain
(`packages/domain/src/auth`) by the same `authorize` function, called by the REST API, MCP and
delivery alike before any use-case runs.

## People: sign-in on the web Worker

The web app keeps its own accounts in D1 (`users`, `sessions`, `passkeys`, `recovery_codes`,
`scim_groups`, `admin_audit`; migration `0002_auth.sql`):

- **Deployment roles** (`@contentworker/security/roles`): `member` signs in and uses the CMS
  within the content permissions the api resolves for them; `admin` also manages people, single
  sign-on, SCIM, setup and the admin audit log, and administers every space.
- **Passwords** are PBKDF2 (`pbkdf2p:` when peppered with `PASSWORD_PEPPER`). **Passkeys** are
  WebAuthn. **TOTP** two-factor has one-time recovery codes. Authenticator secrets are sealed with
  `DATA_KEY`.
- **Single sign-on** uses the deployment's OIDC provider (`OIDC_ISSUER`, `OIDC_CLIENT_ID`,
  `OIDC_CLIENT_SECRET`); admins choose the rest on the Team page. **SCIM** (`/scim/v2`) provisions
  people and groups from the provider with its own bearer token.
- Failed sign-ins are throttled per address and account (`auth_failures`); sign-in paths without
  a session are also rate-limited (`API_LIMIT`). Sign-ins, failures, and changes to people,
  passkeys, two-factor, SSO and SCIM are written to the hash-chained `admin_audit`.
- **SSO-only** (web): admins can require single sign-on; redeeming a setup code turns it off so
  a broken identity provider can't lock everyone out.

## The web principal

For a same-origin browser request with a live session, the web gateway
(`apps/web/app/lib/gateway.server.ts`) removes the cookies and adds `x-cw-principal`
(`@contentworker/security/principal`):

- payload `{ sub, email, name, role, sid?, iat, exp, path }`, base64url, then `.`, then
  base64url(HMAC-SHA256(`PRINCIPAL_KEY`, payload)); `sid` is the session the request came on
  (the SHA-256 its `sessions` row is keyed by), absent in open local development;
- valid for 60 seconds (5 s clock skew) and only for the exact path it was signed for;
- a caller-supplied `x-cw-principal` is always removed, and a request carrying a bearer token
  never gets one; cross-site requests are forwarded without the session.

The api verifies it with `PRINCIPAL_KEY` (then `PRINCIPAL_KEY_PREVIOUS` during a rotation) and
resolves the person with `principalForWebUser` (`packages/application/src/web-principal.ts`):

- in a space, the person's **team membership** gives their role's scopes and content grants,
  resolved live; a disabled member is refused;
- a deployment `admin` who is not on a space's team still administers it with the full CMA
  scope set (someone has to create the first space and add people);
- a route that names no space is open only to deployment admins;
- anyone else gets 403.

The resulting principal has `kind: 'user'` and `subject` = the person's id, so audit attributes
actions to the person.

**The assistant's socket** (`/agents/assistant-agent/<person>`) carries the same header, signed
for that path. The api forwards it to the engine's `AssistantAgent` only when `sub` is the person
the path names, and the object verifies the signature again itself with `PRINCIPAL_KEY`. Because a
socket outlives its 60 seconds, the object keeps who the claims name per connection and, before
every frame the socket sends and every turn and page edit, re-reads the person: refused, and the
socket closed, once they are disabled or their session (`sid`, required for anyone but `local`) is
deleted, expired or idle past their role's limit. Their access to the page's space is resolved
again with `principalForWebUser` each time. `local` (open local development) is let in only while
nobody has an account. The two-factor and password-change "due" states aren't re-read: the
gateway refuses to sign for a person who is due, and a password reset ends their sessions.

An MCP tool that fails with anything REST would answer with a 5xx (a database or binding error)
reports only `Internal server error`; refusals (not found, forbidden, invalid, conflict) keep their
own words, as REST shows them.

## API key kinds

The three key kinds (`ApiKeyKind`):

| Kind  | Name                   | Purpose                                           |
| ----- | ---------------------- | ------------------------------------------------- |
| `cma` | Content Management API | Full authoring, publishing, and space admin       |
| `cda` | Content Delivery API   | Read published content + search                   |
| `cpa` | Content Preview API    | Read draft/current content (+ published + search) |

## Permission scopes

`SCOPES` (`PermissionScope`):

| Scope              | Grants                                                       |
| ------------------ | ------------------------------------------------------------ |
| `content:write`    | Create/update draft entries and assets; AI draft generation  |
| `content:publish`  | Publish/unpublish entries, assets, and content types         |
| `content:manage`   | Define/revise content-type schemas                           |
| `preview:read`     | Read draft/current entries and content-type definitions      |
| `delivery:read`    | Read published entries and assets                            |
| `search:read`      | Semantic search over published content                       |
| `space:admin`      | Manage API keys, create spaces/environments, manage webhooks |
| `workflow:approve` | Decide workflow approvals (the Approver preset)              |

### Default scopes per kind

`scopesForKind(kind)`:

| Kind  | Scopes                                         |
| ----- | ---------------------------------------------- |
| `cma` | **all eight** scopes                           |
| `cda` | `delivery:read`, `search:read`                 |
| `cpa` | `preview:read`, `delivery:read`, `search:read` |

A key may be minted with an explicit scope override; otherwise it receives its kind's defaults.

## Role presets

Every space is seeded with five built-in, ordered roles. They are
ordinary roles: assignable to API keys and to people, resolved live, editable, and cloneable into
custom roles. A preset role carries `preset` and can't be deleted. Each one can do everything the
one before it can:

| Preset     | Name          | Scopes                                         | In words                                                                                      |
| ---------- | ------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `viewer`   | Viewer        | `preview:read`, `delivery:read`, `search:read` | Reads drafts, published content, workflows and approvals; searches                            |
| `approver` | Approver      | viewer + `workflow:approve`                    | Also approves or rejects workflow approvals                                                   |
| `editor`   | Editor        | approver + `content:write`, `content:publish`  | Also writes and publishes content, starts and cancels workflow runs, delivers workflow events |
| `manager`  | Manager       | editor + `content:manage`                      | Also changes content types, workflows, taxonomy, functions, AI actions                        |
| `admin`    | Administrator | manager + `space:admin`                        | Also manages the team, API keys, roles, webhooks, environments, plugins, audit log            |

Each preset grants every content type (`*`): `read` for Viewer and Approver, `read`/`write`/`publish`
for Editor and up (a role-bound key is denied any type its grants don't name). Presets are seeded when a space is created (or on first use where a space was seeded directly,
as the in-memory dev store is). `GET …/role-presets` lists them with the role id each was seeded as;
`POST …/roles/:id/clone` copies any role into a new custom one. Anywhere a role is assigned
(`POST …/members`, `PATCH …/members/:id`, `PUT …/api-keys/:id/role`, the `role_preset_assign` MCP
tool) the role may be given as a role id or a preset name.

### `workflow:approve`

An approval node's **Who may decide** defaults to `workflow:approve` (an approval that names no
scope takes the default). An approval requires exactly the scope it names, checked against the
decider's content grant: `read` for `workflow:approve` (an approver decides what they can see),
`publish` for `content:publish`, `write` for anything else. Approver, Editor, Manager,
Administrator and the default `cma` key scopes all include `workflow:approve`. The rule
is `authorizeApproval` in `domain/auth`, used by `decideWorkflowTask` (HTTP and MCP alike). A person
who approves without `content:write` (the Approver preset) is not handed the run downstream ("starter,
then approver"): the run keeps acting as whoever could write, so its later steps aren't refused.

## Space access (the team)

**People** (`SpaceMember`: email, optional name, linked subject, role, disabled) are a space's
team: the people the web principal resolves against. **Keys** are the long-lived API keys with
their role.

| Endpoint                               |                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /spaces/:space/team`              | People + long-lived keys with roles, `adminCount`, access settings                 |
| `POST /spaces/:space/members`          | Add a person `{ email, name?, role }`                                              |
| `PATCH /spaces/:space/members/:id`     | Change `role`, `name`, `disabled`                                                  |
| `DELETE /spaces/:space/members/:id`    | Remove a person                                                                    |
| `PUT /spaces/:space/api-keys/:id/role` | Rebind a key `{ role }` (`null` unbinds it to its kind's defaults)                 |
| `PUT /spaces/:space/access-settings`   | `{ ssoOnly }`                                                                      |

All need `space:admin`. MCP: `role_presets_list`, `team_list`, `role_preset_assign`. In the admin:
Settings → Access → Space access.

### The last administrator

A space that has an active administrator keeps one. Refused with **409 `last_admin`**: revoking,
demoting, disabling or removing the last one, and removing `space:admin` from a role while it is
all that makes anyone an admin. Administrators are counted as enabled people whose role includes
`space:admin`, plus active keys with no expiry whose effective scopes do (OAuth tokens and other
expiring tokens are not seats; a setup credential counts unless the space is SSO-only). People
always count: the api's access policy is the constant `WEB_SIGN_IN`
(`packages/http/src/api/access-policy.ts`), because every person signs in through the web app and
there is no api-side sign-in to opt into. The bootstrap `ADMIN_TOKEN` never counts. Deployment
admins of the web app administer every space regardless.

### SSO-only (api)

`ssoOnly` stops a setup credential (issuance `setup`) from authenticating in that space. Turning
it on needs an enabled person with the Administrator role on the space's team. Admin sign-in itself
is the web Worker's.

## First-run setup and recovery

**On the web Worker.** While the deployment has no people, every admin page redirects to `/setup`
(on localhost it stays open, for local development). `/setup` takes the one-time setup code
(`SETUP_TOKEN`, generated by `scripts/provision.sh` into `.secrets/<id>/setup-code`) and creates
an **Admin** account with a password (`apps/web/app/lib/setup.server.ts`):

1. the code is compared in constant time; a wrong one is audited (`team.setup_refused`) and
   throttled per address;
2. the code is claimed by recording its SHA-256 in `workspace_settings` before anyone is created,
   so it never works twice and two submissions can't both use it;
3. the account is created and audited (`team.first_admin`, or `team.recovery_admin` when people
   already exist); if creating it fails, the code is given back;
4. web SSO-only is turned off, so the new admin can sign in with the password.

**Recovery**: `./scripts/setup-code.sh <id>` writes a new code to `.secrets/<id>/setup-code`, sets
it on the deployment's GitHub environment and on the web Worker. Redeeming it creates one more
admin account even though others exist.

The web app's `/setup` is the only first-run setup. The api has no setup gate and no setup routes
of its own: it serves every route from the start, and a new deployment's first admin creates the
first space and adds people from the admin, through the web principal.

## Ending a person's access

Disabling a person, resetting their password, resetting their two-factor sign-in and SCIM
deactivating them each end what was made under the old trust, through `endAccess`
(`apps/web/app/lib/access.server.ts`): their web sessions, their passkeys where the device may be in
someone else's hands (password and two-factor resets), and their api tokens. For the tokens the web
Worker calls the api's `DELETE /deployment/people/:subject/credentials`, signing the principal as
itself acting for the deployment (a deployment admin, so a wildcard principal; anyone else gets
403). The route runs `revokeEverythingFor` (`packages/application/src/oauth.ts`), which revokes, in
every space, the OAuth access tokens and grants, personal access tokens and setup credentials whose
subject is the person's web user id, and answers `{ revokedTokens, revokedGrants }`. A space's own
API keys are not a person's and are untouched. If the api refuses, the action fails visibly and can
be repeated; both halves are idempotent. The counts go into the admin audit entry's detail.

## Custom roles (granular RBAC)

A **role** is a named, space-scoped permission set assignable to API keys — the layer below
coarse scopes. It carries a scope set plus per-content-type grants:

```ts
interface Role {
  id: string;
  spaceId: string;
  name: string;
  description?: string;
  scopes: readonly string[]; // same vocabulary as SCOPES
  contentGrants: readonly ContentTypeGrant[];
  preset?: RolePreset; // set on the built-in presets (see Role presets)
}

interface ContentTypeGrant {
  contentTypeApiId: string; // exact apiId, or '*' for all types
  actions: readonly ('read' | 'write' | 'publish')[];
  deniedFields?: readonly string[]; // masked on read, rejected on write
  readOnlyFields?: readonly string[]; // readable, rejected on write
}
```

Semantics:

- **Roles are live**: a role-bound key resolves the role's scopes and grants on **every**
  request (`authenticate`), so editing a role instantly changes what every bound key can do.
  Deleting a role is refused while active keys reference it; a dangling reference fails closed.
- **Exact grant wins over `'*'`**; a type with no matching grant is denied entirely.
- **Enforcement points** (identical for HTTP and MCP): entry create/update check
  `authorizeContent(principal, 'write', ct)` + `assertWritableFields`; publish/unpublish check
  the `publish` action; management/preview/delivery reads filter out ungranted types and
  `maskDeniedFields` on what remains. Keys without a role (`contentGrants === undefined`) are
  unrestricted at this layer — coarse scopes alone apply, preserving pre-role behavior.
- Managed at `GET/POST /spaces/:space/roles`, `GET/PUT/DELETE /spaces/:space/roles/:id`
  (requires `space:admin`) and the `roles_list` / `role_create` / `role_update` /
  `role_delete` MCP tools. Mint a bound key with `POST …/api-keys { kind, roleId }`. Deleting is
  refused while a key or a person holds the role, and for a preset.

Grants govern entry read/write/publish and content-type visibility. **Delivery and Preview**
list/get endpoints filter ungranted content types and `maskDeniedFields` on responses. Coarse
scopes still gate search, GraphQL, SSE, and assets at the route level.

## API keys at rest

```ts
interface ApiKey {
  id: string;
  spaceId: string;
  kind: ApiKeyKind;
  name: string;
  hashedToken: string; // SHA-256 of the raw token — the raw token is NEVER stored
  scopes: readonly string[]; // display snapshot; role-bound keys resolve live from the role
  revoked: boolean;
  roleId?: string; // custom role binding (granular RBAC)
  expiresAt?: string; // after this instant the key stops authenticating
  issuance?: 'key' | 'oauth' | 'pat' | 'setup'; // how the token came into existence
  subject?: string; // the human it acts for (OAuth grant / PAT owner)
  clientId?: string; // the OAuth client that obtained it
}
```

The raw token is returned exactly once, at creation (`POST …/api-keys`). Authentication hashes
the presented bearer token and looks it up by hash (`AuthRepo.findByHash`).

### One token model, three issuances

There is exactly one credential type and one authentication path. An OAuth access token and a
personal access token are both `ApiKey` rows — so expiry, revocation, live role resolution and
last-used tracking apply to all three without a second code path. Only the provenance differs:

| `issuance` | Prefix            | Minted by                                                    | Lifetime                              |
| ---------- | ----------------- | ------------------------------------------------------------ | ------------------------------------- |
| `setup`    | `cwsetup_<kind>_` | The api's former setup route (removed; existing ones still authenticate) | Unbounded; stops while SSO-only is on |
| `key`      | `cwk_<kind>_`     | An operator, via `POST …/api-keys`                           | Unbounded unless `expiresAt` is set   |
| `oauth`    | `cwo_<kind>_`     | An OAuth grant a human approved                              | `OAUTH_ACCESS_TOKEN_TTL_SECONDS`      |
| `pat`      | `cwpat_<kind>_`   | A human, via `POST …/personal-access-tokens`                 | Unbounded, or `expiresInDays`         |

**Delegated tokens (`oauth`/`pat`) treat their scopes as a ceiling.** A role-bound operator key
resolves the live role in both directions, as it always has. For a delegated token the effective
scopes are `role.scopes ∩ token.scopes`: widening the role later must not retroactively widen a
token a human approved for less, while narrowing the role still takes effect immediately. Content
grants continue to resolve live in every case — only the coarse scopes are capped.

A delegated token also cannot mint a longer-lived one: `POST …/personal-access-tokens` refuses any
caller carrying a `clientId` (i.e. an OAuth-issued token), so a credential that expires in an hour
cannot promote itself into one that never does. That route is deliberately **not** exposed as an
MCP tool for the same reason.

## Secrets at rest

Credentials the platform must _use_ (not merely verify) cannot be hashed, so they are encrypted
instead. Hashing stays the rule wherever a value is only compared: API keys, preview tokens,
OAuth client secrets, and OAuth codes/refresh tokens are stored as hashes and are **not** encrypted.

| Column             | Sealed value                                | Context (AAD)                                 |
| ------------------ | ------------------------------------------- | --------------------------------------------- |
| `webhooks.secret`  | The HMAC signing secret                     | `webhooks.secret:<webhook id>`                |
| `webhooks.headers` | Each header **value** (names stay readable) | `webhooks.headers:<webhook id>:<header name>` |

- **Format.** AES-256-GCM under a key derived with HKDF-SHA-256 from `DATA_KEY`. A sealed value
  reads `e1.<kid>.<iv>.<ciphertext>` (base64url parts); `kid` is an HMAC-derived id of the key that
  sealed it. The context is bound as GCM associated data, so a ciphertext copied into another row
  or column fails to decrypt rather than leaking.
- **Transparent.** `withSealedSecrets` (`@contentworker/application`) decorates the `ContentStore`
  at the composition root: repos seal on write and open on read, so use-cases, MCP tools and the
  webhook dispatcher see plaintext and the store adapters persist opaque strings. The crypto is
  WebCrypto only (`createSecretSealer`, implementing the `SecretSealer` port).
- **Unreadable values** (not in the sealed format, sealed under a key the deployment no longer
  holds, or altered) raise
  `SecretUnreadableError` (HTTP 500, naming only where the value lives) — never "not set".
- **Daily reseal.** On the 03:30 UTC cron tick, `resealSecrets` reseals every value not sealed
  under the current key (i.e. under `DATA_KEY_PREVIOUS` after a rotation) with a
  compare-and-set (a secret changed between the sweep's read and write is left alone) and at most
  500 values per run. It logs `secrets resealed` with `examined`, `resealed`, `skipped`,
  `unreadable`, and `complete`.
- **Boot guard.** A persistent deployment refuses to start without `DATA_KEY` (≥ 32 characters,
  not the dev key) unless `REQUIRE_SECURE_SECRETS=false`, in which case the fixed local dev key is
  used. The in-memory store gets a key generated per isolate.

**Rotating `DATA_KEY`:** set `DATA_KEY_PREVIOUS` to the current key and `DATA_KEY` to a new one
(`openssl rand -base64 32`) in the deployment's GitHub environment (every Worker receives both on the next deploy), wait for a reseal run that logs `complete: true` and `unreadable: 0`, then remove
`DATA_KEY_PREVIOUS`. Losing `DATA_KEY` makes stored webhook secrets unrecoverable: re-enter them.

## Principals

```ts
interface Principal {
  spaceId: string; // a specific space, or '*' for admin/root
  kind: ApiKeyKind | 'admin' | 'user';
  scopes: readonly string[];
  contentGrants?: readonly ContentTypeGrant[]; // from the key's role; undefined = unrestricted
  subject?: string; // the person's web user id when kind is `user`
  sessionId?: string; // session id for revocation when kind is `user`
  clientId?: string; // the OAuth client acting for the subject
}
```

- `authenticate(ctx, hasher, token)` resolves a bearer token to a `Principal`, throwing
  `UnauthorizedError` on miss.
- The **admin token** (`ADMIN_TOKEN` / `MCP_TOKEN`) short-circuits to a wildcard principal
  (`spaceId: '*'`, all CMA scopes). Use it only for provisioning/bootstrap.
- **The web principal** (`x-cw-principal`) resolves to `kind: 'user'`; see
  [The web principal](#the-web-principal).
- **`GET /auth/me`** returns the resolved principal summary.
- **Preview links** — `POST …/entries/:id/preview-link` mints an expiring token; CPA
  `GET …/entries/:id?preview_token=…` accepts it without a bearer header.
- **OAuth 2.1** — when `OAUTH_ISSUER` is set, MCP clients obtain tokens through
  `/oauth/*` instead of being handed a static key (see below).

## OAuth 2.1 for MCP clients

Setting `OAUTH_ISSUER` makes the management API an OAuth 2.1 authorization server, so an MCP
client (Claude, ChatGPT, an IDE) can be installed as a connector. The endpoint list and env vars
are in [Configuration](./configuration.md); the implementation is `packages/http/src/api/oauth`.

OAuth is served on the admin's origin. `scripts/fleet.ts` renders `OAUTH_ISSUER=https://<domain>`
(the admin host, not `api.<domain>`), and the web gateway forwards `/oauth/*`,
`/.well-known/oauth-*` and `/mcp` to the api, so the protected resource is `https://<domain>/mcp`.
`api.<domain>/mcp` still serves callers that present a bearer token.

Consent is approved through web sign-in:

- `/oauth/authorize` and `/oauth/device` verify the signed `x-cw-principal` the gateway adds for a
  signed-in person. Signed out, they redirect to `/login?next=<the request>`, which brings the
  person back to the same request after signing in.
- The consent screen offers a space picker over the spaces the person can act in
  (`spacesForWebUser`, `packages/application/src/web-principal.ts`); someone on no team gets 403.
- The grant binds the person's team role in the chosen space (`memberAccess`): the token's
  permissions resolve live from that role on every use, capped by the scopes consented to, and it
  stops working when the person is disabled or leaves the team. Only team members can approve: a
  deployment admin who isn't on a space's team can administer it but can't connect applications
  to it (the picker lists only spaces where the person is a member).

What the implementation guarantees:

- **PKCE is mandatory and `S256`-only.** `plain` is rejected, and an authorization request with no
  `code_challenge` is refused outright.
- **Redirect URIs match exactly.** No prefix or wildcard matching. The sole exception is RFC 8252
  loopback: for `http://127.0.0.1|localhost` the _port_ is ignored, because a native client binds
  an ephemeral port it cannot know at registration time. Scheme, host, path and query still match.
- **Validation precedes redirection.** Anything wrong with `client_id` or `redirect_uri` renders an
  error page; it is never redirected back to the client, which would make `/oauth/authorize` an
  open redirect.
- **Registration is open but bounded.** Dynamic client registration (RFC 7591) is unauthenticated
  by necessity, so a registering client can never ask for `space:admin` or `content:manage` — it
  must not be able to put "administer this space" in front of a human as one approve button. A
  registered client holds no authority at all until a human approves a grant. A client that
  registers without a `scope` (as MCP clients commonly do, choosing scopes when they authorize) may
  later ask for anything under that ceiling (read, write, publish); the person approving still
  sees every scope, and the token never exceeds their role.
- **The consent form keeps its Origin.** The api sends `Referrer-Policy: same-origin`, not
  `no-referrer`: under `no-referrer` a browser posts the form with `Origin: null`, which the web
  gateway treats as cross-site and forwards without the session, so approval would fail.
  `same-origin` still sends no Referer to another origin, so the redirect never leaks its code.
- **A grant is intersected with the approver.** Granted scopes are `requested ∩ approver's own`. If
  the human holds none of them the approval is refused rather than issuing an empty token.
- **Codes are single-use, and replay is treated as compromise.** Redeeming an already-consumed
  authorization code — or reusing a rotated refresh token — revokes the whole family: every
  descendant refresh token and every access token they minted. We cannot tell which party is the
  attacker, so both lose access.
- **Refresh tokens rotate** on every use and may narrow scope but never widen it.
- **The consent form is bound to the person** who was shown it, by an HMAC over their subject
  and the exact parameters shown, keyed from `PRINCIPAL_KEY` (with a domain label, so a consent
  signature can never pass for a principal envelope). Tampering with the scope field between
  render and submit is rejected.
- **Resource indicators (RFC 8707)** are validated whenever present: a token minted for this
  deployment cannot be aimed at another.

Unauthenticated MCP requests answer with `WWW-Authenticate: Bearer resource_metadata="…"`
(RFC 9728), so a client discovers where to authenticate instead of failing on an opaque 401. The
Worker serves `/.well-known/oauth-protected-resource` alongside `POST /mcp`.

## The authorization decision

```ts
inScope(principal, targetSpaceId): boolean
  // true if principal.spaceId === '*'  OR  principal.spaceId === targetSpaceId

authorize(principal, scope, targetSpaceId): void
  // throws ForbiddenError unless inScope(...) AND principal.scopes.includes(scope)
```

`authorize` is the single decision point. In the API, `requireScope(scope)` middleware extracts
the route's `:space` and calls it; in the MCP server (`POST /mcp`), each tool calls it before delegating to a
use-case. A failure surfaces as **403** (`forbidden`); an unauthenticated request as **401**
(`unauthorized`).

## Scope → operation map

| Scope              | Use-cases / endpoints (representative)                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `content:write`    | Entry/asset CRUD, AI generation endpoints, bulk writes, comments/tasks, metadata                       |
| `content:publish`  | Publish/unpublish entries, assets, content types, releases; scheduled actions                          |
| `content:manage`   | Content types, workflows, taxonomy, functions, app-extensions, ai-actions, merge                       |
| `preview:read`     | Preview entries, content types, releases, workflows, collaboration reads                               |
| `delivery:read`    | Published entries/assets, Live Content SSE, GraphQL                                                    |
| `search:read`      | Hybrid/semantic search, related/duplicates/embedding                                                   |
| `space:admin`      | Spaces, environments, aliases, API keys, roles, team, access settings, webhooks, audit log, agent runs |
| `workflow:approve` | Deciding workflow approvals whose node asks for it (the default)                                       |

`GET /spaces` returns all spaces for an admin principal (`spaceId: '*'`) or only the key's own
space for scoped keys.

## Dev credentials

In in-memory mode the store is seeded with keys whose raw tokens are the `CMA_KEY` / `CDA_KEY` /
`CPA_KEY` config values (defaults `dev-cma-key`, `dev-cda-key`, `dev-cpa-key`) and the
`ADMIN_TOKEN` (default `dev-admin-token`). These are seeded **through the real auth path** (hashed
and stored), so dev and production behave identically. On D1, the demo seed (`SEED_DEV=true`)
writes the same dev keys; `pnpm dev` sets `ADMIN_TOKEN=dev-admin-token` and
`MCP_TOKEN=dev-mcp-token` (`LOCAL_STACK_VARS`). The MCP endpoint additionally accepts
`dev-mcp-token` when no `MCP_TOKEN` is set, but only in in-memory demo mode; a persistent
deployment requires an explicit `MCP_TOKEN` before `/mcp` mounts. Replace all of these in any real
deployment (`REQUIRE_SECURE_SECRETS=true` refuses to serve with the dev-default admin token and
keys).
