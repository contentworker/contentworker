#!/bin/bash
# Pipes realistic hook input into the guard, format, rules and session hooks and checks what they
# say. Run from the repo root:
#   .claude/hooks/tests/guard-hooks.test.sh
# Cases that depend on git state (an applied migration, being on main) run against a throwaway
# repo with its own origin, so they never read this checkout's branch or history.
set -u
root=$(cd "$(dirname "$0")/../../.." && pwd)
hooks="$root/.claude/hooks"
export TMPDIR=$(mktemp -d)
fail=0
check() { # name, expected substring ('' = expect silence), actual
  if [ -z "$2" ]; then
    [ -z "$3" ] && echo "ok   $1" || { echo "FAIL $1: expected silence, got: $3"; fail=1; }
  else
    case "$3" in *"$2"*) echo "ok   $1" ;; *) echo "FAIL $1: expected '$2', got: $3"; fail=1 ;; esac
  fi
}
DENY='"permissionDecision":"deny"'
ASK='"permissionDecision":"ask"'

# A throwaway repo on a feature branch, with origin/main holding one applied migration.
repo="$TMPDIR/repo"
mkdir -p "$repo/packages/db/migrations" "$repo/apps/engine"
git -C "$repo" init -q -b main
git -C "$repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
echo 'CREATE TABLE a (id TEXT);' >"$repo/packages/db/migrations/0001_init.sql"
# And an engine config whose two Durable Object migrations are applied.
cat >"$repo/apps/engine/wrangler.jsonc" <<'JSONC'
{
  "name": "contentworker-engine",
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["LiveHubDO"] },
    // Sign-in throttling.
    { "tag": "v2", "new_sqlite_classes": ["RateLimiterDO"] }
  ],
  "vars": { "A": "1" }
}
JSONC
git -C "$repo" add -A && git -C "$repo" -c user.email=t@t -c user.name=t commit -q -m applied
git -C "$repo" update-ref refs/remotes/origin/main HEAD
git -C "$repo" checkout -q -b feat/x

