#!/bin/bash
# Pipes realistic hook input into the docs hooks and checks what they say. Run from the repo root:
#   .claude/hooks/tests/docs-hooks.test.sh
# The Stop-hook cases run against a throwaway git repo, so they never read this checkout's state.
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
edit() { printf '{"session_id":"%s","tool_input":{"file_path":"%s"}}' "$1" "$2" | "$hooks/docs-impact.sh"; }
stop() { printf '{"session_id":"%s"}' "$1" | "$hooks/docs-drift.sh"; }

# ── docs-impact: naming pages ────────────────────────────────────────────────
check "node specs edit names the node catalog" "apps/docs/src/content/reference/nodes.mdx" "$(edit s1 "$root/packages/domain/src/workflow/nodes.ts")"
check "node specs edit says it is generated" "renders from this file" "$(edit s2 "$root/packages/domain/src/workflow/nodes.ts")"
check "second edit of the same file is quiet" "" "$(edit s2 "$root/packages/domain/src/workflow/nodes.ts")"
check "a management route names the REST reference" "apps/docs/src/content/reference/rest-api.mdx" "$(edit s3 "$root/packages/http/src/api/routes/management.ts")"
check "maintainer pages are named as they are" "docs/api-reference.md" "$(edit s4 "$root/packages/http/src/api/routes/delivery.ts")"
check "undocumented file is quiet" "" "$(edit s5 "$root/packages/telemetry/src/index.ts")"
check "file outside any repo is quiet" "" "$(edit s6 /etc/hosts)"
check "map lookup is exact" "" "$(printf 'packages/domain/src/workflow/nodes.tsx\n' | "$hooks/docs-map.sh")"

check "a migration names the schema reference" "docs/development.md" "$(edit s7 "$root/packages/db/migrations/0001_init.sql")"
check "app.css edit names the design tokens" "packages/design/src/tokens.ts" "$(edit s8 "$root/apps/web/app/app.css")"
check "the MCP server names the MCP guide" "apps/docs/src/content/guides/mcp.mdx" "$(edit s9 "$root/packages/http/src/mcp/server.ts")"
check "a wrangler config names the configuration page" "docs/configuration.md" "$(edit s10 "$root/apps/engine/wrangler.jsonc")"

# ── block-generated: generated files are denied, everything else allowed ─────
guard() { printf '{"tool_input":{"file_path":"%s"}}' "$1" | "$hooks/block-generated.sh"; }
check "hand edit of the generated docs theme is denied" '"permissionDecision":"deny"' "$(guard "$root/apps/docs/src/styles/theme.css")"
check "hand edit of a generated diagram theme is denied" '"permissionDecision":"deny"' "$(guard "$root/docs/diagrams/themes/ledger-dark.json")"
check "the docs embed is denied" '"permissionDecision":"deny"' "$(guard "$root/packages/docs/src/generated.ts")"
check "and the reason names its generator" "@contentworker/docs generate" "$(guard "$root/packages/docs/src/generated.ts")"
check "the MCP skills embed is denied" '"permissionDecision":"deny"' "$(guard "$root/packages/http/src/mcp/skills.generated.ts")"
check "and the reason names its generator" "generate:skills" "$(guard "$root/packages/http/src/mcp/skills.generated.ts")"
check "the docs OpenAPI snapshot is denied" '"permissionDecision":"deny"' "$(guard "$root/apps/docs/src/generated/openapi.json")"
check "wrangler-generated types are denied" '"permissionDecision":"deny"' "$(guard "$root/apps/web/worker-configuration.d.ts")"
check "hand-written docs styles are allowed" "" "$(guard "$root/apps/docs/src/styles/brand.css")"
check "a docs page is allowed" "" "$(guard "$root/docs/architecture.md")"
check "an MCP skill source is allowed" "" "$(guard "$root/packages/http/skills/model-content/SKILL.md")"

# ── docs-drift: only this session's uncommitted edits count ───────────────────
repo="$TMPDIR/repo"
mkdir -p "$repo/packages/domain/src/workflow" "$repo/packages/db/src" "$repo/apps/docs/src/content"
git -C "$repo" init -q
echo a >"$repo/packages/domain/src/workflow/nodes.ts"
echo a >"$repo/packages/db/src/schema.ts"
echo a >"$repo/apps/docs/src/content/page.mdx"
git -C "$repo" add -A && git -C "$repo" -c user.email=t@t -c user.name=t commit -qm init
commit() { git -C "$1" -c user.email=t@t -c user.name=t commit -qam "$2"; }

check "stop hook never loops" "" "$(printf '{"stop_hook_active":true}' | "$hooks/docs-drift.sh")"

echo b >>"$repo/packages/db/src/schema.ts" # another session's change: never in our log
check "another session's change is not ours" "" "$(stop d1)"

edit d2 "$repo/packages/domain/src/workflow/nodes.ts" >/dev/null
echo b >>"$repo/packages/domain/src/workflow/nodes.ts"
out=$(stop d2)
check "own uncommitted surface edit blocks" '"decision":"block"' "$out"
check "block names only our file" "" "$(printf '%s' "$out" | grep -o 'schema.ts')"
check "same drift-set blocks once" "" "$(stop d2)"

edit d3 "$repo/packages/domain/src/workflow/nodes.ts" >/dev/null
edit d3 "$repo/apps/docs/src/content/page.mdx" >/dev/null
check "a docs edit in the same tree satisfies it" "" "$(stop d3)"

commit "$repo" "land it"
edit d4 "$repo/packages/domain/src/workflow/nodes.ts" >/dev/null
check "a committed edit no longer blocks" "" "$(stop d4)"

git -C "$repo" worktree add -q "$TMPDIR/wt" -b wt 2>/dev/null
edit d5 "$TMPDIR/wt/packages/db/src/schema.ts" >/dev/null
echo c >>"$TMPDIR/wt/packages/db/src/schema.ts"
check "an edit inside a worktree counts against that worktree" "packages/db/src/schema.ts" "$(stop d5)"

rm -rf "$TMPDIR"
exit $fail
