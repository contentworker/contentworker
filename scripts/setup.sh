#!/usr/bin/env bash
# Creates your install's Cloudflare resources and its secrets. Run it once before the first
# deploy, and again after changing a setting that adds a resource; it is safe to re-run: existing
# resources, and secrets already generated, are kept. See docs/deployment.md.
#
#   scripts/setup.sh [--env-file <path>] [--github]
#
# Reads the install's settings from the environment and its settings file (.env by default).
# Needs `wrangler login` (or CLOUDFLARE_API_TOKEN). D1 read replication and the AI Gateway go
# through the API with the same credentials: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID when set,
# else wrangler's own login (`wrangler auth token`, and the account from `wrangler whoami` when it
# has exactly one). What the API refuses is printed for the dashboard instead.
#
# The secrets are generated into .secrets/ (gitignored, 0600) and never printed. Back that file up:
# DATA_KEY seals every stored secret and TOKEN_PEPPER is in every API key hash, so losing them
# loses what they protect. --github also sets them on this repository's `production` environment,
# limited to main, for the optional deploy-on-merge workflow (needs `gh auth login`).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
env_file=.env
github=""
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) env_file="${2:?--env-file needs a path}"; shift 2 ;;
    --github) github=1; shift ;;
    *) echo "usage: scripts/setup.sh [--env-file <path>] [--github]" >&2; exit 2 ;;
  esac
done
if [ -n "$github" ] && [ -n "${INSTANCE:-}$(grep -E '^INSTANCE=.+' "$env_file" 2>/dev/null || true)" ]; then
  # The deploy workflow ships one install; a second one's keys would overwrite the first's.
  echo "--github is for the one install the Deploy workflow ships; it can't be used with INSTANCE." >&2
  exit 2
fi
if [ ! -f "$env_file" ] && [ -z "${DOMAIN:-}" ]; then
  echo "No $env_file: copy .env.example to $env_file and set DOMAIN first." >&2
  exit 1
fi

eval "$(node scripts/install.ts names --settings "$env_file")"
wrangler() { pnpm --filter @contentworker/engine exec wrangler "$@"; }
j=()
[ -n "$JURISDICTION" ] && j=(--jurisdiction "$JURISDICTION")

# Credentials for the two API calls wrangler has no command for. Kept in shell variables, never
# exported: wrangler itself keeps using whatever it was signed in with.
cf_token="${CLOUDFLARE_API_TOKEN:-$(wrangler auth token 2>/dev/null | tail -n 1 || true)}"
cf_account="${CLOUDFLARE_ACCOUNT_ID:-$(wrangler whoami --json 2>/dev/null | sed -n '/^{/,$p' |
  jq -r 'if (.accounts | length) == 1 then .accounts[0].id else empty end' 2>/dev/null || true)}"
[[ "$cf_token" =~ ^[A-Za-z0-9._-]{20,}$ ]] || cf_token=""
[[ "$cf_account" =~ ^[0-9a-f]{32}$ ]] || cf_account=""

echo "== D1 $D1, KV $KV, R2 $MEDIA, index ${VECTORS:-none}, gateway ${AI_GATEWAY:-none}"
echo "   https://$DOMAIN (admin), https://$API_DOMAIN (api), https://$CDN_DOMAIN (delivery), https://$MEDIA_DOMAIN (media)"

# D1, the system of record, with read replication on: delivery and admin reads go to the nearest
# replica (the Workers open Sessions API sessions; writes always go to the primary).
wrangler d1 create "$D1" ${j[@]+"${j[@]}"} || echo "D1 database $D1 already exists"
# Look the database up by name in the account's list: `d1 info <name>` resolves the name against
# apps/engine/wrangler.jsonc first, where the binding carries the placeholder id.
uuid=$(wrangler d1 list --json | jq -er --arg n "$D1" '.[] | select(.name == $n) | .uuid')
if [ -n "$cf_token" ] && [ -n "$cf_account" ] &&
  curl -fsS -X PUT "https://api.cloudflare.com/client/v4/accounts/$cf_account/d1/database/$uuid" \
    -H @<(printf 'Authorization: Bearer %s\n' "$cf_token") -H 'Content-Type: application/json' \
    --data '{"read_replication":{"mode":"auto"}}' >/dev/null; then
  echo "D1 read replication: auto"
else
  echo "Turn on read replication for $D1 (dashboard: D1 > $D1 > Settings)."