# ── guard-bash: deploys denied, risky things asked, the rest silent ───────────
bash_in() { jq -cn --arg c "$1" --arg d "${2:-$repo}" '{session_id:"g",cwd:$d,tool_input:{command:$c}}' | "$hooks/guard-bash.sh"; }
check "pnpm deploy is denied" "$DENY" "$(bash_in 'pnpm deploy')"
check "a workspace deploy script is denied" "$DENY" "$(bash_in 'pnpm --filter @contentworker/engine run deploy')"
check "the docs deploy is denied" "$DENY" "$(bash_in 'pnpm docs:deploy')"
check "wrangler deploy chained after a test is denied" "$DENY" "$(bash_in 'pnpm test && pnpm --filter @contentworker/web exec wrangler deploy')"
check "npx wrangler versions deploy is denied" "$DENY" "$(bash_in 'npx wrangler versions deploy')"
check "wrangler deploy --dry-run=false is denied" "$DENY" "$(bash_in 'npx wrangler deploy --dry-run=false')"
check "a dry run chained before a real deploy is denied" "$DENY" "$(bash_in 'npx wrangler deploy --dry-run && npx wrangler deploy')"
check "wrangler rollback is denied" "$DENY" "$(bash_in 'wrangler rollback -y')"
check "remote migrations are denied" "$DENY" "$(bash_in 'wrangler d1 migrations apply DB --remote --config wrangler.contentworker.json')"
check "the remote migrate script is denied" "$DENY" "$(bash_in 'pnpm --filter @contentworker/web db:migrate:remote')"
check "a Time Travel restore is denied" "$DENY" "$(bash_in 'wrangler d1 time-travel restore DB --bookmark=x')"
check "deleting a queue is denied" "$DENY" "$(bash_in 'wrangler queues delete contentworker-purge')"
check "remote D1 SQL asks" "$ASK" "$(bash_in "wrangler d1 execute DB --remote --command 'select 1'")"
check "a Worker secret asks" "$ASK" "$(bash_in 'echo x | wrangler secret put DATA_KEY')"
check "the deploy script is denied" "$DENY" "$(bash_in './scripts/deploy.sh')"
check "the deploy script through bash is denied" "$DENY" "$(bash_in 'bash scripts/deploy.sh')"
check "pnpm cw:deploy is denied" "$DENY" "$(bash_in 'pnpm cw:deploy')"
check "pnpm run cw:deploy is denied" "$DENY" "$(bash_in 'pnpm run cw:deploy --env-file .env.second')"
check "pnpm cw:deploy chained after a test is denied" "$DENY" "$(bash_in 'pnpm test && pnpm cw:deploy')"
check "the deploy script with an env prefix is denied" "$DENY" "$(bash_in 'CONTENTWORKER_DEPLOY=1 scripts/deploy.sh')"
check "the deploy script by absolute path is denied" "$DENY" "$(bash_in '/tmp/w/scripts/deploy.sh')"
check "the deploy script through xargs is denied" "$DENY" "$(bash_in 'echo .env | xargs scripts/deploy.sh --env-file')"
check "the deploy script inside bash -c is denied" "$DENY" "$(bash_in 'bash -c "scripts/deploy.sh --env-file .env"')"
check "the deploy script after cd is denied" "$DENY" "$(bash_in 'cd scripts && ./deploy.sh')"
check "the deploy script in a subshell is denied" "$DENY" "$(bash_in '(scripts/deploy.sh)')"
check "the deploy script with a redirect is denied" "$DENY" "$(bash_in 'scripts/deploy.sh>/tmp/log')"
check "the deploy test is allowed" "" "$(bash_in 'node --test scripts/deploy.test.ts')"
check "linting the deploy script is allowed" "" "$(bash_in 'shellcheck scripts/deploy.sh')"
check "reading the deploy script is allowed" "" "$(bash_in 'sed -n 1,20p scripts/deploy.sh')"
check "syntax-checking the deploy script is allowed" "" "$(bash_in 'bash -n scripts/deploy.sh')"
check "the setup script asks" "$ASK" "$(bash_in './scripts/setup.sh')"
check "the setup script with flags asks" "$ASK" "$(bash_in 'scripts/setup.sh --env-file .env --github')"
check "pnpm cw:setup asks" "$ASK" "$(bash_in 'pnpm cw:setup')"
check "pnpm run cw:setup asks" "$ASK" "$(bash_in 'pnpm run cw:setup -- --github')"
check "a new setup code asks" "$ASK" "$(bash_in 'pnpm cw:setup-code')"
check "the setup-code script asks" "$ASK" "$(bash_in './scripts/setup-code.sh --env-file .env')"
check "reading the setup script is allowed" "" "$(bash_in 'sed -n 1,20p scripts/setup.sh')"
check "linting the setup script is allowed" "" "$(bash_in 'shellcheck scripts/setup.sh scripts/setup-code.sh')"
check "the install names are allowed" "" "$(bash_in 'node scripts/install.ts names --env-file .env')"
check "merging a PR asks" "$ASK" "$(bash_in 'gh pr merge 151 --squash')"
check "pushing main asks" "$ASK" "$(bash_in 'git push origin main')"
check "pushing HEAD:main asks" "$ASK" "$(bash_in 'git push origin HEAD:main')"
check "a force push asks" "$ASK" "$(bash_in 'git push --force origin feat/x')"
check "a +refspec push asks" "$ASK" "$(bash_in 'git push origin +feat/x')"
check "pushing a feature branch is allowed" "" "$(bash_in 'git push -u origin feat/x')"
check "local migrations are allowed" "" "$(bash_in 'pnpm --filter @contentworker/engine exec wrangler d1 migrations apply DB --local')"
check "wrangler dev is allowed" "" "$(bash_in 'pnpm --filter @contentworker/engine exec wrangler dev')"
check "wrangler deploy --dry-run is allowed" "" "$(bash_in 'npx wrangler deploy --dry-run --outdir /tmp/x')"
check "a dry run with the flag last is allowed" "" "$(bash_in 'cd apps/engine && npx wrangler deploy --outdir dist --dry-run')"
check "a dry run through pnpm exec is allowed" "" "$(bash_in 'pnpm --filter @contentworker/api exec wrangler deploy --dry-run --outdir /tmp/x')"
check "a real deploy through pnpm exec is denied" "$DENY" "$(bash_in 'pnpm --filter @contentworker/api exec wrangler deploy')"
check "wrangler types is allowed" "" "$(bash_in 'pnpm --filter @contentworker/web types')"
check "a test named deploy is allowed" "" "$(bash_in 'pnpm test -- deploy.test.ts')"
check "wrangler preview is denied" "$DENY" "$(bash_in 'pnpm --filter @contentworker/api exec wrangler preview')"
check "a version upload is denied" "$DENY" "$(bash_in 'npx wrangler versions upload')"
check "a version upload dry run is allowed" "" "$(bash_in 'npx wrangler versions upload --dry-run --outdir /tmp/x')"
check "a triggers deploy is denied" "$DENY" "$(bash_in 'wrangler triggers deploy')"
check "a global flag before deploy is denied" "$DENY" "$(bash_in 'wrangler -c apps/api/wrangler.x.json deploy')"
check "a --config= flag before deploy is denied" "$DENY" "$(bash_in 'wrangler --config=apps/api/x.json deploy')"
check "a version-pinned deploy is denied" "$DENY" "$(bash_in 'npx wrangler@4 deploy')"
check "a version-pinned remote migration is denied" "$DENY" "$(bash_in 'pnpm dlx wrangler@4 d1 migrations apply DB --remote')"
check "a deploy inside bash -c is denied" "$DENY" "$(bash_in 'bash -c "pnpm --filter @contentworker/api exec wrangler deploy"')"
check "node wrangler.js deploy is denied" "$DENY" "$(bash_in 'node node_modules/wrangler/bin/wrangler.js deploy')"
check "a deploy with --env after the subcommand is denied" "$DENY" "$(bash_in 'wrangler deploy --env staging')"
check "a versions secret asks" "$ASK" "$(bash_in 'wrangler versions secret put FOO')"
check "sed -i on an applied migration is denied" "$DENY" "$(bash_in 'sed -i s/a/b/ packages/db/migrations/0001_init.sql')"
check "appending to an applied migration is denied" "$DENY" "$(bash_in 'echo x >> packages/db/migrations/0001_init.sql')"
check "deleting an applied migration is denied" "$DENY" "$(bash_in 'rm packages/db/migrations/0001_init.sql')"
check "reading an applied migration is allowed" "" "$(bash_in 'cat packages/db/migrations/0001_init.sql')"
check "copying an applied migration out is allowed" "" "$(bash_in 'cat packages/db/migrations/0001_init.sql > /tmp/x')"
check "tee onto an applied migration is denied" "$DENY" "$(bash_in 'echo x | tee -a ./packages/db/migrations/0001_init.sql')"
check "writing a new migration is allowed" "" "$(bash_in 'echo x > packages/db/migrations/0002_new.sql')"
check "wrangler dev with a config flag is allowed" "" "$(bash_in 'wrangler -c apps/api/wrangler.jsonc dev')"
check "re-running failed jobs is allowed" "" "$(bash_in 'gh run rerun 123 --failed')"
git -C "$repo" checkout -q main
check "a bare push on main asks" "$ASK" "$(bash_in 'git push')"
check "pushing another branch from main is allowed" "" "$(bash_in 'git push origin feat/x')"
git -C "$repo" checkout -q feat/x
check "a bare push on a branch is allowed" "" "$(bash_in 'git push')"

