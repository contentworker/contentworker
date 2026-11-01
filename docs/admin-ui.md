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

| Route                                    | What it does                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `/setup`                                 | Redeems the one-time `SETUP_TOKEN` to create an Admin account (`app/lib/setup.server.ts`)    |
| `/login`                                 | Email and password (PBKDF2, peppered with `PASSWORD_PEPPER`)                                 |
| `/login/passkey`, `/account/passkeys`    | Passkeys (WebAuthn)                                                                          |
| `/login/two-factor`                      | TOTP second factor, or a recovery code                                                       |
| `/login/sso`, `/login/sso/callback`, `/login/sso/link` | OpenID Connect single sign-on with the deployment's provider (`app/lib/sso.server.ts`) |
| `/scim/v2/*`                             | SCIM provisioning from the identity provider, with its own bearer token                      |
| `/team`                                  | People, deployment roles (Member, Admin), SSO and SCIM settings (admins)                     |
| `/audit`                                 | The deployment's admin audit log (`admin_audit`, hash-chained)                               |
| `/account`                               | Your password, passkeys, two-factor                                                          |

Sessions, users, passkeys and challenges live in D1 (`0002_auth.sql`). Authenticator secrets are
sealed with `DATA_KEY`. Sign-in paths that need no session, and SCIM, are rate-limited per address
(`API_LIMIT`).

## How screens reach the API

The CMS screens (`app/cms`) call the Management API in the browser with TanStack Query
(`app/cms/lib/management.ts`) on the same origin: `/spaces/...`, `/preview/...`, `/delivery/...`,
`/mcp`, `/media/...`. The web Worker's gateway forwards those to the api with a signed
`x-cw-principal` (60 s, bound to the path) in place of the session cookie, and passes the
`x-cw-bookmark` read-your-writes header both ways. See
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

Settings sections: **Access** (Space access, API keys, Roles, Connected apps), **Automation**
(Webhooks, Functions, AI actions), **Extensions** (App extensions, Plugins), **Workspace**
(Environments, Audit log).

## Features

- **Overview** (`/dashboard`): what needs attention, live activity, AI usage and throughput.
- **Content** (`/content`): content types and their schema editor; entries per type with filters;
  the entry editor (TipTap rich text, components and repeaters, references, localized fields),
  version history, diff and restore, comments and tasks, metadata, AI assist; import
  (`/content/:typeId/import`) from CSV, JSON or a WordPress export, with a dry-run report before
  anything is written and a resumable job past 10,000 records.
- **Approvals** (`/approvals`): the editorial workflow task inbox.
- **Releases** (`/releases`): bundle entries and assets, publish as a unit, schedule.
- **Workflows** (`/workflows`, `/workflows/:id`): editorial workflow definitions and the graph
  editor (React Flow), with server-side validation, versions, and AI drafting.
- **Assets** (`/assets`; the old `/media` address redirects): the asset library. A folder tree (all
  assets, those in no folder, nested folders to create, rename, and delete once empty) beside a
  filter bar (kind, status including archived, tag, sort) and a grid or list (the choice is kept
  per browser), paged with the API's cursor. Pick or drop any number of files to upload them into
  the open folder, each with its progress; select several to move them to a folder, publish or
  archive them; archive (with Undo) or restore one; delete one, and when entries still link to it
  the screen lists them, each a link to the entry, and offers to archive it instead. Each asset's
  sheet holds its alt text, focal point, tags and usage.
- **Taxonomy** (`/taxonomy`): concept schemes, concepts, tags.
- **Settings**: API keys, roles, OAuth connected apps, webhooks, functions, AI actions, app
  extensions (iframe panels, `ExtensionFrame`), plugins, environments and aliases, branch
  compare/merge, the space audit log.

## Testing

```bash
pnpm --filter @contentworker/web test   # vitest: auth, sessions, gateway, lib units
pnpm --filter @contentworker/web e2e    # Playwright in WebKit and Chromium, with axe
```

The e2e suite (`apps/web/e2e`) runs the dev server offline on port 5390 against a fresh local D1
(`.wrangler/e2e`): shell layout on iPhone, iPad and desktop (both orientations), the CMS flows,
space access, an axe WCAG 2.1 A/AA sweep (`accessibility.spec.ts`), and sign-in last (the `auth`
project signs up the first admin, which turns sign-in on). CI runs it in the `devices` job.

Assert accessible names only in Playwright: jsdom names some controls a real browser does not.
