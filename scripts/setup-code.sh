#!/usr/bin/env bash
# Issues a new one-time setup code for a running install, for when no admin can sign in. The code
# opens /setup once, to create one new admin account, and both its use and every wrong guess go to
# the audit log. See docs/deployment.md, "Recovering admin access".
#
#   scripts/setup-code.sh [--env-file <path>] [--github]
#
# Needs `wrangler login` (or CLOUDFLARE_API_TOKEN). The code replaces SETUP_TOKEN in the install's
# secrets file (so the next deploy keeps it) and on the web Worker (so it works now); it is never
# printed. With the deploy-on-merge workflow, pass --github so its `production` environment gets
# the new code too: otherwise its next deploy would put the old code back.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
env_file=.env
github=""
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) env_file="${2:?--env-file needs a path}"; shift 2 ;;
    --github) github=1; shift ;;
    *) echo "usage: scripts/setup-code.sh [--env-file <path>] [--github]" >&2; exit 2 ;;
  esac
done

eval "$(node scripts/install.ts names --settings "$env_file")"
dir=$(dirname "$SECRETS_FILE")
mkdir -p "$dir"
chmod 700 "$dir"
code=$(openssl rand -hex 16)
# Written beside the file and moved over it, so an interrupted write never loses the other keys.
next=$(umask 077 && mktemp "$dir/.secrets.XXXXXX")
trap 'rm -f "$next"' EXIT
{
  [ -f "$SECRETS_FILE" ] && grep -v '^SETUP_TOKEN=' "$SECRETS_FILE" || true
  printf 'SETUP_TOKEN=%s\n' "$code"
} >"$next"
mv "$next" "$SECRETS_FILE"
printf '%s' "$code" | pnpm --filter @contentworker/web exec wrangler secret put SETUP_TOKEN --name "$WEB" >/dev/null
if [ -n "$github" ]; then
  printf '%s' "$code" | gh secret set SETUP_TOKEN --env production
  echo "Set SETUP_TOKEN on the production environment."
fi
echo "New setup code in $SECRETS_FILE (SETUP_TOKEN). Send it, with https://$DOMAIN/setup, to the"
echo "person recovering access; it creates one admin account and then stops working."