# ── guard-invariants: applied migrations, vendored fixtures, z routes ─────────
edit_in() { jq -cn --arg f "$1" --arg t "${2:-x}" '{session_id:"g",tool_input:{file_path:$f,new_string:$t}}' | "$hooks/guard-invariants.sh"; }
write_in() { jq -cn --arg f "$1" --arg t "$2" '{session_id:"g",tool_input:{file_path:$f,content:$t}}' | "$hooks/guard-invariants.sh"; }
check "an applied migration is denied" "$DENY" "$(edit_in "$repo/packages/db/migrations/0001_init.sql")"
check "a new migration is allowed" "" "$(write_in "$repo/packages/db/migrations/0002_next.sql" 'ALTER TABLE a ADD COLUMN b TEXT;')"
check "a new migration that drops a column asks" "$ASK" "$(write_in "$repo/packages/db/migrations/0002_next.sql" 'ALTER TABLE a DROP COLUMN b;')"
check "a new migration that renames a table asks" "$ASK" "$(write_in "$repo/packages/db/migrations/0002_next.sql" 'ALTER TABLE a RENAME TO b;')"
check "a migration whose comment says drop is allowed" "" "$(write_in "$repo/packages/db/migrations/0002_next.sql" '-- nothing to drop here
CREATE INDEX IF NOT EXISTS a_id ON a (id);')"
check "a schema.ts edit is allowed" "" "$(edit_in "$root/packages/db/src/schema.ts" "x")"
check "the frozen Durable Object migrations ask" "$ASK" "$(edit_in "$root/scripts/do-migrations.test.ts")"
# Durable Object migrations: an Edit is applied to the file before comparing with origin/main.
wr="$repo/apps/engine/wrangler.jsonc"
replace_in() { jq -cn --arg f "$1" --arg o "$2" --arg n "$3" '{session_id:"g",tool_input:{file_path:$f,old_string:$o,new_string:$n}}' | "$hooks/guard-invariants.sh"; }
v2='{ "tag": "v2", "new_sqlite_classes": ["RateLimiterDO"] }'
check "appending a Durable Object migration is allowed" "" "$(replace_in "$wr" "$v2" "$v2,
    { \"tag\": \"v3\", \"new_sqlite_classes\": [\"CostGuardDO\"] }")"
