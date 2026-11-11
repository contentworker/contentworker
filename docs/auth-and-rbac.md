# Authentication & RBAC

ContentWorker has two kinds of caller and one authorization model:

- **People** sign in to the admin web app (`apps/web`) with a password, a passkey, TOTP two-factor
  or OIDC single sign-on. The web worker forwards their API calls to the api with a signed
  principal header.
- **Programs** (API clients, SDKs, MCP agents) present a bearer token: an API key, a personal
  access token or an OAuth access token.

Both resolve to a `Principal`, and authorization is enforced in the domain
(`packages/domain/src/auth`) by the same `authorize` function, called by the REST API, MCP and
delivery alike before any use-case runs.

## People: sign-in on the web worker

The web app keeps its own accounts in the database (`users`, `sessions`, `passkeys`,
`recovery_codes`, `scim_groups`, `admin_audit`; migration `0002_auth.sql`; `password_resets`,
`0021_password_resets.sql`):

- **Deployment roles** (`@contentworker/security/roles`): `member` signs in and uses the CMS
  within the content permissions the api resolves for them; `admin` also manages people, single
  sign-on, SCIM, setup and the admin audit log, and administers every space.
- **Passwords** are PBKDF2 (`pbkdf2p:` when peppered with `PASSWORD_PEPPER`). **Passkeys** are
  WebAuthn. **TOTP** two-factor has one-time recovery codes. Authenticator secrets are sealed with
  `DATA_KEY`. Someone whose role must use it (admins, by default) is held on the two-factor step,
  `/setup/two-factor`, until it is on: `requireUser` sends every page and its `.data` there
  (`heldAt`), the gateway refuses to sign for them, and signing out is the only other way off. A
  temporary password is held on Account first, which has the form for it.
