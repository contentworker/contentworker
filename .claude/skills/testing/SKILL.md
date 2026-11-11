---
name: testing
description: How ContentWorker is tested, where a new test goes, and how to run one package, one file or one test. Covers each package's vitest environment (packages/db and apps/engine in workerd via @cloudflare/vitest-plugin; packages/http, application, domain and adapters in node; apps/web's node and jsdom projects), the D1 contract tests, the engine's real Durable Objects and Workflows, the Playwright device and axe tests in apps/web/e2e (WebKit and Chromium projects), the fleet and DO-migration golden tests and the toolkit tests. Preloaded by the test-engineer agent; use it when writing, fixing, de-flaking or choosing where to put a test, or to run a narrow slice of the suite.
argument-hint: "[package] [file.test.ts | -t 'test name']"
---

# Testing ContentWorker

`docs/development.md` describes the workspace commands; this page is the part you need every time
you add or run a test. Read the neighbouring tests before writing one, and reuse their helpers.

## Where a test goes

| Change in                                                        | Test in                                                     | Runs in                          |
| ---------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------- |
| `packages/domain/src/**`                                         | `packages/domain/test/<capability>.test.ts`                 | node                             |
| `packages/application/src/<capability>.ts`                       | `packages/application/test/<capability>.test.ts`, test-kit  | node                             |
| `packages/ports` / `packages/test-kit` (a store behaviour)       | `packages/db/test/store*.test.ts` (contract) + application  | workerd (D1) + node              |
| `packages/db/src/**`, `packages/db/migrations/*`                 | `packages/db/test/*.test.ts`                                | workerd, Miniflare D1            |
| `packages/http/src/api/**`                                       | `packages/http/test/api/*.test.ts`                          | node, `app.request()` on fakes   |
| `packages/http/src/mcp/**`                                       | `packages/http/test/mcp/*.test.ts`, `test/mcp.test.ts`       | node, in-memory MCP transport    |
| `packages/adapters/src/<name>/`                                  | `packages/adapters/test/<name>/`                            | node, binding stubbed            |
| `packages/platform/src/do/*`, `apps/engine/src/workflows/*`      | `apps/engine/test/*.test.ts` (fixture worker)               | workerd, real DOs and Workflows  |
| `apps/delivery/src/**` (profiles, canonical URLs, purge)          | `apps/delivery/test/*.test.ts`                              | node                             |
| `apps/web/app/lib/**`, server code                               | `apps/web/tests/*.test.ts` (project `node`)                 | node                             |
| `apps/web/app/cms/**`, components and screens                     | `apps/web/tests/*.test.tsx` (project `dom`)                 | jsdom + Testing Library          |
| A route, flow, layout or accessibility in the admin              | `apps/web/e2e/*.spec.ts`                                    | Playwright, WebKit and Chromium  |
| `packages/design/src/tokens.ts` / `apps/web/app/app.css`          | `packages/design/tests/tokens.test.ts`                      | node                             |
| `docs/*.md`, `packages/http/skills/**`                           | drift tests in `packages/docs/test`, `packages/http/test`   | node                             |
| `examples/fleet/`, `scripts/*.ts`, DO migration tags, the catalog    | `scripts/*.test.ts` (`pnpm test:fleet`)                     | `node --test`                    |
| `.claude/` hooks and toolkit                                     | `.claude/hooks/tests/*.test.sh` (`pnpm test:toolkit`)       | bash                             |

## Running a slice

Use the narrowest form; add the `@contentworker/` prefix when given a bare package name.

```bash
pnpm --filter @contentworker/<pkg> test                         # one package
pnpm --filter @contentworker/<pkg> test -- <file>.test.ts       # one file
pnpm --filter @contentworker/<pkg> test -- -t 'name of test'    # one test by name
pnpm --filter @contentworker/web exec vitest run --project dom  # one apps/web project
pnpm test:fleet                                                 # node --test scripts/*.test.ts
pnpm test:toolkit                                               # .claude toolkit
pnpm test                                                       # everything, through turbo
```