fi

# The KV namespace the api, engine, delivery and media share (delivery cache, cached principals,
# the published-asset gate).
kv_id() { wrangler kv namespace list | jq -er --arg t "$KV" '.[] | select(.title == $t) | .id'; }
kv_id >/dev/null 2>&1 || wrangler kv namespace create "$KV" >/dev/null
echo "KV namespace $KV: $(kv_id)"

# Media, import staging, plugin bundles, dead letters and zip downloads. Staged imports, dead
# letters and zips expire (a zip is kept a day; the engine's sweep removes it, this is the
# backstop).
wrangler r2 bucket create "$MEDIA" ${j[@]+"${j[@]}"} || echo "R2 bucket $MEDIA already exists"
for rule in "imports imports/ 7" "dlq dlq/ 30" "zips zips/ 2"; do
  set -- $rule
  wrangler r2 bucket lifecycle remove "$MEDIA" --name "$1" ${j[@]+"${j[@]}"} >/dev/null 2>&1 || true
  wrangler r2 bucket lifecycle add "$MEDIA" "$1" "$2" --expire-days "$3" --force ${j[@]+"${j[@]}"}
done
# Multipart uploads nobody finished (an abandoned large upload, a zip whose build died): aborted
# after 2 days anywhere in the bucket, so R2 stops keeping their parts. The engine's hourly sweep
# aborts an abandoned upload after one day; this is the backstop.
wrangler r2 bucket lifecycle remove "$MEDIA" --name abort-multipart ${j[@]+"${j[@]}"} >/dev/null 2>&1 || true
wrangler r2 bucket lifecycle add "$MEDIA" abort-multipart "" --abort-multipart-days 2 --force ${j[@]+"${j[@]}"}

# Embeddings for semantic and hybrid search (Workers AI bge-base-en-v1.5: 768 dims). With
# AI_MODE=mock every model is mocked and there is no index.
if [ -n "$VECTORS" ]; then
  if wrangler vectorize get "$VECTORS" >/dev/null 2>&1; then
    echo "Vectorize index $VECTORS already exists"
  else
    wrangler vectorize create "$VECTORS" --dimensions 768 --metric cosine
  fi
  for prop in spaceId environmentId; do
    wrangler vectorize create-metadata-index "$VECTORS" --property-name "$prop" --type string \
      >/dev/null 2>&1 || true
  done
fi

# Queues: domain events (+ dead letters), bulk chunks, agent jobs, delivery purges, media purges
# and asset events (each + dead letters).
for q in $QUEUES; do
  if wrangler queues info "$q" >/dev/null 2>&1; then echo "Queue $q already exists"
  else wrangler queues create "$q"; fi
  wrangler queues update "$q" --message-retention-period-secs 1209600 >/dev/null
done

# Asset ingest: every object written to the media bucket is announced on the asset-events queue.
# Asset keys (`space/environment/asset/file`) share no prefix, so the rule has none; the engine
# ignores keys that aren't an asset's current file (extracted text, version bodies, staged jobs).
if wrangler r2 bucket notification list "$MEDIA" ${j[@]+"${j[@]}"} 2>/dev/null | grep -q "$ASSET_EVENTS"; then
  echo "R2 notification $MEDIA -> $ASSET_EVENTS already exists"
else
  wrangler r2 bucket notification create "$MEDIA" --event-type object-create \
    --queue "$ASSET_EVENTS" --description "contentworker asset ingest" ${j[@]+"${j[@]}"}
fi

# The AI Gateway every model call goes through.
if [ -z "$AI_GATEWAY" ]; then
  :
elif [ -n "$cf_token" ] && [ -n "$cf_account" ]; then
  api="https://api.cloudflare.com/client/v4/accounts/$cf_account/ai-gateway/gateways"
  # The token goes in on a file descriptor, never on curl's command line (visible in `ps`).
  auth() { printf 'Authorization: Bearer %s\n' "$cf_token"; }
  if curl -fsS -H @<(auth) "$api/$AI_GATEWAY" >/dev/null 2>&1; then
    echo "AI Gateway $AI_GATEWAY already exists"
  elif curl -fsS -X POST "$api" -H @<(auth) \
      -H 'Content-Type: application/json' \
      --data "$(jq -n --arg id "$AI_GATEWAY" --argjson logs "$AI_GATEWAY_LOGS" '{
        id: $id, authentication: true, collect_logs: $logs,
        log_management: 100000, log_management_strategy: "DELETE_OLDEST",
        cache_ttl: 0, cache_invalidate_on_update: false,
        rate_limiting_limit: 120, rate_limiting_interval: 60, rate_limiting_technique: "sliding",
        retry_max_attempts: 3, retry_delay: 500, retry_backoff: "exponential"
      }')" >/dev/null; then
    echo "Created AI Gateway $AI_GATEWAY"
  else
    echo "Couldn't create AI Gateway $AI_GATEWAY: create it in the dashboard (AI > AI Gateway)."
  fi
