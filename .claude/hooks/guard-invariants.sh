#!/bin/bash
# PreToolUse (Edit|Write|MultiEdit): denies edits that break a rule AGENTS.md states as absolute,
# where the file and the text alone are enough to tell:
#   - a D1 migration in packages/db/migrations that is already on origin/main (CI has applied it to
#     every deployment; add the next numbered one instead)
#   - a z-suffixed endpoint (/healthz, /readyz, …) in new text
#   - a package.json dependency with a version of its own: every external version lives in the
#     pnpm catalog (pnpm-workspace.yaml), so a dependency is "catalog:" or "workspace:"
# and asks before:
#   - a new or unapplied migration that contracts the schema (DROP, RENAME): migrations are
#     expand-only, so a drop or rename waits for a later change once no deployed code reads it
#   - an edit to an app's wrangler.jsonc (apps/engine owns every Durable Object class) that changes,
#     removes or reorders a Durable Object migration already on origin/main, or adds a deleted,
#     renamed or transferred class
#   - an edit to the frozen migration list in scripts/do-migrations.test.ts (which CI enforces)
# Everything else is allowed. block-generated.sh guards generated files separately.
. "$(dirname "$0")/lib.sh"
file=$(field .tool_input.file_path)
[ -z "$file" ] && exit 0
loc=$(repo_path "$file") || exit 0
top=${loc%%$'\t'*}
rel=${loc#*$'\t'}
text=$(field '[.tool_input.content, .tool_input.new_string, (.tool_input.edits // [] | .[].new_string)] | map(select(. != null)) | join("\n")')

case "$rel" in
  packages/db/migrations/[0-9][0-9][0-9][0-9]_*.sql)
    base=origin/main
    git -C "$top" rev-parse -q --verify "$base" >/dev/null || base=main
    if git -C "$top" cat-file -e "$base:$rel" 2>/dev/null; then
      deny PreToolUse "$rel is on $base, so CI has applied it to every deployment: editing it changes nothing there and forks local databases from production. Add the next numbered migration instead (d1-migration skill), mirrored in packages/db/src/schema.ts. It must work with the code already deployed: expand now, contract in a later change."
    fi
    printf '%s' "$text" | grep -qiE '\b(drop[[:space:]]+(table|column|index)|rename[[:space:]]+(to|column))\b' &&
      ask PreToolUse "This migration drops or renames something. Migrations are expand-only (AGENTS.md): CI applies them before the new Workers deploy and never rolls D1 back, so the code already running must still work on the new schema. Drop or rename only in a later change, once no deployed code reads the old shape (d1-migration skill, \"Rename or drop\"). Proceed only if that is what this change is." ;;
  package.json | */package.json)
    after=$(after_edit "$file") || exit 0
    stray=$(printf '%s' "$after" | jq -r '
      [(.dependencies, .devDependencies, .optionalDependencies) // {} | to_entries[]
        | select((.value | startswith("catalog:") or startswith("workspace:")) | not)
        | "\(.key)@\(.value)"] | join(", ")' 2>/dev/null)
    [ -n "$stray" ] &&
      deny PreToolUse "$rel would pin its own version for: $stray. Every external dependency version lives in the pnpm catalog (AGENTS.md): add \`name: version\` to the catalog in pnpm-workspace.yaml (latest stable, in the group it belongs to) and write \"catalog:\" here. Use \"workspace:*\" for a @contentworker package. peerDependencies keep their own ranges. scripts/catalog.test.ts checks this in CI." ;;
  scripts/do-migrations.test.ts)
    ask PreToolUse "do-migrations.test.ts freezes the Durable Object migrations every deployment has applied. Appending a new class's tag (the same entry as in wrangler.jsonc) is fine; changing or removing an entry, or allowing a destructive one, is not without a plan for that class's data." ;;
  apps/*/wrangler.jsonc)
    after=$(after_edit "$file") || exit 0
    # The migrations array's entries, one per line, without spacing, commas or comments.
    migrations() {
      awk '/"migrations"[[:space:]]*:/ { on = 1; next } on && /^[[:space:]]*\]/ { exit } on' |
        sed -e 's#//.*##' | tr -d ' \t' | sed -e 's/,$//' | grep -v '^$'
    }
    new=$(printf '%s\n' "$after" | migrations)
    if printf '%s' "$new" | grep -qE '"(deleted|renamed|transferred)_classes"'; then
      ask PreToolUse "This edit adds a deleted, renamed or transferred Durable Object class to $rel. On deploy that destroys or moves every object of the class in every deployment (live hubs, rate limits, AI budgets, search shards). Plan the data with the user first; scripts/do-migrations.test.ts refuses it unless allowlisted there."
    fi
    base=origin/main
    git -C "$top" rev-parse -q --verify "$base" >/dev/null || base=main
    old=$(git -C "$top" show "$base:$rel" 2>/dev/null | migrations)
    if [ -n "$old" ]; then
      case "$new"$'\n' in
        "$old"$'\n'*) ;;
        *) ask PreToolUse "This edit changes, removes or reorders a Durable Object migration in $rel that is on $base, so every deployment has applied it. Applied tags stay exactly as they are; a new class gets a new tag appended at the end (and in scripts/do-migrations.test.ts)." ;;
      esac
    fi ;;
esac

# The rule's own statements (AGENTS.md, CLAUDE.md, this toolkit) name the forbidden routes on purpose.
case "$rel" in CLAUDE.md | AGENTS.md | .claude/*) exit 0 ;; esac
hit=$(printf '%s' "$text" | grep -oE '/(healthz|readyz|livez|authz|statusz|varz)\b' | head -1)
[ -n "$hit" ] && deny PreToolUse "Endpoint names never end in a trailing z: use ${hit%z}, not $hit (AGENTS.md)."
exit 0
