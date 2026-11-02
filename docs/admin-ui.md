# Admin UI

The admin is `apps/web`: a React Router 8 app rendered on the web Worker (SSR), which also owns
human sign-in and fronts the api over the `API` service binding. Its design context is
`PRODUCT.md` and `DESIGN.md` at the repo root ("Ledger", from `@contentworker/design` and
`@contentworker/ui`); read both before designing a screen, and compose the existing tokens and
components rather than stock defaults.

## Running locally

`pnpm dev` (see [Development](./development.md#running-locally)) serves the admin at
http://localhost:5173 together with the api, engine and delivery Workers. While the local
database has no people the admin is open; once someone is added through `/setup`, sign-in is on.

## In production

The web Worker is deployed at `<domain>` (custom domain rendered by `scripts/fleet.ts`). Static
assets are served by the platform; HTML responses default to `private, no-cache`. Every response
carries the security headers from `app/lib/csp.ts`, and state-changing browser requests from
another origin are refused (403).

## Sign-in and people

| Route                                                  | What it does                                                                                                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                                                    | Signed in, redirects to `/dashboard`; signed out, `requireUser` sends the browser to sign-in                                                                                     |
| `/setup`                                               | Redeems the one-time `SETUP_TOKEN` to create an Admin account (`app/lib/setup.server.ts`)                                                                                        |
| `/login`                                               | Email and password (PBKDF2, peppered with `PASSWORD_PEPPER`)                                                                                                                     |
| `/login/passkey`, `/account/passkeys`                  | Passkeys (WebAuthn)                                                                                                                                                              |
| `/login/two-factor`                                    | TOTP second factor, or a recovery code                                                                                                                                           |
| `/logout`                                              | Signing out is a POST (the origin check covers it); a GET asks first                                                                                                             |
| `/login/sso`, `/login/sso/callback`, `/login/sso/link` | OpenID Connect single sign-on with the deployment's provider (`app/lib/sso.server.ts`)                                                                                           |
| `/scim/v2/*`                                           | SCIM provisioning from the identity provider, with its own bearer token. Answered by `workers/app.ts` (`scimFetch`) before React Router, so it is not a route in `app/routes.ts` |
| `/team`                                                | People, deployment roles (Member, Admin), SSO and SCIM settings (admins)                                                                                                         |
| `/audit`                                               | The deployment's admin audit log (`admin_audit`, hash-chained)                                                                                                                   |
| `/account`                                             | Your password, passkeys, two-factor                                                                                                                                              |

Sessions, users, passkeys and challenges live in D1 (`0002_auth.sql`). Authenticator secrets are
sealed with `DATA_KEY`. Sign-in paths that need no session, and SCIM, are rate-limited per address
(`API_LIMIT`).

## How screens reach the API

The CMS screens (`app/cms`) call the Management API in the browser with TanStack Query
(`app/cms/lib/management.ts`) on the same origin: `/spaces/...`, `/preview/...`, `/delivery/...`,
`/mcp`, `/media/...`. The web Worker's gateway forwards those to the api with a signed
`x-cw-principal` (60 s, bound to the path) in place of the session cookie, and passes the
`x-cw-bookmark` read-your-writes header both ways. The admin keeps the newest bookmark it has seen
(`rememberBookmark`: D1 bookmarks sort as strings, so an older reply arriving late never moves it
back, and a value not shaped like a D1 bookmark is ignored), as the SDKs do. See
[Architecture](./architecture.md#appsweb-the-admin-and-the-gateway) and
[Auth & RBAC](./auth-and-rbac.md#the-web-principal).

The admin is not a composition root. All business logic, validation and RBAC run in
`@contentworker/application` behind the api. A new capability is exposed through the API and MCP
first; the admin then calls the route.

## Layout

From `md` a sidebar lists the day's work (Overview, Content, Approvals, Releases), then Build
(Workflows), Library (Assets, Taxonomy) and Settings, with the account and theme at its foot; it
collapses to an icon rail. A sticky header holds the breadcrumbs, the space / environment / locale
scope, search and New entry. Below `md` a bottom tab bar holds the day's work and More.
`app/cms/components/layout/nav.ts` is the one source of the pages and their `g`-letter shortcuts
(`?` lists them).

`/team`, `/audit` and `/account` are not in `NAV` (`nav.ts`). The shell adds them: admins get a
Deployment group (People and sign-in, Audit log) after Settings, and Account sits in the account
menu at the sidebar's foot (the More sheet on a phone). Settings sections are addressed as
`/settings/:section` (default `team`, Space access): **Access** (Space access, API keys, Roles, Connected apps), **Automation**
(Webhooks, Functions, AI actions), **Extensions** (App extensions, Plugins), **Workspace**
(Environments, Redirects, Audit log).

## Features

- **Overview** (`/dashboard`): what needs attention, live activity, AI usage and throughput.
- **Content** (`/content`): content types and their schema editor; entries per type with filters,
  search, sorting from the column headers, a bulk bar for publishing and unpublishing what is
  ticked, and Load more past the first 100 (`/content/:typeId`; `/content/:typeId/new` starts a new
  entry);
  the entry editor (TipTap rich text, components and repeaters, references, localized fields),
  version history, diff and restore, comments and tasks, metadata, AI assist; import
  (`/content/:typeId/import`) from CSV, JSON or a WordPress export, with a dry-run report before
  anything is written and a resumable job past 10,000 records.
- **Coworker**: the assistant panel in the shell, open from any page; its conversation and any
  confirm card waiting for an answer survive navigation. A page's edit can go through it (the
  exact MCP tool call, no model); when the assistant is off or its socket is down, the page makes
  the edit through the API itself. See
  [AI, agents & search](./ai-agents-and-search.md#coworker-the-admins-assistant).
- **Approvals** (`/approvals`): the editorial workflow task inbox.
- **Releases** (`/releases`): bundle entries and assets, publish as a unit, schedule.
- **Workflows** (`/workflows`, `/workflows/:id`): editorial workflow definitions and the graph
  editor (React Flow), with server-side validation, versions, and AI drafting.
- **Assets** (`/assets`; the old `/media` address redirects): the asset library. A folder tree (all
  assets, those in no folder, nested folders to create, rename, and delete once empty) beside a
  filter bar (kind, status including archived, tag, sort) and a grid or list (the choice is kept
  per browser), paged with the API's cursor. Pick or drop any number of files to upload them into
  the open folder, each with its progress and a live summary ("Uploaded 2 files; 1 failed"), then
  one toast for the batch; select several to move them to a folder, publish them, or archive them
  after an in-place "Archive N assets?" (ids a bulk action fails for stay selected and are named in
  an alert); archive (with Undo) or restore one; delete one, and when entries still link to it the
  screen lists them by title (from the 409's `usage`, five shown, then "and N more"), each a link
  to the entry, and offers to archive it instead. A failed load shows an alert with Retry, and the
  first load shows skeletons. On a phone the folder tree becomes a select of folder paths with its
  actions in a sheet, and the list view stacks as rows. Each asset's sheet holds its alt text,
  focal point, tags and usage. The web build's own files are served from `/_static/` (Vite's
  `build.assetsDir`, cached immutable by `public/_headers`), so nothing under `/assets` is ever a
  static file.
- **Taxonomy** (`/taxonomy`): concept schemes, concepts, tags. Each term shows its slug and how
  many published entries carry it; Edit opens a sheet (`TermEditor`) for its label, slug,
  description and a label per other locale of the space, saving only what changed.
- **Settings**: API keys, roles, OAuth connected apps, webhooks, functions, AI actions, app
  extensions (iframe panels, `ExtensionFrame`), plugins, environments and aliases, branch
  compare/merge, redirects, the space audit log.
- **Redirects** (`/settings/redirects`, `app/cms/components/Redirects.tsx`): the environment's
  redirect set ([Domain model](./domain-model.md#redirects)) as a list with search over source,
  destination and note, an enable switch per row, and an add/edit dialog (source, destination,
  status, locale, note, enabled). Import takes CSV or JSON: _Check_ runs a dry run and reports
  what would be created, updated or left alone, then _Import_ writes it. When the set holds
  chains an alert offers _Collapse chains_. Reading needs `preview:read`; changing anything,
  `content:manage`. The content type dialog has a **URL pattern** field (`/blog/{slug}`), the
  input to slug-change redirects.

### Inline-edit links

The `@contentworker/sdk-web` inline editor links to
`/content/:type/:entryId?field=&locale=&space=&env=` ([SDKs](./sdks.md#inline-editing)). The entry
editor selects the locale tab and focuses that field. If the link names a different space or
environment than the current connection, the editor says so rather than loading: the id either
404s or, if it exists in both, opens the wrong entry looking entirely correct.

### Installing plugins

Settings → Plugins is a consent surface before it is a list ([Plugins](./plugins.md) covers the
model). Installing takes either two files (the manifest and the bundle) or an `https` package URL,
which is inspected first so the screen shows the verified manifest and checksum. Only once the
manifest has been read does the screen ask for anything: what the code will run on, what it is
asking to be able to do (in plain language, one checkbox each, pre-approved as requested so that
the only direction consent can move without a second look is _narrower_), and which of those this
deployment cannot enforce. The plugin lands disabled regardless; the button says so.

The list then shows, per plugin, what it runs on, what it can do (its effective grant), and what it
asked for and did not get. That last column exists because a plugin behaving oddly is usually a
plugin doing without something, and nothing else on the screen would say so.

**Access** opens the same checkboxes in place, as a confirmation under the row. If ticking a box
would grow the grant, the button reads _Approve and disable_ before it is pressed. A plugin flagged
`needsReapproval` shows _Needs review_ instead of a running state. Its only way back on is
**Review access**.

**Upgrade** takes a new manifest and bundle for the same plugin id. Capabilities the installed
version never asked for are marked _New_ and pre-checked. Earlier decisions carry over: a granted
capability stays checked and a declined one stays unchecked. If the upgrade would grow the grant,
the button reads _Upgrade disabled_.

## Testing

```bash
pnpm --filter @contentworker/web test   # vitest: auth, sessions, gateway, lib units
pnpm --filter @contentworker/web e2e    # Playwright in WebKit and Chromium, with axe
```

The e2e suite (`apps/web/e2e`) runs the dev server offline on port 5390 against a fresh local D1
(`.wrangler/e2e`): shell layout on iPhone, iPad and desktop (both orientations), the CMS flows,
space access (`space-access.spec.ts`), OAuth for MCP clients end to end (`oauth.spec.ts`), the
workflow list and editor (`workflows.spec.ts`), an axe WCAG 2.1 A/AA sweep
(`accessibility.spec.ts`; `contrast-settle.spec.ts` checks a re-enabled button is at full opacity
at once, so the sweep cannot catch it mid-fade), and sign-in last (the `auth`
project signs up the first admin, which turns sign-in on). CI runs it in the `devices` job.

Assert accessible names only in Playwright: jsdom names some controls a real browser does not.