else
  echo "Skipped the AI Gateway (no Cloudflare login to call the API with): create"
  echo "\"$AI_GATEWAY\" in the dashboard (AI > AI Gateway)."
fi

# The secrets, generated once. DATA_KEY seals every stored secret, TOKEN_PEPPER is in every API key
# hash and PASSWORD_PEPPER in every password hash: once an install runs, none may change, so none is
# generated while a Worker already holds one (restore the file from your backup instead).
mkdir -p "$(dirname "$SECRETS_FILE")"
chmod 700 "$(dirname "$SECRETS_FILE")"
[ -f "$SECRETS_FILE" ] || (umask 077 && : >"$SECRETS_FILE")
chmod 600 "$SECRETS_FILE"
held=""
for worker in "$API" "$WEB"; do
  if out=$(wrangler secret list --name "$worker" 2>/dev/null); then
    held+=$'\n'$(jq -r '.[].name' <<<"$out" 2>/dev/null || true)
  fi
done
# The engine's ASSISTANT_PRINCIPAL_KEY (and _PREVIOUS) isn't generated: it is derived from
# PRINCIPAL_KEY (and PRINCIPAL_KEY_PREVIOUS) at every deploy, so a rotation carries it along.
for key in PRINCIPAL_KEY DATA_KEY TOKEN_PEPPER MEDIA_SIGNING_SECRET PASSWORD_PEPPER SETUP_TOKEN; do
  if grep -q "^$key=" "$SECRETS_FILE"; then
    echo "$key already generated"
  elif [ "$key" != PRINCIPAL_KEY ] && [ "$key" != MEDIA_SIGNING_SECRET ] && [ "$key" != SETUP_TOKEN ] &&
    grep -qx "$key" <<<"$held"; then
    echo "$SECRETS_FILE has no $key, but a Worker already holds one. Restore the file from your"
    echo "backup; a new $key would make what it protects unreadable."
    exit 1
  else
    bytes=32
    [ "$key" = SETUP_TOKEN ] && bytes=16
    printf '%s=%s\n' "$key" "$(openssl rand -hex "$bytes")" >>"$SECRETS_FILE"
    echo "Generated $key"
  fi
done

if [ -n "$github" ]; then
  # The `production` environment's secrets, for .github/workflows/deploy.yml, set from the file
  # without printing them. Only main may read the environment: a repository secret would reach a
  # workflow on any branch. An environment already limited to its branches is left as it is,
  # because a PUT replaces its protection settings.
  repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
  env_api="repos/$repo/environments/production"
  if [ "$(gh api "$env_api" --jq '.deployment_branch_policy.custom_branch_policies' 2>/dev/null)" != true ]; then
    gh api --method PUT "$env_api" --input - >/dev/null <<<'{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
  fi
  if ! gh api "$env_api/deployment-branch-policies" --jq '.branch_policies[].name' | grep -qx main; then
    gh api --method POST "$env_api/deployment-branch-policies" -f name=main -f type=branch >/dev/null
  fi
  while IFS='=' read -r key value; do
    [ -n "$key" ] && printf '%s' "$value" | gh secret set "$key" -R "$repo" --env production
  done <"$SECRETS_FILE"
  echo "Set the secrets on $repo's production environment (main only). Add CLOUDFLARE_API_TOKEN and"
  echo "CLOUDFLARE_ACCOUNT_ID there too: gh secret set CLOUDFLARE_API_TOKEN --env production"
fi

echo
echo "Done. Back up $SECRETS_FILE somewhere safe (a password manager or vault)."
echo "Next: pnpm cw:deploy$([ "$env_file" != .env ] && echo " --env-file $env_file"). Then open https://$DOMAIN/setup and enter the"
echo "setup code (SETUP_TOKEN in $SECRETS_FILE) to create the first admin."
