#!/bin/bash
# PreToolUse (Bash): production changes only come from CI, so a command that would deploy, roll
# back, migrate a remote D1 or delete a Cloudflare resource by hand is denied. Commands that are
# sometimes right but hard to undo (pushing to main, force pushes, merging a PR, remote D1 queries,
# Worker secrets, provisioning a deployment) ask first. Everything else is allowed.
#
# The command is split on ; & | and newlines, so a deploy chained after something harmless is still
# caught. The split ignores quoting, so a quoted "; wrangler deploy" inside an echo also matches:
# that errs toward asking, which is the safe side. Fails open on anything unexpected.
. "$(dirname "$0")/lib.sh"
cmd=$(field .tool_input.command)
[ -z "$cmd" ] && exit 0
cwd=$(field .cwd)

ci="Production deploys from CI: merging to main runs .github/workflows/ci.yml, which calls deploy.yml for every deployment ring by ring: it records a D1 bookmark, migrates D1, deploys engine, api, delivery and web, smoke-tests, and rolls the Workers back (engine first) on a failure. Don't do it by hand. If a deploy job failed, re-run its failed jobs (\`gh run rerun <run-id> --failed\`); see the ci-triage skill."

S='[[:space:]]'
while IFS= read -r seg; do
  seg=$(printf '%s' "$seg" | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//')
  [ -z "$seg" ] && continue
  m() { printf '%s\n' "$seg" | grep -qE -- "$1"; }

  # ── Deny: these only ever happen in CI ─────────────────────────────────────
  # `wrangler deploy --dry-run` only bundles (nothing is uploaded), so it is allowed: it is how a
  # Worker's bundle is checked locally. `--dry-run=false` is a real deploy and stays blocked.
  if m "(^|$S|/)wrangler$S+deploy($S|$)" && m "$S--dry-run($S|$)"; then
    :
  elif m "(^|$S|/)wrangler$S+(deploy|versions$S+deploy|rollback|delete)($S|$)"; then
    deny PreToolUse "Blocked \`$seg\`. $ci"
  fi
  m "(^|$S|/)wrangler$S+d1$S+migrations$S+apply($S.*)?$S--remote($S|=|$)" &&
    deny PreToolUse "Blocked \`$seg\`. Remote D1 migrations run in CI before the Workers deploy, and a failed smoke test rolls the Workers back but not D1. Apply locally with \`pnpm --filter @contentworker/web db:migrate:local\` (the D1 \`pnpm dev\` uses). $ci"
  m "(^|$S|/)wrangler$S+d1$S+time-travel$S+restore($S|$)" &&
    deny PreToolUse "Blocked \`$seg\`: a Time Travel restore replaces the whole production database and loses every write since the bookmark. It's an incident decision for the user (docs/backup-and-restore.md, and the bookmark each deploy job records in its summary); give them the command instead."
  m "(^|$S|/)wrangler$S+(d1|kv$S+namespace|r2$S+bucket|queues)$S+delete($S|$)" &&
    deny PreToolUse "Blocked \`$seg\`: deleting a deployment's Cloudflare resource strands its data. Removing a deployment is a reviewed procedure (docs/deployment.md); ask the user to run it."
  if m "^(pnpm|npm|yarn|bun|turbo|npx$S+turbo)($S|$)"; then
    # `pnpm … exec wrangler deploy --dry-run` is the dry run above, run through pnpm: allowed.
    if ! { m "$S(exec$S+)?wrangler$S+deploy($S|$)" && m "$S--dry-run($S|$)"; }; then
      m "($S)(run$S+)?(docs:)?deploy($S|$)" && deny PreToolUse "Blocked \`$seg\`. $ci"
    fi
    m "($S)(run$S+)?db:migrate:remote($S|$)" &&
      deny PreToolUse "Blocked \`$seg\`. Remote D1 migrations run in CI before the Workers deploy. Apply locally with \`pnpm --filter @contentworker/web db:migrate:local\`. $ci"
  fi

  # ── Ask: sometimes right, hard to undo ─────────────────────────────────────
  m "(^|$S|/)wrangler$S+d1$S+execute($S.*)?$S--remote($S|=|$)" &&
    ask PreToolUse "\`$seg\` runs SQL against a production D1. Reads are fine with the user's go-ahead; schema or data changes belong in a numbered migration that CI applies."
  m "(^|$S|/)wrangler$S+secret$S+(put|delete|bulk)($S|$)" &&
    ask PreToolUse "\`$seg\` changes a deployed Worker's secret. CI writes every Worker's secrets (PRINCIPAL_KEY, DATA_KEY, TOKEN_PEPPER, MEDIA_SIGNING_SECRET and the rest) from the deployment's GitHub environment on each deploy (\`node scripts/fleet.ts secrets\`); a rotation goes through the *_PREVIOUS keys (docs/deployment.md, \"Secrets\")."
  m "(^|$S|/)scripts/provision\.sh($S|$)" &&
    ask PreToolUse "\`$seg\` creates Cloudflare resources and a GitHub environment for a deployment. Run it only for a deployment the user named."
  m "^gh$S+pr$S+merge($S|$)" &&
    ask PreToolUse "Merging to main deploys to every deployment in ring order. Confirm with the user before merging."
  m "^gh$S+workflow$S+run($S|$)" &&
    ask PreToolUse "\`$seg\` starts a workflow run by hand. To recover a failed deploy, re-run its failed jobs instead."
  if m "^git$S+push($S|$)"; then
    m "$S(-f|--force|--force-with-lease(=[^ ]*)?|--mirror|--delete|-d)($S|$)|$S\+[^ ]+" &&
      ask PreToolUse "\`$seg\` rewrites or deletes remote history. Confirm with the user first."
    m "$S([^ ]*:)?(refs/heads/)?main($S|$)" &&
      ask PreToolUse "\`$seg\` pushes to main, which deploys to production. Push a branch and open a PR instead."
    # On main, a push that names no refspec (or names HEAD) pushes main.
    branch=$(git -C "${cwd:-.}" branch --show-current 2>/dev/null)
    if [ "$branch" = main ]; then
      args=$(printf '%s\n' "${seg#git push}" | tr ' ' '\n' | grep -v '^-' | grep -c .)
      { [ "$args" -lt 2 ] || m "${S}HEAD($S|$)"; } &&
        ask PreToolUse "\`$seg\` runs on main, so it would push main, which deploys to production. Work on a branch in a worktree and open a PR."
    fi
  fi
done < <(printf '%s\n' "$cmd" | tr ';&|' '\n\n\n')
exit 0
