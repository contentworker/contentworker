# Developer tooling: the CLI and agent skills

How `packages/cli` (`@contentworker/cli`, the `contentworker` command) and the developer skills in
`skills/` are built, tested and published. The user-facing pages are
https://docs.contentworker.app/guides/cli/ and https://docs.contentworker.app/guides/agent-skills/.

## Two kinds of skill

| Folder                  | For                                                    | Served                                                  |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| `packages/http/skills/` | An agent working _in_ a workspace through MCP tools    | Embedded and served by the MCP server ([MCP](./mcp.md)) |
| `skills/`               | A coding agent building _on_ a workspace: SDKs and CLI | Installed by developers from this repo                  |
| `.claude/skills/`       | Agents changing ContentWorker itself                   | This repo's Claude Code toolkit                         |

The `skills/` ones follow the open `SKILL.md` format: frontmatter with only `name` (the folder
name) and `description` (what it covers and "Use when …"), a body under 500 lines, and detail in
`references/` linked from it.

## The CLI

`packages/cli/src`:

| File             | Holds                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `bin.ts`         | The entry: `run(process.argv.slice(2), processIo())`                                                                            |
| `run.ts`         | Argument parsing (`node:util` `parseArgs`, strict), dispatch, `--json`, errors to exit codes, help                              |
| `commands.ts`    | `COMMANDS`, the registry: each command's name, options and handler. Help and the skills test read it                            |
| `session.ts`     | Which token and target a command uses: `CONTENTWORKER_TOKEN`, else the stored profile, refreshed when within a minute of expiry |
| `oauth.ts`       | The RFC 8628 device flow against the api's authorization server: discovery, registration, polling, refresh, revocation          |
| `credentials.ts` | `credentials.json` in the user config dir, written 0600 in a 0700 directory, atomically (temp file and rename)                  |
| `model.ts`       | Model files (JSON or a TypeScript module), normalization, and the plan `model apply` shows                                      |
| `blocks.ts`      | Blocks files (`contentworker.blocks.json`, or a JSON/TS/JS module) and the change `blocks push` prints                         |
| `io.ts`          | `Io`: process, fetch, clock, config dir and prompt, injected so tests run without a network or a terminal                       |

Design points:

- **Built on `@contentworker/sdk-management`**, with `@contentworker/sdk-codegen` for `types`.
  `types` types the blocks from the catalog in force (`cma.blockCatalog.get()`, a 404 meaning none
  yet, when the variants are used), or from the blocks file `--blocks` names (read like `blocks
  push` reads one).
  Both are dev dependencies that tsup bundles into `dist/bin.js`, so the published package has no
  runtime dependencies. Runs on Node 24+, not workerd.
- **Login is the MCP device flow.** The CLI registers itself as a public client
  (`grant_types: [device_code, refresh_token]`, no redirect), reusing the client id on the next
  login, and polls `/oauth/token` at the server's `interval`, five seconds more after each
  `slow_down`. The token is a space-bound API key with `issuance: 'oauth'`, capped by the
  approver's role and the OAuth scope ceiling, which excludes `space:admin` and `content:manage`.
  So `model apply` needs a Management key or personal access token (`login --token`, or
  `CONTENTWORKER_TOKEN`). The space comes from `GET /auth/me`.
- **Output contract.** `--json` prints exactly one JSON document on stdout; everything else goes
  to stderr (the device code as a JSON line, plans, errors as `{ error: { code, message, status?,
  details? } }`). Exit codes: 0 ok, 1 failure, 2 usage or confirmation needed, 3 auth, 4 a
  destructive change refused. They are part of the interface the skills rely on.
- **No prompts off a terminal.** `Io.interactive` is true only when stdin and stdout are TTYs;
  otherwise a write that would ask (`model apply`, `blocks push`, `import`) needs `--yes` or exits 2.
- **`model apply` plans before it writes.** `planModel` compares normalized drafts with
  `GET …/content-types`: removing a field or block variant at any depth, and changing `type`,
  `linkType`, `localized` or `items.type`/`items.linkType`, are destructive and need
  `--allow-destructive`. It upserts through `POST …/content-types` (an existing apiId is revised)
  held to the version the plan read (`expectedVersion`, 0 for a new type: a save someone made
  after the plan was shown is a `409`, and a re-run plans again) and publishes each type, so the
  server's own guard (`assertNoRemovedContentInUse`) still has the last word on removals. Types
  not in the file are reported, never deleted (there is no delete route).
