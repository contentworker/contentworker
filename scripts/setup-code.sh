#!/usr/bin/env bash
# Issues a new one-time setup code for a running install, for when no admin can sign in. The code
# opens /setup once, to create one new admin account, and both its use and every wrong guess go to
# the audit log. See docs/deployment.md, "Recovering admin access".
#
#   scripts/setup-code.sh [--env-file <path>]
#
# Needs `wrangler login` (or CLOUDFLARE_API_TOKEN). The code replaces SETUP_TOKEN in the install's
# secrets file (so the next deploy keeps it) and on the web Worker (so it works now); it is never
# printed. Running the optional deploy-on-merge workflow? Update its SETUP_TOKEN secret too.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
env_file=.env
if [ "${1:-}" = --env-file ]; then env_file="${2:?--env-file needs a path}"; fi

eval "$(node scripts/install.ts names --settings "$env_file")"
mkdir -p "$(dirname "$SECRETS_FILE")"
[ -f "$SECRETS_FILE" ] || (umask 077 && : >"$SECRETS_FILE")
code=$(openssl rand -hex 16)
rest=$(grep -v '^SETUP_TOKEN=' "$SECRETS_FILE" || true)
(umask 077 && { [ -n "$rest" ] && printf '%s\n' "$rest"; printf 'SETUP_TOKEN=%s\n' "$code"; } >"$SECRETS_FILE")
printf '%s' "$code" | pnpm --filter @contentworker/web exec wrangler secret put SETUP_TOKEN --name "$WEB" >/dev/null
echo "New setup code in $SECRETS_FILE (SETUP_TOKEN). Send it, with https://$DOMAIN/setup, to the"
echo "person recovering access; it creates one admin account and then stops working."