check "an unrelated edit to wrangler.jsonc is allowed" "" "$(replace_in "$wr" '"A": "1"' '"A": "2"')"
check "reformatting an applied migration is allowed" "" "$(replace_in "$wr" "$v2" '{"tag":"v2","new_sqlite_classes":["RateLimiterDO"]}')"
check "changing an applied migration asks" "$ASK" "$(replace_in "$wr" '["LiveHubDO"]' '["LiveHubDO", "Other"]')"
check "renaming an applied tag asks" "$ASK" "$(replace_in "$wr" '"tag": "v1"' '"tag": "v0"')"
check "removing an applied migration asks" "$ASK" "$(replace_in "$wr" ",
    // Sign-in throttling.
    $v2" '')"
check "inserting before an applied migration asks" "$ASK" "$(replace_in "$wr" '"migrations": [' '"migrations": [
    { "tag": "v0", "new_sqlite_classes": ["First"] },')"
check "a deleted class asks" "$ASK" "$(replace_in "$wr" "$v2" "$v2,
    { \"tag\": \"v3\", \"deleted_classes\": [\"RateLimiterDO\"] }")"
check "a renamed class asks" "$ASK" "$(replace_in "$wr" "$v2" "$v2,
    { \"tag\": \"v3\", \"renamed_classes\": [{ \"from\": \"RateLimiterDO\", \"to\": \"Limiter\" }] }")"
check "a Write without the applied migrations asks" "$ASK" "$(write_in "$wr" '{ "name": "contentworker-engine", "migrations": [] }')"
mkdir -p "$repo/apps/new"
check "a new app's migrations are allowed" "" "$(write_in "$repo/apps/new/wrangler.jsonc" '{ "migrations": [
  { "tag": "v1", "new_sqlite_classes": ["A"] }
] }')"
check "a new app's deleted class asks" "$ASK" "$(write_in "$repo/apps/new/wrangler.jsonc" '{ "migrations": [
  { "tag": "v1", "deleted_classes": ["A"] }
] }')"
check "a /healthz route is denied" "$DENY" "$(edit_in "$root/apps/web/app/routes.ts" "fetch('/healthz')")"
check "a /readyz route in a new file is denied" "$DENY" "$(write_in "$root/packages/http/src/api/new.ts" "app.get('/readyz', (c) => c.text('ok'))")"
check "a MultiEdit adding /livez is denied" "$DENY" "$(jq -cn --arg f "$root/apps/web/app/x.ts" '{tool_input:{file_path:$f,edits:[{new_string:"ok"},{new_string:"fetch(\"/livez\")"}]}}' | "$hooks/guard-invariants.sh")"
check "/health is allowed" "" "$(edit_in "$root/packages/http/src/api/app.ts" "app.get('/health', (c) => c.text('ok'))")"
check "a word ending in z is allowed" "" "$(edit_in "$root/apps/web/app/x.ts" "'/quiz'")"
check "CLAUDE.md may name the rule" "" "$(edit_in "$root/CLAUDE.md" 'not `/healthz`')"
check "AGENTS.md may name the rule" "" "$(edit_in "$root/AGENTS.md" 'not `/healthz`')"

# ── rules-impact: path rules, once per file per session ───────────────────────
rules_in() { jq -cn --arg s "$1" --arg f "$2" '{session_id:$s,tool_input:{file_path:$f}}' | "$hooks/rules-impact.sh"; }
check "publishing.ts names the unit of work" "TransactionConflictError" "$(rules_in r1 "$root/packages/application/src/publishing.ts")"
check "publishing.ts also gets both surfaces" "packages/http/src/mcp/tools" "$(rules_in r2 "$root/packages/application/src/publishing.ts")"
check "a second edit of the same file is quiet" "" "$(rules_in r2 "$root/packages/application/src/publishing.ts")"
check "a wrangler config names install.ts" "scripts/install.ts" "$(rules_in r3 "$root/apps/engine/wrangler.jsonc")"
check "the principal asks for a security review" "security-reviewer" "$(rules_in r4 "$root/packages/security/src/principal.ts")"
check "the D1 store names the parameter cap" "100 parameters" "$(rules_in r5 "$root/packages/db/src/store.ts")"
check "a workflow names step.do" "step.do" "$(rules_in r8 "$root/apps/engine/src/workflows/editorial-workflow.ts")"
check "a migration names schema.ts" "packages/db/src/schema.ts" "$(rules_in r9 "$root/packages/db/migrations/0001_init.sql")"
check "an uncovered file is quiet" "" "$(rules_in r6 "$root/packages/telemetry/src/index.ts")"
check "a file outside any repo is quiet" "" "$(rules_in r7 /etc/hosts)"