- **`blocks push` lets the server plan.** It reads the blocks file (`loadBlocks`), sends it to
  `POST …/block-catalog` with `dryRun: true`, prints the result (`renderPush`), refuses (exit 4)
  when `inUse` is non-empty (`blocks_in_use`) or the push is destructive without
  `--allow-destructive` (`destructive_change`), confirms, then pushes with `expectedVersion` set to
  the dry run's `previousVersion`, so a push landing in between is a `409`, not an overwrite.
  `--no-publish` sends `publish: false`. `model apply`'s plan reads a variant whose `aliases` hold a
  removed apiId as a rename, not a destructive removal.
- **`blocks push` imports URL and file thumbnails (`thumbnails.ts`).** The admin draws only
  `{ assetId }` thumbnails (its `img-src` is its own origin), so before the dry run `planThumbnails`
  reads each `{ url }` (https only, no credentials, a redirect must stay https; 30 s timeout) and
  each `{ file }` (a path from the blocks file's folder), each source once. It refuses
  (`thumbnail_refused`, naming `blocks[id].thumbnail`) anything over `MAX_THUMBNAIL_BYTES` (2 MiB,
  checked against `content-length` and while streaming), a non-2xx answer, or a type outside
  AVIF, GIF, JPEG, PNG, SVG and WebP (the response's `content-type`; a file's extension). It hashes
  each image (SHA-256) and looks it up with `GET …/assets?contentHash=&kind=image` (archived left
  out, oldest first): a hit is reused. Nothing is uploaded until the plan passes its refusals and is
  confirmed; then each image no asset holds is uploaded once, as a draft named
  `<block>-thumbnail.<ext>`, and the push sends `{ assetId }`. The dry run's plan carries a pending
  URL as `{ url }` and a pending file as no thumbnail. Dedupe rides on ingest's `contentHash`, which
  lands seconds after an upload: a second push inside that window uploads a copy, which ingest marks
  `duplicateOf` the first. The server never fetches a thumbnail, and still accepts `{ url }` from
  other clients; the admin just doesn't draw it.
- **`entries list`** reads Preview (`GET /preview/:space/:env/entries`), since the Management API
  has no entry list; `entries update` merges by field and locale before the `PUT`, because the API
  replaces the whole draft.
- **`import`** always analyzes first and stops if the plan isn't executable; `--job` uses the
  durable import job. The payload is sent as a string, so the api's body cap (`MAX_BODY_BYTES`,
  5 MiB by default) bounds the file.
- **`doctor`** checks credentials file permissions, the session, `GET /health`, the API version
  (`info.version` of `/openapi.json` against `API_VERSION` in `commands.ts`; same major, and same
  minor while 0.x), `GET /auth/me` and a read of the space's content types.

When the API's `info.version` changes in `packages/http/src/api/docs/openapi.ts`, update
`API_VERSION` in `packages/cli/src/commands.ts` in the same change.

## Tests

| Suite                                | Proves                                                                                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/test/auth.test.ts`     | Device-flow polling (interval, `slow_down`, deny, expiry), token file and directory modes, refresh and rotation, `CONTENTWORKER_TOKEN`, logout and revocation                          |
| `packages/cli/test/model.test.ts`    | The plan (safe and destructive changes, nested components and block variants), JSON and TS model files, dry run, refusal, `--yes`, partial failure                                     |
| `packages/cli/test/commands.test.ts` | Each command's request and `--json` shape, merge on update, bulk publish, import flow, doctor, exit codes                                                                              |
| `packages/cli/test/skills.test.ts`   | Every skill's frontmatter, and that each `contentworker` command and flag, `client.`/`cma.` method, SDK import, docs link and anchor, and relative link in `skills/` exists            |
| `packages/http/test/api/cli.test.ts` | The CLI against the in-process api: device flow approved by a signed-in person, the 403 for a model change over OAuth, model round trip, entries, CSV import and re-run, types, doctor |

The unit suites use a scripted fake server (`packages/cli/test/harness.ts`) whose `sleep` advances
the clock, so no test waits. `packages/cli/turbo.json` adds `skills/`, the docs content and the SDK
sources to the test task's inputs, so editing a skill reruns its check.

## Publishing

- **The CLI** ships inside `@contentworker/sdk` as its `contentworker` binary
  (`packages/sdk/sdk/src/bin.ts`, bundled to `dist/bin.js`); `@contentworker/cli` itself stays a
  private workspace package. See [SDKs](./sdks.md) for the release.
- **The skills** install straight from this repository with the open `skills` CLI
  (`npx skills add contentworker/contentworker@<skill>`), or by copying `skills/*` into a
  project's `.claude/skills/`. A separate repository (for example `contentworker/skills`) would
  give a smaller clone and a listing of its own; it would be a copy of `skills/` pushed by CI on
  release, never edited by hand, so the drift test here stays the gate.