Workspace SDKs are `@contentworker/sdk-<name>` (`sdk-core`, `sdk-management`, …); the published
`@contentworker/sdk` (`packages/sdk/sdk`) re-exports them, and `node scripts/sdk-packages.ts pack &&
node scripts/sdk-packages.ts check` tests its tarball. `@contentworker/api` has no
test target: its surface is tested in `@contentworker/http`.

## The workerd suites

- **`packages/db`**: `vitest.config.ts` reads `packages/db/migrations` with `readD1Migrations` and
  `test/setup.ts` applies them to a fresh Miniflare D1 per file, so a new migration is proven to
  apply after the others. Files share a database across their tests: give each test its own ids.
  A test that touches a list must cross the 100-parameter cap.
- **`apps/engine`**: `test/fixtures/worker.ts` exports only the classes under test (`LiveHubDO`,
  `RateLimiterDO`, `CostGuardDO`, `SearchShardDO`, the editorial workflow host over
  `test/fixtures/editorial.ts`), so the module graph stays free of queue and AI adapters. Limits are
  shrunk in the config's `bindings` (`AUTH_RATE_LIMIT_MAX`, `AI_MAX_REQUESTS_PER_WINDOW`, …). A new
  DO class or Workflow is added to the fixture and to `durableObjects` / `workflows` there.
- Both pin `compatibilityDate` to production's (`apps/engine/wrangler.jsonc`).

## Device and accessibility tests (apps/web/e2e)

`apps/web/playwright.config.ts` boots the dev server offline (`CONTENTWORKER_E2E=1`: no remote
bindings, a fresh local D1 under `.wrangler/e2e`, mock AI). Projects: `shell.spec.ts` in WebKit on
iPhone, iPad (both orientations) and desktop Safari; the CMS specs (`cms`, `workflows`,
`space-access`, `accessibility`, `contrast-settle`) in Desktop Chrome with the axe WCAG 2.1 A/AA
sweep; `login.spec.ts` (`auth`) last, in Chromium, because signing up the first admin turns
sign-in on.

1. Browsers once: `pnpm --filter @contentworker/web exec playwright install webkit chromium`.
2. Run: `pnpm --filter @contentworker/web e2e` (or `-- <spec> --project cms`). The port derives
   from the checkout, so worktrees can run at once; a server already on it fails the run
   (`E2E_REUSE=1` opts in to reusing your own). Shared content types go through `saveContentType`
   (`e2e/cms.ts`), never a bare POST that two workers can race. Run it in the
   background if it may exceed two minutes; never leave a server running after.
3. On a failure, read `apps/web/test-results/**/error-context.md` and the failing step's console
   before theorising. A thrown page error is an app bug. axe violations: report the rule id, the
   target selector and the component that renders it (often a Radix control in a `<label>` with no
   `aria-label`; jsdom can't see that, only the sweep can).
   Tag (`@coworker` at the end of the title) any test that raises or answers a card in Coworker's
   panel: the conversation is one person's and shared by every page in open local development, so
   such tests run alone in the `coworker` project (after `cms`, same CI part). `--project=coworker`
   alone needs `--no-deps`.
4. A new screen or dialog gets a scan in `accessibility.spec.ts`.

## Rules

- Name a test file for the capability under test (`releases.test.ts`), never a roadmap phase.
- **Test the second run**: a redelivered queue message, a retried step, a lost
  `TransactionConflictError` race, an expired or forged `x-cw-principal`, a reused token.
- **Test isolation**: data written under one `Scope` is invisible under another.
- **Never edit a golden value** in `scripts/do-migrations.test.ts` or `scripts/fleet.test.ts` to
  make a test pass; a failing golden test means the change is wrong.
- No sleeps to make a test pass: disable or force the wait. A "flaky" e2e is a real race until the
  trace proves otherwise; never add retries or `waitForTimeout`.
- Use `@contentworker/test-kit` fakes in node suites; no network, no Cloudflare account.

## Report

Pass or fail per command, with the failing output verbatim.