# ── format: Biome fixes what it can, reports what it can't ────────────────────
if [ -x "$root/node_modules/.bin/biome" ]; then
  fmt="$root/packages/domain/src/__fmt_probe.ts"
  printf 'export const a = {b:1}\n' >"$fmt"
  check "formatting a fixable file is quiet" "" "$(jq -cn --arg f "$fmt" '{tool_input:{file_path:$f}}' | "$hooks/format.sh")"
  check "and the file is formatted" "export const a = { b: 1 };" "$(cat "$fmt")"
  printf 'import { x } from "./nowhere";\nexport const a = 1;\n' >"$fmt"
  check "an unused import is reported" "Biome left errors" "$(jq -cn --arg f "$fmt" '{tool_input:{file_path:$f}}' | "$hooks/format.sh")"
  rm -f "$fmt"
else
  echo "skip format: node_modules/.bin/biome not installed"
fi
check "a non-code file isn't formatted" "" "$(jq -cn --arg f "$root/README.md" '{tool_input:{file_path:$f}}' | "$hooks/format.sh")"

# ── guard-invariants: every dependency version comes from the pnpm catalog ─────
mkdir -p "$repo/packages/foo"
printf '{\n  "name": "@contentworker/foo",\n  "version": "0.0.0",\n  "dependencies": {\n    "hono": "catalog:"\n  }\n}\n' >"$repo/packages/foo/package.json"
pkg_edit() { jq -cn --arg f "$repo/packages/foo/package.json" --arg o "$1" --arg n "$2" '{session_id:"g",tool_input:{file_path:$f,old_string:$o,new_string:$n}}' | "$hooks/guard-invariants.sh"; }
check "a dependency with its own version is denied" "$DENY" "$(pkg_edit '"hono": "catalog:"' '"hono": "catalog:",
    "zod": "^4.0.0"')"
check "and the reason names it" "hono@^4.0.0" "$(pkg_edit '"hono": "catalog:"' '"hono": "^4.0.0"')"
check "a catalog: dependency is allowed" "" "$(pkg_edit '"hono": "catalog:"' '"hono": "catalog:",
    "zod": "catalog:"')"
check "a workspace: dependency is allowed" "" "$(pkg_edit '"hono": "catalog:"' '"hono": "catalog:",
    "@contentworker/domain": "workspace:*"')"
check "a version bump of the package itself is allowed" "" "$(pkg_edit '"version": "0.0.0"' '"version": "0.1.0"')"
check "a Write of the root package.json with a pinned devDependency is denied" "$DENY" "$(jq -cn --arg f "$repo/package.json" '{session_id:"g",tool_input:{file_path:$f,content:"{\"devDependencies\":{\"turbo\":\"^2.0.0\"}}"}}' | "$hooks/guard-invariants.sh")"

# ── session-context: where am I ───────────────────────────────────────────────
git -C "$repo" checkout -q main
check "main in a plain checkout warns about the shared tree" "git worktree add" "$(echo '{}' | CLAUDE_PROJECT_DIR=$repo "$hooks/session-context.sh")"
git -C "$repo" worktree add -q "$TMPDIR/wt" -b feat/y
check "a worktree on a branch says so" "worktree: yes" "$(echo '{}' | CLAUDE_PROJECT_DIR=$TMPDIR/wt "$hooks/session-context.sh")"
check "and doesn't warn" "" "$(echo '{}' | CLAUDE_PROJECT_DIR=$TMPDIR/wt "$hooks/session-context.sh" | grep -o 'git worktree add')"

# A PATH with every system tool but jq.
mkdir -p "$TMPDIR/nojq"
for f in /bin/* /usr/bin/*; do [ "${f##*/}" = jq ] || ln -sf "$f" "$TMPDIR/nojq/${f##*/}"; done
check "without jq the session start says the hooks are off" "jq is not installed" "$(echo '{}' | PATH="$TMPDIR/nojq" /bin/bash "$hooks/session-context.sh")"
check "and the guards stay silent rather than erroring" "" "$(echo '{"tool_input":{"command":"pnpm deploy"}}' | PATH="$TMPDIR/nojq" /bin/bash "$hooks/guard-bash.sh" 2>&1)"

rm -rf "$TMPDIR"
exit $fail
