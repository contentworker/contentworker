#!/bin/bash
# PreToolUse (Bash): production changes are the operator's to make, never an agent session's, so a
# command that would deploy, roll back, migrate a remote D1 or delete a Cloudflare resource is
# denied. Commands that are sometimes right but hard to undo (pushing to main, force pushes, merging
# a PR, remote D1 queries, Worker secrets, creating the install's resources or a setup code) ask
# first. Everything else is allowed.
#
# The command is split on ; & | and newlines, so a deploy chained after something harmless is still
# caught. The split ignores quoting, so a quoted "; wrangler deploy" inside an echo also matches:
# that errs toward asking, which is the safe side. Fails open on anything unexpected.
. "$(dirname "$0")/lib.sh"
cmd=$(field .tool_input.command)
[ -z "$cmd" ] && exit 0
cwd=$(field .cwd)

ci="Deploys are the operator's to run (\`pnpm contentworker:deploy\`, or the optional Deploy workflow on a fork), never an agent session's. scripts/deploy.sh renders the install's configs, records a D1 bookmark, migrates D1, deploys engine, media, api, delivery and web, smoke-tests, and rolls the Workers back (engine first) on a failure. Check a bundle with \`wrangler deploy --dry-run --outdir <dir>\`; if a Deploy run failed, see the ci-triage skill."