- **Forgotten passwords** are reset by an emailed code at `/login/forgot` when the deployment
  sends email (see [Password reset](#password-reset)); otherwise an admin resets them on the Team
  page.
- **Invitations** let an admin invite an email with a role and space roles; the person accepts at
  `/invite/:token` with a password or single sign-on (see [Invitations](#invitations)).
- **Single sign-on** uses the deployment's OIDC provider (`OIDC_ISSUER`, `OIDC_CLIENT_ID`,
  `OIDC_CLIENT_SECRET`); admins choose the rest on the Team page. **SCIM** (`/scim/v2`) provisions
  people and groups from the provider with its own bearer token.
- Failed sign-ins are throttled per address and account (`auth_failures`); sign-in paths without
  a session are also rate-limited (`API_LIMIT`). Sign-ins, failures, and changes to people,
  passkeys, two-factor, SSO and SCIM are written to the hash-chained `admin_audit`.
- **Sessions** end 30 days after sign-in whatever happens (`SESSION_MAX_MS`), and after 7 days
  without a request (`SESSION_IDLE_MS`), or 12 hours for a deployment `admin`
  (`SESSION_IDLE_ADMIN_MS`); all in `packages/security/src/roles.ts`.
- **SSO-only** (web): admins can require single sign-on; redeeming a setup code turns it off so
  a broken identity provider can't lock everyone out.

## The web principal

For a same-origin browser request with a live session, the web gateway
(`apps/web/app/lib/gateway.server.ts`) removes the cookies and adds `x-cw-principal`
(`@contentworker/security/principal`):

- payload `{ sub, email, name, role, sid?, iat, exp, path }`, base64url, then `.`, then
  base64url(HMAC-SHA256(`PRINCIPAL_KEY`, payload)); `sid` is the session the request came on
  (the SHA-256 its `sessions` row is keyed by), absent in open local development;
- valid for 60 seconds (5 s clock skew) and only for the exact method and path it was signed for
  (`principalTarget`: `DELETE /spaces/s1/x` is not `GET /spaces/s1/x`);
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

## The assistant's socket

The admin's assistant (see [Architecture](./architecture.md#appsengine-async-and-stateful-work))
is reached at `/agents/assistant-agent/<person>`. The socket carries the same header, signed
for that path with the assistant's own key: HKDF-SHA256 of `PRINCIPAL_KEY`
(`@contentworker/security/assistant-key`), never `PRINCIPAL_KEY` itself. The api forwards it to the
engine's `AssistantAgent` only when `sub` is the person the path names
(`@contentworker/http/assistant/gate`, which also drops any SDK-internal `x-agents-*` or
`x-partykit-*` header a caller sent), and the object verifies the signature again itself with
`ASSISTANT_PRINCIPAL_KEY` (the engine holds no other). A principal signed with the derived key
never verifies on the api's REST surface, and one signed with the main key never opens the socket
([Deployment](./deployment.md#the-assistants-principal-key)).

Because a socket outlives its 60 seconds, the object keeps who the claims name per connection and,
before every frame the socket sends and every turn and page edit, re-reads the person: refused, and
the socket closed (code 4401), once they are disabled or their session (`sid`, required for anyone
but `local`) is deleted, expired or idle past their role's limit. Every other open socket of that
person is checked the same way before anything is broadcast. Their access to the page's space is
resolved again with `principalForWebUser` each time. `local` (open local development) is let in only
while nobody has an account. The two-factor and password-change "due" states aren't re-read: the
gateway refuses to sign for a person who is due, and a password reset ends their sessions.

What a client sends is held to what the object made:

- only new user text is taken from the messages a client saves (stored messages are kept as
  stored, client tool results are dropped);
- a model tool call runs only if the model emitted it, with the input and scope it emitted
  (`model:` records);
- a page's action (`act`) waits at a card that `resolve` answers, held to a fingerprint of what the
  card was made for;
- writes the model proposes wait for the person's confirm;
- tool results reach the model inside the untrusted-content delimiter, and only summaries of them
  are kept once a turn ends.

A person gets at most 30 page edits and turns a minute (`ASSISTANT_RATE`); a conversation untouched
for 30 days is deleted by an alarm (`RETENTION_MS`), and so is a person's whose account is disabled
or gone.

## API key kinds

The three key kinds (`ApiKeyKind`):

| Kind  | Name                   | Purpose                                           |
| ----- | ---------------------- | ------------------------------------------------- |
| `cma` | Content Management API | Full authoring, publishing, and space admin       |
| `cda` | Content Delivery API   | Read published content + search                   |
| `cpa` | Content Preview API    | Read draft/current content (+ published + search) |

## Permission scopes

`SCOPES` (`PermissionScope`):

| Scope              | Grants                                                                          |
| ------------------ | ------------------------------------------------------------------------------- |
| `content:write`    | Create/update draft entries; AI draft generation (+ `assets:write`)             |
| `content:publish`  | Publish/unpublish entries, assets, and content types                            |
| `content:manage`   | Define/revise content-type schemas                                              |
| `preview:read`     | Read draft/current entries and content-type definitions (+ `assets:read`)       |
| `assets:read`      | Read assets, drafts included: files, metadata, folders, collections, renditions |
| `assets:write`     | Upload, replace, edit, organize and restore assets                              |
| `delivery:read`    | Read published entries and assets                                               |
| `search:read`      | Semantic search over published content                                          |
| `space:admin`      | Manage API keys, create spaces/environments, manage webhooks                    |
| `workflow:approve` | Decide workflow approvals (the Approver preset)                                 |

### Default scopes per kind

`scopesForKind(kind)`:

| Kind  | Scopes                                         |
| ----- | ---------------------------------------------- |
| `cma` | **all ten** scopes                             |
| `cda` | `delivery:read`, `search:read`                 |
| `cpa` | `preview:read`, `delivery:read`, `search:read` |

A key may be minted with an explicit scope override; otherwise it receives its kind's defaults.
A `cpa` key's defaults carry no asset scope of their own: it reads assets through `preview:read`
(below).

### Implied scopes

`IMPLIED_SCOPES` (`domain/auth`) lets a broader scope stand for an asset scope: `preview:read`
implies `assets:read`, and `content:write` implies `assets:write`. One direction only:
`assets:read` does not read entry drafts and `assets:write` does not write entries, so a key, role
or token can be granted asset access alone. `holdsScope(scopes, scope)` resolves it at the decision
point (`authorize`), never written back: no stored key, role or token changed, and what could
reach assets before still can. `intersectScopes` applies it when a delegated token (OAuth, PAT) is
capped by a role: consent to `preview:read` capped by a role granting only `assets:read` leaves
`assets:read`. An OAuth grant holding only `assets:write` mints a `cma`-kind token; only
`assets:read`, a `cpa`-kind one.

Asset operations by scope. `assets:read`: every asset read, drafts included (library list and
search, files, metadata, folders, collections, renditions, usage, versions, transform URLs,
zips). `assets:write`: create, upload, replace, edit, organize and restore assets, folders and
collections, alt text and auto-tagging, video. `content:publish`: publishing, unpublishing,
archiving and deleting assets, rights, and share links. `content:manage`: rendition
_definitions_. `delivery:read`: published asset reads through Delivery.

## Role presets

Every space is seeded with five built-in, ordered roles. They are
ordinary roles: assignable to API keys and to people, resolved live, editable, and cloneable into
custom roles. A preset role carries `preset` and can't be deleted. Each one can do everything the
one before it can:

| Preset     | Name          | Scopes                                                        | In words                                                                                      |
| ---------- | ------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `viewer`   | Viewer        | `preview:read`, `assets:read`, `delivery:read`, `search:read` | Reads drafts, published content, workflows and approvals; searches                            |
| `approver` | Approver      | viewer + `workflow:approve`                                   | Also approves or rejects workflow approvals                                                   |
| `editor`   | Editor        | approver + `content:write`, `assets:write`, `content:publish` | Also writes and publishes content, starts and cancels workflow runs, delivers workflow events |
| `manager`  | Manager       | editor + `content:manage`                                     | Also changes content types, workflows, taxonomy, functions, AI actions                        |
| `admin`    | Administrator | manager + `space:admin`                                       | Also manages the team, API keys, roles, webhooks, environments, plugins, audit log            |

Each preset grants every content type (`*`): `read` for Viewer and Approver, `read`/`write`/`publish`
for Editor, and `read`/`write`/`publish`/`lock` for Manager and Administrator (a role-bound key is
denied any type its grants don't name). `0038_entry_block_locks` gave the Manager and Administrator
roles already seeded `lock` on their `*` grant where it writes; custom roles, and grants on one
named type, gained nothing. Presets are seeded when a space is created (or on first use where a space was seeded directly,
as the in-memory dev store is). `GET /spaces/:space/role-presets` lists them with the role id each was seeded as;
`POST /spaces/:space/roles/:id/clone` copies any role into a new custom one. Anywhere a role is assigned
(`POST /spaces/:space/members`, `PATCH /spaces/:space/members/:id`,
`PUT /spaces/:space/api-keys/:id/role`, the `role_preset_assign` MCP
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

| Endpoint                               |                                                                    |
| -------------------------------------- | ------------------------------------------------------------------ |
| `GET /spaces/:space/team`              | People + long-lived keys with roles, `adminCount`, access settings |
| `POST /spaces/:space/members`          | Add a person `{ email, name?, role }`                              |
| `PATCH /spaces/:space/members/:id`     | Change `role`, `name`, `disabled`; optional `expectedVersion`      |
| `DELETE /spaces/:space/members/:id`    | Remove a person                                                    |
| `PUT /spaces/:space/api-keys/:id/role` | Rebind a key `{ role }` (`null` unbinds it to its kind's defaults) |
| `PUT /spaces/:space/access-settings`   | `{ ssoOnly }`                                                      |

All need `space:admin`. MCP: `role_presets_list`, `team_list`, `role_preset_assign`, and
`api_key_update` for `PUT …/api-keys/:id/role`. In the admin:
Settings → Access → Space access.

### A person's version

Every person carries a `version` (1 when added, one more at each save; `0042_member_versions`),
answered by `POST …/members`, `PATCH …/members/:id` and `GET …/team`. The store writes a person
only while the row is at the version the change read: version 1 inserts (refused when the id or
the email is taken), a later one only ever updates the row at the version before it, and a
removal deletes only the version it read. The update path never inserts, so a change that read
someone before they were removed can't bring them back, and one that read them before an admin
turned their access off or changed their role can't write the old state back.

- **`PATCH …/members/:id`** changes only the fields it names. Without `expectedVersion`, a change
  that loses the race reads the person again and makes the same change over what is stored then,
  every check running again (up to three times, then `409 conflict`); a person removed meanwhile
  is a `404`. With `expectedVersion`, a stored version other than the one given is `409 conflict`
  with `details: { version }` (the version in force) and nothing written. The delegated-bearer
  refusals (a role change, re-enabling someone) and the last-admin check run first, against the
  person as stored now, so a stale change is refused only when it would otherwise be allowed.
- **`role_preset_assign`** with `memberId` takes the same optional `expectedVersion` (refused with
  a `keyId`: a key has no version).
- **Removing** a person rides the version the last-admin check read; a change landing in between
  is read and checked again.
- **An SSO first sign-in** links the provider's subject to the person at their version. A lost
  race reads the team again and decides afresh, so the sign-in goes on with the person as they are
  now: refused if their access was turned off, not on the team if they were removed, and no match
  if another subject linked the row first. Three lost races in a row refuse that sign-in (`403`,
  nothing linked); the next one goes through.

The admin's Team page sends single values (a role, on or off, remove) that are right over any
version, so it sends no `expectedVersion` and never sees the `409`.

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
is the web worker's.

## First-run setup and recovery

**On the web worker.** While the deployment has no people, every admin page redirects to `/setup`
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

A first admin then goes `/setup/two-factor` (when their role must use two-factor sign-in, held
there until it is on), then `/setup/space` (`/` sends a deployment admin there while there is no
space); a recovery admin lands on `/team`. On the space step Coworker proposes the first space and
creates it once they confirm its card, or they fill in the New space form, or skip to the admin.
`pnpm dev:first-run` walks the same path locally (see [Development](./development.md)).

**Recovery**: `./scripts/setup-code.sh <id>` writes a new code to `.secrets/<id>/setup-code`, sets
it on the deployment's GitHub environment and on the web worker. Redeeming it creates one more
admin account even though others exist.

The web app's `/setup` is the only first-run setup. The api has no setup gate and no setup routes
of its own: it serves every route from the start, and a new deployment's first admin creates the
first space (empty, or with the sample starter) from setup's second step, the CMS's no-spaces
notice or Coworker's setup scope (below), and adds people
from the admin, through the web principal. `POST /spaces` takes `space:admin` across the
deployment (`authorize(…, '*')`), which only a deployment-wide principal holds: the root tokens and
a deployment admin signed in to the admin. A space's own keys and tokens, and a member (who gets a
principal with no space and no scopes on a route that names none), are refused; the `space_create`
MCP tool makes the same check. Coworker reaches it only in its setup scope (`SETUP_SCOPE`, space and
environment `*`): only a deployment admin's turn runs there, as their deployment-wide principal,
offered `space_starters_list` and `space_create` alone, and `space_create` waits for their
confirm. `offeredIn` refuses those two in a space and every other tool in setup, for a model's call
and a page's `act` alike.

## Password reset

Someone who forgot their password resets it themselves (`apps/web/app/lib/password-reset.server.ts`,
pages `/login/forgot` and `/login/reset`). The sign-in page links to it when the web worker has the
`EMAIL` binding and `EMAIL_FROM` (rendered from the registry's `email`), or in local development,
where the email is printed to the dev server's log instead; otherwise it says to ask an admin.

1. **Asking.** `/login/forgot` takes an address and always answers the same: "if it belongs to an
   account that signs in with a password, we've emailed it a code", then moves on to the code step.
   Before the response it does the same work for every address: it counts the request against the
   place (`reset-ip`, 10 per 15-minute window; over it, 429) and the address (`reset-email`, 3 per
   window; over it, the same answer and no email) in `auth_failures`. Each count is one upsert that
   returns the count it wrote (`countAttempt`), and the decision is on that count (`overFor`), so a
   burst of parallel requests can't all pass a read made before any of them wrote. Everything that
   depends on the account (the lookup, writing the code, sending the email, the
   `auth.password_reset_requested` audit entry with its outcome) runs after the response
   (`waitUntil`), so neither the answer nor its timing says whether the account exists.

   The address cap is a hard ceiling, whoever asks. Someone who knows only an address can use up
   its 3 codes for a window, and the owner's own requests in that window then send nothing. That
   stranger gets none of the codes, and each new code replaces the last; the owner waits out the
   window or asks an admin.
2. **Who gets a code.** Only an enabled account with a password, while web SSO-only is off. A
   disabled account, an unknown address, an account single sign-on or SCIM created without a
   password, and every account under SSO-only get nothing, with the same answer; the audit entry
   says which. Under SSO-only the page says the workspace resets passwords at its identity
   provider (a workspace-wide fact the sign-in page shows anyway). An SSO account gets no password
   this way, because the provider couldn't then take its access away.
3. **The code.** 8 characters of Crockford base32 (40 bits), shown `ABCD-EFGH`. Only HMAC-SHA256
   with `PASSWORD_PEPPER` over the reset id and the code is stored (`password_resets.code_hash`;
   plain SHA-256 without a pepper, in local development). A code works once (`used_at`), for 15
   minutes; a new code deletes the person's older ones. It can be used two ways:
   - **Typed**, only in the browser that asked for it. Asking sets a random nonce in that browser's
     `cw_reset` cookie (path `/login/reset`, HttpOnly, 15 minutes), stored hashed with the code
     (`browser_hash`). A typed code from any other browser finds no live code, so a stranger can't
     spend the owner's tries, and rotating browsers gets a guesser nothing.
   - **Through the emailed link** `/login/reset/<reset id>.<code>`, from anywhere. Opening it
     checks the code (a try) and moves the code into the cookie, with the masked address it is for
     (`b***@example.com`), then redirects, so the code is in no later URL. The page shows the
     masked address, so a link planted for someone else's account is noticed before a password is
     set on it.

   Tries are counted the way requests are, one atomic upsert each: 5 per way in (`reset-try`,
   keyed by the browser's nonce or the link's reset id) and 10 per place across addresses
   (`reset-code-ip`, over it 429). Every check does the same work whatever it finds (the two
   upserts, one read for the newest live code, the SSO-only check and the hashing) and changes no
   reset row, so a wrong guess costs the same for any address. Every failure reads the same
   ("isn't right, or it has expired or been used"); `auth.password_reset_failed` records why.
4. **Setting the password.** The password policy applies (`passwordProblem`; for a typed code it is
   checked first, against the address typed, and spends no try). Spending the code is a
   compare-and-set on `used_at`; then one database batch sets the password (clearing
   `password_change_due` and `password_expires_at`), deletes the person's reset rows, their pending
   two-factor challenges and every session. The audit entry is `auth.password_reset`, with the
   person as actor and the sessions ended, and the person is emailed that their password changed.
5. **No second factor is bypassed.** A reset starts no session. The person signs in with the new
   password, and someone with two-factor sign-in still gets the code step. A reset leaves
   two-factor sign-in, recovery codes, passkeys and api tokens as they are: an emailed code proves
   only the mailbox, so it replaces the password and nothing else (an admin's reset, which assumes
   the device may be lost, also removes passkeys and tokens; see
   [Ending a person's access](#ending-a-persons-access)).

## Invitations

A deployment admin can invite an email instead of making an account for them
(`packages/application/src/invites.ts`, table `member_invites`, migration `0019`). An invitation
carries the deployment role the person joins with (`member` or `admin`) and roles in any number of
spaces (`grants`: a role id or preset per space).

- **Who.** Managing invitations takes `space:admin` across the deployment (`authorizeInviter`:
  `authorize(…, '*')`), so a deployment admin signed in to the admin or the root tokens; a space's
  own keys and its team's administrators are refused. The inviter can't grant more than they hold
  (`assertCanGrant`): an `admin` invitation needs deployment-wide `space:admin` from a person
  (`kind: 'user'`), never a root token, and each space
  role's scopes (and, for an inviter limited per content type, its content grants) must be within
  theirs. A resend checks again, as the resender. In the admin, inviting an admin asks for a
  step-up first, and so does a resend unless the api, read by id (`GET /deployment/invites/:id`),
  says the invitation is a member's: an admin's, one it can't find, or a failed lookup asks.
- **The link is a credential.** Its token (`cwi_` + 32 random bytes) is returned once, to the
  inviter, as `/invite/<token>` on the admin's origin (`OAUTH_ISSUER`). Only its SHA-256 with
  `TOKEN_PEPPER` is stored, as for API keys; after the indexed lookup, the hash is compared again
  in constant time. When the deployment sends email, `invite.email_due` (a control event that
  carries the invitation's id and version, never a token or address) has the engine mint a
  **second** token for the emailed link, record its hash, and send it; a stale event (resent,
  revoked, accepted or expired since) sends nothing. Either link works once.
- **Lifecycle.** `pending`, then `accepted` or `revoked`; `expired` is a pending invitation past
  `expires_at` (default 7 days, at most 30), read that way and never written. Every change bumps
  `version`, the compare-and-set that makes a link single-use: accepting replaces the row at the
  version it read in the same unit of work as the `space_members` rows it adds, so of two racing
  accepts one wins and the other gets `invalid_invite` with nothing written. A resend issues a new
  token (both old links stop working) and a fresh expiry.
- **Redeeming.** `POST /deployment/invites/lookup` and `/accept` are the web app's sign-up
  handshake, called by the web worker as itself acting for the deployment (as the credential
  revocation below), so nothing outside it can redeem a link for someone. Every failure (unknown,
  used, revoked, expired, rotated, another address, a lost race) is the same 400
  `invalid_invite`.
- **Accepting** (`/invite/:token`, `apps/web/app/lib/invites.server.ts`). Public, throttled per
  address (`invite-ip`, ten failures in 15 minutes) and protected from cross-site posts like every
  form (`origin.ts`); the page is `no-store` with `Referrer-Policy: same-origin` (not `no-referrer`,
  under which the form would post with `Origin: null` and be refused as cross-site). The link's
  first request moves the token into an HttpOnly, Secure, SameSite=Lax cookie (`cw_invite`, an hour,
  set twice: `Path=/invite` and `Path=/login/sso/callback`) and redirects to `/invite`, so the token
  is in no later URL (the platform's request logs record each request's): the forms post whole
  documents to `/invite`, and sign-in and single sign-on come back to `?next=/invite`. Every way
  back from signing in (password, two-factor, a confirmed SSO link, already signed in) redirects
  there as a document (`redirectToNext`, `X-Remix-Reload-Document`): a client navigation would fetch
  `/invite.data`, outside the cookie's path; a passkey sign-in already loads the page whole. A new
  person either sets a password (refused while web SSO-only is on) or continues with single sign-on,
  which joins them when the provider vouches for the invited address. The link is redeemed
  **before** the `users` row is written, under the id it is about to get, so a failure in between
  fails closed: the link is spent and no one was created. Someone whose address already has an
  account signs in as that person and accepts; the grants are added (a space whose team already has
  them keeps their role) and an `admin` invitation raises a member to admin. Two-factor sign-in,
  where their role needs it, is due on their first session as for anyone. An inviter who has since
  been disabled, removed or made a member no longer vouches: their pending invitations stop working.
- **Audit.** Every create, resend, revoke and accept, whichever surface did it, writes one
  structured log line (`{"type":"invite_audit",…}`: action, actor, invitation id, address, role,
  spaces), which Logpush carries like the admin's `audit_event` lines: the api has no
  deployment-wide audit log, and an invitation may grant no space. It is also recorded in each
  granted space's `audit_log` (`invite.created`, …), and the admin's actions and every accept or
  refused link in `admin_audit` (`team.invite_*`, `auth.invite_failed`, with a fixed reason, never
  an error's text). No token or token hash is logged or audited.

| Route (`/deployment/invites`)  | MCP tool        | Does                                                                                 |
| ------------------------------ | --------------- | ------------------------------------------------------------------------------------ |
| `GET ?status=`                 | `invites_list`  | Invitations, newest first (never a token)                                            |
| `GET /{id}`                    | `invite_get`    | One invitation: its role, grants and status                                          |
| `POST`                         | `invite_create` | Invite; the link comes back once (201). `admin` only from a person, not a root token |
| `POST /{id}/resend`            | `invite_resend` | A new link and expiry; the old ones stop working                                     |
| `POST /{id}/revoke`            | `invite_revoke` | End it (an accepted one can't be: 400)                                               |
| `POST /lookup`, `POST /accept` | none            | The web app's sign-up handshake                                                      |

## Ending a person's access

Disabling a person, resetting their password, resetting their two-factor sign-in and SCIM
deactivating them each end what was made under the old trust, through `endAccess`
(`apps/web/app/lib/access.server.ts`): their web sessions, their passkeys where the device may be in
someone else's hands (password and two-factor resets), and their api tokens. For the tokens the web
worker calls the api's `DELETE /deployment/people/:subject/credentials`, signing the principal as
itself acting for the deployment (a deployment admin, so a wildcard principal; anyone else gets
403). The route runs `revokeEverythingFor` (`packages/application/src/oauth.ts`), which revokes, in
every space, the OAuth access tokens and grants, personal access tokens and setup credentials whose
subject is the person's web user id, and answers `{ revokedTokens, revokedGrants }`. A space's own
API keys are not a person's and are untouched. If the api refuses, the action fails visibly and can
be repeated; both halves are idempotent. The counts go into the admin audit entry's detail.

## Custom roles (granular RBAC)

A **role** is a named, space-scoped permission set assignable to API keys and to people (team members): the layer
below coarse scopes. It carries a scope set plus per-content-type grants:

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
  actions: readonly ('read' | 'write' | 'publish' | 'lock')[];
  deniedActions?: readonly ('delete' | 'unpublish')[]; // finer actions withheld (see below)
  deniedFields?: readonly string[]; // masked on read, rejected on write
  readOnlyFields?: readonly string[]; // readable, rejected on write unless sent back unchanged
}
```

Semantics:

- **Roles are live**: a role-bound key resolves the role's scopes and grants on **every**
  request (`authenticate`), so editing a role instantly changes what every bound key can do.
  Deleting a role is refused while active keys reference it; a dangling reference fails closed.
- **Exact grant wins over `'*'`**; a type with no matching grant is denied entirely.
- **Six actions, four listed.** `ContentAction` is
  `read | write | publish | lock | delete | unpublish`. A grant lists only the first four;
  `lock` (locking and unlocking regions of an entry's blocks, whoever locked them) is never
  implied, so a grant holds it only when it lists it. `grantedActions(grant)` adds `delete` when it lists `write`
  or `publish`, and `unpublish` when it lists `publish`, unless `deniedActions` withholds them.
  Every grant stored before the finer actions existed names no `deniedActions`, so it authorizes
  exactly what it did (`packages/domain/test/content-actions.test.ts` proves it for every legacy
  action list), and no stored role, preset, key or token changed. Role validation refuses
  `delete`/`unpublish` in `actions` (one way to say it) and anything else in `deniedActions`.
  An inviter's grants are compared resolved (`assertCanGrant`), so withholding `delete` caps what
  they can hand out.
- **What each operation needs** (`ENTRY_OPERATION_ACTIONS`, on top of the coarse scope):
  trash `write` + `delete` (`authorizeTrash`, which also refuses a live entry when the grant
  withholds `unpublish`, since trashing unpublishes it); restore `write`; purge `publish` +
  `delete`; unpublish `unpublish`. These were a write and two publishes before, which is why the
  base action stays required.
- **Enforcement points** (identical for HTTP and MCP): entry create/update check
  `authorizeContent(principal, 'write', ct)` + `assertWritableFields` (an update, and its dry run,
  pass the stored fields: a read-only field whose every sent locale holds its stored value is no
  write, so the admin's form and canvas, which send back every field they read, can save; a
  denied field is refused at any value, since accepting its stored one would let a caller guess
  it); publish checks `publish`;
  unpublish, bulk unpublish (`/bulk/entries/unpublish`, `entries_bulk_action`) and the
  `content.unpublish` node check `unpublish`; trash and purge as above. Shipping a release
  (`publishRelease` with the caller's `principal`, from the route, `releases_publish` and the
  `content.publish_release` node) checks `publish` or `unpublish` per member type, and
  `scheduleAction` checks the scheduler's role against the entry (or every release member) when
  the action is scheduled, since the cron fires it with no one behind it; for the same reason
  `addEntryToRelease` checks `read` plus the item's action when a member goes in (route,
  `releases_add_entry`, the `content.add_to_release` node), so a release already scheduled can't
  gain a member its adder couldn't ship. Bulk jobs are authorized as a whole (see
  [below](#api-keys-at-rest)).
  An import (`analyzeImport`, `executeImport`, `startImportJob`, which take the caller's
  `principal`) checks `write` on the target type before reading the payload; an `identityField`
  also needs `read` on the type and a field the role may read. A record that sets a field the role
  denies or makes read-only is skipped and listed in the report's `issues`, like one that fails
  validation. An update keeps what such a field holds (an update's fields are the whole new
  version, so leaving it out would clear it), read as the record is written, so the report is the
  same whether it holds a value or not. An import job runs in the engine with no one behind it, so
  the decision is made when the job starts: only records the principal may write are staged, with
  the names of the fields an update keeps. The operations over a
  whole environment can't be authorized type by type, since they write types they create:
  `GET …/export` (`read`), `POST …/import` and `POST …/imports/space-export` and its analyze
  (`write`, plus `publish` unless `publish` is false), and `POST …/clone` (all of those), with the
  matching MCP tools, need `content:manage` and `authorizeEveryContentType`: no per-type grants, or
  a single `*` grant holding those actions and restricting no field. The Manager and Administrator
  presets qualify. `POST …/merge` (`environments_merge`) needs the same, with `read`, `write` and
  `lock`, when it copies entries, since they go whole over the target's locked regions (the
  Manager preset qualifies, a role with the Editor preset's grant doesn't); copying only content
  types needs just `content:manage`. The use-cases
  make these checks themselves (`exportSnapshot`, `importSnapshot`, `startSnapshotImport`,
  `cloneEnvironment`, `startEnvironmentClone`, `mergeEnvironments`, `analyzeSpaceExport`,
  `startSpaceExportImport`, through `authorizeEnvironmentWide` in `environment-access.ts`), each
  taking a required caller: the request's principal, or `SYSTEM_CALLER` for work already
  authorized as a whole (a clone's own export and import, a job's prepare chunk). Anything else
  fails closed, so a new surface can't reach one without the check. The use-cases also check
  `content:manage` in a clone's target space and `space:admin` for a space export import's
  `addLocales`. Promotions are held to the same rule with `read`, `write` and `publish` (and
  `lock` when they carry entries, which are copied over the target's locked regions), when
  requested and again when approved or rejected (`requestPromotion`, `approvePromotion`,
  `rejectPromotion`); the approver's grants are the ones in force when it applies. A promotion is
  shown (`getPromotion`, `listPromotions`) only to a role that can read every content type it
  names with no field hidden (`canReadPromotion`; any other is not found). A cross-space clone
  needs `content:manage` in both spaces, and a principal is resolved for one space (its grants are
  that space's), so only a deployment-wide principal such as the admin token, which carries no
  grants, can clone across spaces.
  `GET …/compare` (`environments_compare`) lists only the content types the role can read and
  their entries.
- **Release note.** A custom role with `content:manage` and a `*` grant of `read` and `write` but
  not `publish` used to run a snapshot or space export import that published. It now needs
  `publish=false` for those imports (`?publish=false`, `"publish": false`), and the same on a clone.
- **Release note.** A custom role with `content:manage` and a `*` grant of `read` and `write` but
  not `lock` used to merge entries (`POST …/merge`, `environments_merge`) over the target's locked
  regions. It can no longer merge entries, since that takes `lock` on every content type; merging
  content types alone still works. The Manager and Administrator presets hold `lock` and are
  unaffected. To restore it, add `lock` to the role's `*` grant.
- **Limits of a withhold**, stated plainly:
  - It doesn't constrain a principal that also holds `space:admin`: that principal can edit roles
    (its own included) and mint keys, so withholding `delete` from an administrator is advice, not
    a control.
  - Scheduled actions and workflow runs are authorized when they are created or started.
    Withdrawing a permission later doesn't cancel them; cancel the scheduled action
    (`DELETE …/scheduled-actions/{id}`) or the run to revoke what they would do. Bulk jobs are
    checked again before each chunk (see "Bulk jobs re-check their starter" below).
  - A write-only grant (no `publish`, so no `unpublish`) can still trash a live entry, which
    unpublishes it. Only an explicit `deniedActions: ['unpublish']` stops that.
- **Role edits are live at once.** `createRole`, `updateRole` and `deleteRole` drop the space's
  cached principals (`invalidateCachedPrincipals`), so Delivery's cached keys see the new grants on
  their next request. Management/preview/delivery reads filter out ungranted types and
  `maskDeniedFields` on what remains. Keys without a role (`contentGrants === undefined`) are
  unrestricted at this layer — coarse scopes alone apply, preserving pre-role behavior.
- Managed at `GET/POST /spaces/:space/roles`, `GET/PUT/DELETE /spaces/:space/roles/:id`
  (requires `space:admin`) and the `roles_list` / `role_create` / `role_update` /
  `role_delete` MCP tools. Mint a bound key with `POST /spaces/:space/api-keys { kind, roleId }`. Deleting is
  refused while a key or a person holds the role, and for a preset.
- **A role save is held to its version.** Every role carries a `version` (1 when created, one more
  at each save; `0041_role_versions`), and the store writes a save only while the row is at the
  version it read, inside `withTransaction`, so of two saves from one read only one lands; the other
  is a `TransactionConflictError` at commit, answered as `409 conflict`. `PUT …/roles/:id` and
  `role_update` take an optional `expectedVersion`: one that isn't the stored version is a
  `409 conflict` with `details: { version }` (the version in force) and nothing written; without it
  the save goes over whatever is stored, as before. `updateRole` runs the delegated-bearer widening
  refusal and the last-admin check first, against the role as stored now, then the version check,
  so a stale save is refused only when it would otherwise be allowed, where a save that loses the
  race at commit is refused too. The admin's Access sheet always sends the version it opened with;
  on a stale `409` it keeps the edits, says someone else changed the role and offers to reload it.

Grants govern entry read/write/publish/delete/unpublish and content-type visibility. **Delivery and Preview**
list/get endpoints filter ungranted content types and `maskDeniedFields` on responses. Coarse
scopes still gate search, GraphQL, SSE, and assets at the route level.

A save stores exactly the fields it sends, but a key can't send a field its role denies or makes
read-only. So `updateEntry` and `validateEntry` take `unwritable` (`unwritableFieldsFor`) and lay
the stored values of those fields over what was sent before they validate and save: a restricted
writer's save keeps them, and a required one doesn't block it. The response is still masked, so
the kept value of a denied field never comes back to the writer. HTTP `PUT …/entries/:id` and
`…/entries/validate`, MCP `entries_update` and `entries_validate`, and a plugin's `content.update`
all pass it.

The AI operations over one entry are held to the same grants, in the use-cases themselves so every
caller is: `translateEntry`, `summarizeEntry`, `autofillField`, `suggestEntryTags`,
`applyEntryTags`, `runAIAction`, `auditEntry` and `moderateEntry` take `{ principal }`, which is
required: the request's principal, or `SYSTEM_CALLER` for a run no role bounds (anything else
fails closed). They load the entry through `readEntryForAi`. It answers 404 for a missing entry and
`authorizeContent` 403 without `read` on its type (plus `write` when the run applies, or when an
audit creates tasks), as `GET …/entries/:id` does, then masks the denied fields
(`maskDeniedFields`) before anything is shown to the model or returned, the no-text-to-translate
answer included. An audit's prompt doesn't name a denied field, and on-demand moderation
classifies only the readable fields (`deniedFields` on the agent run). An apply saves with
`unwritable` and `unreadable`, so denied and read-only fields keep their stored values and a
refusal counts their issues instead of naming them; `assertAiTargetField` refuses autofilling a
denied field and writing a summary, autofill or AI action output into one the role can't write,
before the model is asked. Tagging is the one exception to `POST …/taxonomy/tags` needing
`content:manage`: `apply-tags` and an applied tag suggestion add new names to the vocabulary for
any caller that may write the entry (`content:write` and `write` on its type), so an editor can coin
the tags it applies. The REST routes (`…/translate`, `…/summarize`, `…/autofill`,
`…/suggest-tags`, `…/apply-tags`, `…/audit`, `…/moderate`, `…/ai-actions/:id/run`), their MCP
tools (and so the assistant) and the workflow AI nodes (as the run's principal) all pass it. The
pre-publish moderation gate (`moderateBeforePublish`) passes `SYSTEM_CALLER`: it judges every
field, so a writer can't hide content from it in a field it may not read.

The workflow AI nodes that don't go through those use-cases (`ai.classify`, `ai.router`,
`ai.assess`, `ai.moderate`, `ai.enrich`, and the `ai.summarize` fallback) build their prompts,
decision state and heuristics from `runForModel`: the run's entry without the fields the run's
principal may not read, and without its title when the display field is one of them. In the run's
vars and earlier nodes' outputs, any string that contains a denied field's stored text (4
characters or more) is replaced by `(hidden)`; text derived from a denied field without quoting it
(a paraphrase by a node that ran as someone else) isn't recognised. `ai.enrich` fills only empty
fields the principal may write, and an auto-apply saves with `unwritable` and `unreadable`.
Approving an agent review over REST or MCP applies the proposal as the approver's role allows
(`applyProposedFields` with the approver: `unwritable` and `unreadable`); a workflow task's
decision applies it as proposed, since the proposal holds only fields the run's principal may write.

The other entry-by-id routes take the same grants: `PUT …/entries/:id/metadata` and MCP
`entries_set_metadata` need `write` on the type; `…/workflow/transition` and MCP
`workflow_transition` need `read` (not `write`: an approver's role reads the types it moves along);
every comment and task operation needs `read` on the entry's type, on both surfaces: listing,
commenting and creating a task on the entry, and resolving, reopening, reassigning or deleting a
task or deleting a comment (judged by the entry it is on, via `taskEntryId` / `commentEntryId`); and
`GET …/entries/:id/embedding`, `…/related` and `…/duplicates` (MCP `content_related`,
`content_duplicates`) need `read` and match only on the fields the caller may read, since a vector
over a denied field would let it test guesses of that field's value by similarity.

## API keys at rest

```ts
interface ApiKey {
  id: string;
  spaceId: string;
  kind: ApiKeyKind;
  name?: string; // optional human-readable label
  hashedToken: string; // SHA-256 of the raw token — the raw token is NEVER stored
  scopes: readonly string[]; // display snapshot; role-bound keys resolve live from the role
  revoked: boolean;
  roleId?: string; // custom role binding (granular RBAC)
  lastUsedAt?: string; // last successful authentication
  expiresAt?: string; // after this instant the key stops authenticating
  issuance?: 'key' | 'oauth' | 'pat' | 'setup'; // how the token came into existence
  subject?: string; // the human it acts for (OAuth grant / PAT owner)
  clientId?: string; // the OAuth client that obtained it
}
```

The raw token is returned exactly once, at creation (`POST /spaces/:space/api-keys`). Authentication hashes
the presented bearer token and looks it up by hash (`AuthRepo.findByHash`).

### One token model, three issuances

There is exactly one credential type and one authentication path. An OAuth access token and a
personal access token are both `ApiKey` rows — so expiry, revocation, live role resolution and
last-used tracking apply to all three without a second code path. Only the provenance differs:

| `issuance` | Prefix            | Minted by                                                                | Lifetime                              |
| ---------- | ----------------- | ------------------------------------------------------------------------ | ------------------------------------- |
| `setup`    | `cwsetup_<kind>_` | The api's former setup route (removed; existing ones still authenticate) | Unbounded; stops while SSO-only is on |
| `key`      | `cwk_<kind>_`     | An operator, via `POST /spaces/:space/api-keys`                          | Unbounded unless `expiresAt` is set   |
| `oauth`    | `cwo_<kind>_`     | An OAuth grant a human approved                                          | `OAUTH_ACCESS_TOKEN_TTL_SECONDS`      |
| `pat`      | `cwpat_<kind>_`   | A human, via `POST /spaces/:space/personal-access-tokens`                | Unbounded, or `expiresInDays`         |

**Delegated tokens (`oauth`/`pat`) treat their scopes as a ceiling.** A role-bound operator key
resolves the live role in both directions, as it always has. For a delegated token the effective
scopes are `role.scopes ∩ token.scopes`: widening the role later must not retroactively widen a
token a human approved for less, while narrowing the role still takes effect immediately. Content
grants continue to resolve live in every case — only the coarse scopes are capped.

A delegated token also cannot mint a longer-lived one: `POST /spaces/:space/personal-access-tokens` refuses any
delegated bearer (an OAuth-issued token, or another personal access token), so a credential that
expires in an hour cannot promote itself into one that never does. That route is deliberately **not** exposed as an
MCP tool for the same reason. Operator API keys are on MCP (`api_keys_list`, `api_key_create`,
`api_key_update`, `api_key_revoke`), and the same rule covers them on both surfaces: a delegated
bearer (`isDelegatedBearer`: an OAuth or personal access token, which `authenticate` marks with
the principal's `issuance`) gets **403** from `POST /spaces/:space/api-keys` and from a
`PUT /spaces/:space/api-keys/:id/role` (or `role_preset_assign`) that would widen a key: new
scopes it doesn't hold, content grants that aren't a narrowing of the key's, or unbinding it from
a role. It is refused the same way editing a role an active key holds (`PUT /spaces/:space/roles/:id`,
`role_update`) to add scopes or widen its content grants, and minting a personal access token
(a token can't mint another). Narrowing is allowed. Content grants narrow only one for one
(`grantsNoWider`): the same number of grants in the same order, each on the same content type
with the same denied and read-only fields, holding a subset of the held grant's actions (implied
`delete` and `unpublish` included) and keeping every action the held grant denies. So moving a key
from Manager to Editor (dropping `lock`) is a narrowing; dropping a grant (no grants is
unrestricted), naming another type or lifting a denial is a change, and refused. The key use-cases take the issuer as a
required argument (a principal, or `system` for the OAuth and personal access token flows). A signed-in person, an operator key and the admin token are unaffected. Before this,
a personal access token holding `space:admin` could mint a key over REST.

**Nor can a delegated bearer give a person lasting access.** A seat on a team outlives the token
that would grant it, so the people use-cases refuse it with **403** `forbidden`
(`DelegatedPeopleError`, `details.reason: "delegated_bearer"`, "A personal access token or OAuth
token can't …; sign in to the admin to do this"), on REST and MCP alike:

| Operation                                                                    | Delegated bearer                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /spaces/:space/members` (`addMember`)                                  | Refused                                                                                                                                                                                                                                       |
| `PATCH /spaces/:space/members/:id`, `role_preset_assign` with `memberId`     | Refused when it changes the role (up or down) or re-enables the person; renaming and disabling pass                                                                                                                                           |
| `DELETE /spaces/:space/members/:id`                                          | Allowed: it only takes access away (the last-admin rule still holds)                                                                                                                                                                          |
| `PUT /spaces/:space/roles/:id`, `role_update`                                | Refused when it widens a role anyone on the team holds (disabled people included) or an open invitation grants (pending, or expired and still resendable; a deployment with more than 500 of either refuses every widening); narrowing passes |
| `POST /spaces/:space/roles`, `…/roles/:id/clone`, `role_create`              | Allowed: nobody holds a new role, and giving it to anyone is checked                                                                                                                                                                          |
| `PUT /spaces/:space/access-settings` `{ ssoOnly: false }`                    | Refused (it brings the setup credential back); turning SSO-only on passes                                                                                                                                                                     |
| `POST /deployment/invites`, `…/:id/resend`, `invite_create`, `invite_resend` | Refused (a delegated token is bound to one space, so `authorizeInviter` already refused it; this says why)                                                                                                                                    |

Unlike a key's role, which a program may narrow, a person's role changes only by a named
person's act, so a delegated bearer can't change it in either direction. The people use-cases
take the caller as a required argument (`PeopleActor`: a principal, or `system` for seeding).
Deployment-wide people, deployment roles and SCIM live in the web Worker behind the admin
session and SCIM's own token; no API bearer reaches them.

## Secrets at rest

Credentials the platform must _use_ (not merely verify) cannot be hashed, so they are encrypted
instead. Hashing stays the rule wherever a value is only compared: API keys, preview tokens,
OAuth client secrets, and OAuth codes/refresh tokens are stored as hashes and are **not** encrypted.

| Column                    | Sealed value                                    | Context (AAD)                                          |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------------ |
| `webhooks.secret`         | The HMAC signing secret                         | `webhooks.secret:<webhook id>`                         |
| `webhooks.headers`        | Each header **value** (names stay readable)     | `webhooks.headers:<webhook id>:<header name>`          |
| `plugin_settings.secrets` | Each secret plugin setting (keys stay readable) | `plugin_settings.secrets:<space id>/<plugin id>:<key>` |

- **Format.** AES-256-GCM under a key derived with HKDF-SHA-256 from `DATA_KEY`. A sealed value
  reads `e1.<kid>.<iv>.<ciphertext>` (base64url parts); `kid` is an HMAC-derived id of the key that
  sealed it. The context is bound as GCM associated data, so a ciphertext copied into another row
  or column fails to decrypt rather than leaking.
- **Transparent.** `withSealedSecrets` (`@contentworker/application`) decorates the `ContentStore`
  at the composition root: repos seal on write and open on read, so use-cases, MCP tools, the
  webhook dispatcher and a plugin's `caps.settings.get()` see plaintext and the store adapters
  persist opaque strings. No read API returns a plugin's secret setting: it reports which are set. The crypto is
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

**Rotating `DATA_KEY`** (the one procedure; [Deployment](./deployment.md#secrets) and
[Configuration](./configuration.md#secrets-and-keys) link here): set `DATA_KEY_PREVIOUS` to the
current key and `DATA_KEY` to a new one (`openssl rand -base64 32`) in the deployment's GitHub
environment (every worker receives both on the next deploy), wait for a reseal run that logs
`complete: true` and `unreadable: 0`, then remove `DATA_KEY_PREVIOUS`. Losing `DATA_KEY` makes
stored webhook secrets unrecoverable: re-enter them.

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
- **`GET /auth/me`** returns the resolved principal summary; **`GET /spaces/:space/auth/me`**
  returns it resolved in that space (a person's role is per space), with `restricted` true when the
  role carries per-content-type grants (every space member's role does; deployment admins and
  plain keys don't), `bulkJobs` (the bulk jobs over entries it may start there, see below),
  `contentActions` (`contentActionsFor`: the actions its grants hold per content type a grant
  names, `types`, and on every other type, `others`; with no grants, every action on every type),
  `fieldRules` (`fieldRulesFor`: the `deniedFields` and `readOnlyFields` of the same grants, shaped
  the same way, by name only; with no grants, none), and `403` for a caller with no standing in
  that space. The route and the `auth_me` MCP tool both answer `spaceAccessFor` (application), so
  an agent reads its own field rules as the admin does; `GET /auth/me` has no tool, since an MCP
  client already knows its own token. The admin reads it before offering the bulk trash, restore
  and delete jobs, before offering Lock on an entry's blocks (`lock`), and before drawing an
  entry's form (`apps/web/app/cms/lib/field-access.ts`): a denied field is left out of the form,
  its validation and the save; a read-only one shows its stored value read-only ("Your role can't
  change this field") and is left out of the save. Leaving them out is what an update expects
  (`unwritable`: the stored values are laid over what was sent), so a required one never fails a
  save it can't change. Field rules name top-level fields, never anything inside a block or
  component, so the canvas opens for review when a blocks field is denied or read-only, and its
  save leaves out the person's read-only fields as the form's does.
- **Bulk jobs over entries** (`POST …/bulk/jobs`, its report and cancel, and the matching MCP
  tools) can't be authorized entry by entry, and a report names entries of every type, so
  `authorizeBulkJob` (application) asks `canRunEntryBulkJob` (domain) for a role that holds the job's actions on every content type alike: one with no per-content-type
  grants, or one whose grants are a single `*` grant holding them (publish needs `publish`,
  unpublish `unpublish`, trash `write` and `delete` and not a withheld `unpublish`, restore
  `write`, purge `publish` and `delete`)
  and restricting no field. The Editor, Manager and Administrator presets qualify; a role limited
  to some types, or with field rules, doesn't.
  Asset jobs still need a principal with no per-type grants. An import job's report and cancel go
  by what it reached (`authorizeBulkJobAccess`): a CSV, JSON or WordPress job needs `write` on its
  content type, and a snapshot, clone or space export job needs `read` and `write` on every type
  alike. A role with field rules on the type can cancel a single-type job but not read its report,
  since a failure's message can quote a stored value (a unique conflict names it, a plugin's
  refusal says what it likes).
- **Bulk field edits** (`POST …/bulk/jobs/set-fields`, MCP `bulk_job_set_fields`) write one
  content type's entries, so `authorizeSetFieldsJob` asks what an edit does: `write` on that type
  and none of the fields sent denied or read-only to the role. Its report and cancel go by that
  type as a single-type import's do, and the job as read back (status, list, report) names the
  fields it sets but never holds their values, which only an entry's reads, masked by the role,
  return. The grants are checked when the job starts and again before each chunk (below); the
  saves are authored by whoever started it.
- **Bulk jobs re-check their starter.** A job
  records who started it as `config.startedBy` (`persistJob`, from the request's context, never
  from the request body): `{ kind: 'key', keyId }` for an API key, OAuth token, personal access
  token or setup token (the key row, never the token), `{ kind: 'member', memberId }` for a person
  signed in to the admin, or `{ kind: 'deployment' }` for the admin and MCP tokens and a deployment
  admin acting in a space whose team they are not on. Before each chunk, before it is claimed,
  `runBulkChunk` resolves the starter again from the store (`starterLostAccess`,
  `packages/application/src/job-starter.ts`; one resolution per chunk): the key by id in the job's
  space through the same rules `authenticate` applies (`principalForApiKey`: revoked, expired, a
  deleted role, a delegated token's person disabled or off the team, SSO-only for setup tokens),
  or the membership (removed, disabled, no role, a deleted role). The resolved principal must
  still pass the job's start rule (`authorizeJobContinues`): the start route's scopes
  (`content:publish` for entry jobs and asset publish, unpublish and archive; `content:manage`,
  `content:write` and `content:publish` for a content type's delete; `content:write` for a field
  edit or a single-type import; `content:manage` for a snapshot, clone or space export import;
  `assets:write` for asset move, tag and reindex) and its content grants (`canRunEntryBulkJob` on
  every type for an entry job, so a grant narrowed for any type stops it; `write` on the type and
  every field sent for a field edit; `write` on the type and on every field its records set for an
  import (`config.fieldNames`); every type for a snapshot import). A starter that fails either is stopped: the job turns `cancelled` with
  `config.cancelReason: 'starter_lost_access'` and `config.cancelDetail` saying why, nothing more
  runs on their behalf (a chunk already running finishes, as with a cancel), staged work is
  discarded, a content type's delete records `typeDeletion: { deleted: false, reason }`, and the
  audit trail gets one `bulk_job.starter_lost_access` row by `system` naming the job. The
  `deployment` starter, jobs the system starts (a starter install, the scheduler, a reindex after
  the engine starts on its own), and job rows written before the record keep
  running, as before. The application can't see a person's deployment role (the admin web app
  keeps it), so a deployment admin's job in a space whose team they are not on runs to the end
  even if they are demoted or their account is disabled meanwhile; cancel it. A job a job starts (a clone's create job, a snapshot's publishing job)
  carries the same starter; the asset reindex a snapshot import starts is the system's. `config.startedBy` is never in a job as read back.
- **Preview links** — `POST …/entries/:id/preview-link` mints an expiring token; CPA
  `GET …/entries/:id?preview_token=…` accepts it without a bearer header.
- **OAuth 2.1** — when `OAUTH_ISSUER` is set, MCP clients obtain tokens through
  `/oauth/*` instead of being handed a static key (see below).

## OAuth 2.1 for MCP clients

Setting `OAUTH_ISSUER` makes the management API an OAuth 2.1 authorization server, so an MCP
client (Claude, ChatGPT, an IDE) can be installed as a connector. The implementation is
`packages/http/src/api/oauth/routes.ts`; the `OAUTH_*` vars are in
[Configuration](./configuration.md#oauth-21-for-mcp-clients-api).

| Endpoint                                      | Purpose                                                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /.well-known/oauth-authorization-server` | Authorization-server metadata                                                                        |
| `GET /.well-known/oauth-protected-resource`   | Protected-resource metadata (RFC 9728); also served at the path-suffixed URL for the `/mcp` resource |
| `POST /oauth/register`                        | Dynamic client registration (RFC 7591), unauthenticated                                              |
| `GET`, `POST /oauth/authorize`                | Authorization-code consent (PKCE `S256`); a signed-in person approves                                |
| `POST /oauth/device_authorization`            | Starts a device-code grant                                                                           |
| `GET`, `POST /oauth/device`                   | The page where a person enters the device code and approves                                          |
| `POST /oauth/token`                           | Exchanges an authorization code, device code or refresh token                                        |
| `POST /oauth/revoke`                          | Revokes a token (RFC 7009); always answers `200`                                                     |

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
worker serves `/.well-known/oauth-protected-resource` alongside `POST /mcp`.

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
(`unauthorized`). A refusal that says what it refused carries `error.details` (a block patch's
`{ reason: "read_only", field }` or `{ reason: "hidden", hidden: n }`, which counts fields the
caller can't read rather than naming them); MCP answers such a refusal with the same body. A
save's `422` counts field issues in fields the caller can't read the same way, in one
`{ field: "", code: "hidden", hidden: n }` issue after the others, so a stored value it may not see
is never named by its path or message: an entry's create, update and their dry run
(`…/entries/validate`, `entries_validate`), its SEO save and its publish (a dangling link, without
its target) as much as a block patch, on both surfaces. Shipping a release folds each member's
refusal by the shipper's role on that member's type (`…/releases/:id/published`,
`releases_publish`), and a workflow run's `content.publish` and `content.publish_release` nodes fold
their failure reason by the run's principal, who reads it, as `content.validate` folds its
`issues` output and summary. Bulk publish, a bulk publish job's
report and a scheduled publish's `error` never list issues (each says
`One or more fields are invalid`), so they have nothing to fold. A `409` for a unique value one of
those fields holds is counted the same way (`details.hidden`), without the field, the value or the
entry holding it.

## Scope → operation map

| Scope              | Use-cases / endpoints (representative)                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `content:write`    | Entry CRUD, AI generation endpoints, bulk writes, comments/tasks, metadata (+ `assets:write`)          |
| `content:publish`  | Publish/unpublish entries, assets, content types, releases; scheduled actions                          |
| `content:manage`   | Content types, workflows, taxonomy, functions, app-extensions, ai-actions, merge                       |
| `preview:read`     | Preview entries, content types, releases, workflows, collaboration reads (+ `assets:read`)             |
| `assets:read`      | Asset reads: list, search, files, metadata, folders, collections, renditions, versions, zips           |
| `assets:write`     | Asset upload, replace, edit, organize, restore; folders, collections, alt text, auto-tag, video        |
| `delivery:read`    | Published entries/assets, Live Content SSE, GraphQL                                                    |
| `search:read`      | Hybrid/semantic search, related/duplicates/embedding                                                   |
| `space:admin`      | Spaces, environments, aliases, API keys, roles, team, access settings, webhooks, audit log, agent runs |
| `workflow:approve` | Deciding workflow approvals whose node asks for it (the default)                                       |

`GET /spaces` returns all spaces for an admin principal (`spaceId: '*'`) or only the key's own
space for scoped keys.

## Dev credentials

In in-memory mode (no `DB` bound) the store is seeded with keys whose raw tokens are the `CMA_KEY` /
`CDA_KEY` / `CPA_KEY` config values (defaults `dev-cma-key`, `dev-cda-key`, `dev-cpa-key`) and the
`ADMIN_TOKEN` (default `dev-admin-token`). With `DB` bound, an unset one is empty (off), never the
dev default (`loadConfig`). The keys are seeded **through the real auth path** (hashed and stored),
so dev and production behave identically. With a real database, the demo seed (`SEED_DEV=true`)
writes the same dev keys. The MCP endpoint additionally accepts `dev-mcp-token` when no `MCP_TOKEN`
is set, but only in in-memory demo mode; a persistent deployment requires an explicit `MCP_TOKEN`
before `/mcp` mounts. What `pnpm dev` sets is in [Development](./development.md#running-locally).
Replace all of these in any real deployment (`REQUIRE_SECURE_SECRETS=true` refuses to serve with the
dev-default admin token and keys).