S='[[:space:]]'
while IFS= read -r seg; do
  seg=$(printf '%s' "$seg" | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//')
  # Read through what hides a wrangler subcommand from the patterns below: quotes (`bash -c "…"`),
  # a version pin or a direct script (`npx wrangler@4`, `node …/wrangler.js`), and wrangler's global
  # flags before the subcommand (`wrangler -c x.json deploy`). Only the matching sees this form.
  seg=$(printf '%s' "$seg" | tr -d "\"'" | sed -E \
    -e 's#(^| |/)wrangler(@[^ ]+|\.js)?( |$)#\1wrangler\3#g' \
    -e 's#(^| |/)wrangler(( +(-c|--config|-e|--env|--cwd|--env-file|--profile)( +|=)[^ ]+)+)( |$)#\1wrangler\6#g')
  [ -z "$seg" ] && continue
  m() { printf '%s\n' "$seg" | grep -qE -- "$1"; }

  # ── Deny: these are the operator's, never an agent session's ───────────────
  # `wrangler deploy --dry-run` only bundles (nothing is uploaded), so it is allowed: it is how a
  # Worker's bundle is checked locally. `--dry-run=false` is a real deploy and stays blocked.
  if m "(^|$S|/)wrangler$S+deploy($S|$)" && m "$S--dry-run($S|$)"; then
    :
  elif m "(^|$S|/)wrangler$S+(deploy|versions$S+deploy|rollback|delete)($S|$)"; then
    deny PreToolUse "Blocked \`$seg\`. $ci"
  fi
  # Uploads that don't deploy still reach Cloudflare: a Preview shares production's D1, KV, queues
  # and Workflows, a version upload can be promoted by anyone, and cron triggers change at once.
  if ! m "$S--dry-run($S|$)"; then
    m "(^|$S|/)wrangler$S+(preview|triggers$S+deploy|versions$S+upload)($S|$)" &&
      deny PreToolUse "Blocked \`$seg\`: it uploads to Cloudflare (a Preview, a Worker version or cron triggers). Check a bundle with \`wrangler deploy --dry-run --outdir <dir>\` or \`wrangler versions upload --dry-run\`. $ci"
  fi
  m "(^|$S|/)wrangler$S+d1$S+migrations$S+apply($S.*)?$S--remote($S|=|$)" &&
    deny PreToolUse "Blocked \`$seg\`. Remote D1 migrations run in the operator's deploy (scripts/deploy.sh) before the Workers, and a failed smoke test rolls the Workers back but not D1. Apply locally with \`pnpm db:migrate:local\` (the D1 \`pnpm dev\` uses). $ci"
  m "(^|$S|/)wrangler$S+d1$S+time-travel$S+restore($S|$)" &&
    deny PreToolUse "Blocked \`$seg\`: a Time Travel restore replaces the whole production database and loses every write since the bookmark. It's an incident decision for the user (docs/backup-and-restore.md, and the bookmark each deploy records in its summary); give them the command instead."
  m "(^|$S|/)wrangler$S+(d1|kv$S+namespace|r2$S+bucket|queues)$S+delete($S|$)" &&
    deny PreToolUse "Blocked \`$seg\`: deleting one of the install's Cloudflare resources strands its data. Removing an install is a reviewed procedure (docs/deployment.md); ask the user to run it."
  if m "^(pnpm|npm|yarn|bun|turbo|npx$S+turbo)($S|$)"; then
    # `pnpm … exec wrangler deploy --dry-run` is the dry run above, run through pnpm: allowed.
    if ! { m "$S(exec$S+)?wrangler$S+deploy($S|$)" && m "$S--dry-run($S|$)"; }; then
      m "($S)(run$S+)?(docs:|contentworker:)?deploy($S|$)" && deny PreToolUse "Blocked \`$seg\`. $ci"
    fi
    m "($S)(run$S+)?db:migrate:remote($S|$)" &&
      deny PreToolUse "Blocked \`$seg\`. Remote D1 migrations run in the operator's deploy before the Workers. Apply locally with \`pnpm db:migrate:local\`. $ci"
  fi

  # scripts/deploy.sh runs everything above in one command. Reading or linting it is fine; anything
  # else that names it is treated as running it, by its bare name too (`cd scripts && ./deploy.sh`).
  # This is a tripwire, not the boundary: the script itself refuses to run unless started as
  # `pnpm contentworker:deploy` (or in CI).
  m "(^|$S|/|\(|\`)deploy\.sh([^a-zA-Z0-9.]|$)" &&
    ! m "^(cat|sed|grep|rg|head|tail|wc|ls|diff|shellcheck|chmod|git|gh|bash$S+-n)($S|$)" &&
    deny PreToolUse "Blocked \`$seg\`. $ci"

  # ── Ask: sometimes right, hard to undo ─────────────────────────────────────
  m "(^|$S|/)wrangler$S+d1$S+execute($S.*)?$S--remote($S|=|$)" &&
    ask PreToolUse "\`$seg\` runs SQL against a production D1. Reads are fine with the user's go-ahead; schema or data changes belong in a numbered migration that the deploy applies."
  m "(^|$S|/)wrangler$S+secret$S+(put|delete|bulk)($S|$)" &&
    ask PreToolUse "\`$seg\` changes a deployed Worker's secret. Each deploy writes every Worker's secrets (PRINCIPAL_KEY, DATA_KEY, TOKEN_PEPPER, MEDIA_SIGNING_SECRET and the rest) from the install's secrets file or CI secrets; a rotation goes through the *_PREVIOUS keys (docs/deployment.md, \"Secrets\")."
  m "(^|$S|/)wrangler$S+versions$S+secret$S+(put|delete|bulk)($S|$)" &&
    ask PreToolUse "\`$seg\` writes a Worker secret into a new version. Each deploy writes every Worker's secrets from the install's secrets file or CI secrets (docs/deployment.md, \"Secrets\")."
  # An applied migration rewritten through the shell; the Edit and Write tools are covered by
  # guard-invariants.sh. Applied means it is on origin/main (or main without a remote).
  mig='(\./)?packages/db/migrations/[0-9]{4}_[A-Za-z0-9_]+\.sql'
  targets=$(
    m "(^|$S)(sed$S+(.*$S)?(-[a-zA-Z]*i|--in-place)|perl$S+-[a-zA-Z]*i|truncate|rm|mv)$S" &&
      printf '%s\n' "$seg" | grep -oE "$mig"
    printf '%s\n' "$seg" | grep -oE "(>>?|tee($S+-a)?)$S*$mig" | grep -oE "$mig"
  )
  if [ -n "$targets" ]; then
    for f in $(printf '%s\n' "$targets" | sed 's#^\./##' | sort -u); do
      base=origin/main
      git -C "${cwd:-.}" rev-parse -q --verify "$base" >/dev/null || base=main
      git -C "${cwd:-.}" cat-file -e "$base:$f" 2>/dev/null &&
        deny PreToolUse "Blocked \`$seg\`: $f is on $base, so installs have applied it, and migrations are never edited once applied. Add the next numbered migration instead (d1-migration skill)."
    done
  fi
  # Creating the install's resources and secrets, or issuing a setup code, touches the live
  # account. Reading or linting the scripts is fine.
  if m "(^|$S|/)scripts/(setup|setup-code)\.sh($S|$)" ||
    { m "^(pnpm|npm|yarn|bun)($S|$)" && m "$S(run$S+)?contentworker:setup(-code)?($S|$)"; }; then
    m "^(cat|sed|grep|rg|head|tail|wc|ls|diff|shellcheck|chmod|git|gh|bash$S+-n)($S|$)" ||
      ask PreToolUse "\`$seg\` creates or changes the install's Cloudflare resources and secrets (\`pnpm contentworker:setup\`), or issues a new admin setup code (\`pnpm contentworker:setup-code\`). Run it only when the user asked for it."
  fi
  m "^gh$S+pr$S+merge($S|$)" &&
    ask PreToolUse "Merging to main ships the change (a fork with the Deploy workflow on deploys it). Confirm with the user before merging."
  m "^gh$S+workflow$S+run($S|$)" &&
    ask PreToolUse "\`$seg\` starts a workflow run by hand. To recover a failed run, re-run its failed jobs instead (\`gh run rerun <run-id> --failed\`)."
  if m "^git$S+push($S|$)"; then
    m "$S(-f|--force|--force-with-lease(=[^ ]*)?|--mirror|--delete|-d)($S|$)|$S\+[^ ]+" &&
      ask PreToolUse "\`$seg\` rewrites or deletes remote history. Confirm with the user first."
    m "$S([^ ]*:)?(refs/heads/)?main($S|$)" &&
      ask PreToolUse "\`$seg\` pushes to main. Push a branch and open a PR instead."
    # On main, a push that names no refspec (or names HEAD) pushes main.
    branch=$(git -C "${cwd:-.}" branch --show-current 2>/dev/null)
    if [ "$branch" = main ]; then
      args=$(printf '%s\n' "${seg#git push}" | tr ' ' '\n' | grep -v '^-' | grep -c .)
      { [ "$args" -lt 2 ] || m "${S}HEAD($S|$)"; } &&
        ask PreToolUse "\`$seg\` runs on main, so it would push main. Work on a branch in a worktree and open a PR."
    fi
  fi
done < <(printf '%s\n' "$cmd" | tr ';&|' '\n\n\n')
exit 0
