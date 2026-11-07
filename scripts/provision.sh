#!/usr/bin/env bash
# Creates the Cloudflare resources and the GitHub environment for one deployment in
# its registry entry (<id>.jsonc), and records its D1 and KV ids there. Safe to re-run: existing resources,
# and secrets already set, are kept. See docs/deployment.md.
#
#   ./scripts/provision.sh <id>
#
# FLEET_REGISTRY names the registry directory and FLEET_REPO the GitHub repository (owner/name)
# that holds the deployment's environment. Set both to work against the private ops repo; without
# them, this repository's deployments/ and its own environments are used.
#
# Needs `wrangler login` (or CLOUDFLARE_API_TOKEN) and `gh auth login`. D1 read replication and the
# AI Gateway go through the API with the same credentials: CLOUDFLARE_API_TOKEN and
# CLOUDFLARE_ACCOUNT_ID when set, else wrangler's own login (`wrangler auth token`, and the account
# from `wrangler whoami` when it has exactly one). Nothing to paste; what the API refuses is printed
# for the dashboard instead.
set -euo pipefail
id="${1:?usage: scripts/provision.sh <id>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
repo="${FLEET_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"

eval "$(node scripts/fleet.ts names "$id")"
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

echo "== $id: D1 $D1, KV $KV, R2 $MEDIA, index ${VECTORS:-none}, gateway $AI_GATEWAY"
echo "   https://$DOMAIN (admin), https://$API_DOMAIN (api), https://$CDN_DOMAIN (delivery), https://$MEDIA_DOMAIN (media); environment $ENVIRONMENT"

# D1, the system of record, with read replication on: delivery and admin reads go to the nearest
# replica (the Workers open Sessions API sessions; writes always go to the primary).
wrangler d1 create "$D1" ${j[@]+"${j[@]}"} || echo "D1 database $D1 already exists"
# Look the database up by name in the account's list: `d1 info <name>` resolves the name against
# apps/engine/wrangler.jsonc first, where the binding carries the placeholder id.
uuid=$(wrangler d1 list --json | jq -er --arg n "$D1" '.[] | select(.name == $n) | .uuid')
node scripts/fleet.ts set-d1 "$id" "$uuid"
if [ -n "$cf_token" ] && [ -n "$cf_account" ] &&
  curl -fsS -X PUT "https://api.cloudflare.com/client/v4/accounts/$cf_account/d1/database/$uuid" \
    -H "Authorization: Bearer $cf_token" -H 'Content-Type: application/json' \
    --data '{"read_replication":{"mode":"auto"}}' >/dev/null; then
  echo "D1 read replication: auto"
else
  echo "Turn on read replication for $D1 (dashboard: D1 > $D1 > Settings)."
fi

# The KV namespace the api, engine, delivery and media share (delivery cache, cached principals,
# the published-asset gate).
kv_id() { wrangler kv namespace list | jq -er --arg t "$KV" '.[] | select(.title == $t) | .id'; }
kv=$(kv_id 2>/dev/null) || { wrangler kv namespace create "$KV" >/dev/null; kv=$(kv_id); }
node scripts/fleet.ts set-kv "$id" "$kv"

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

# Embeddings for semantic and hybrid search (Workers AI bge-base-en-v1.5: 768 dims). A demo
# mocks every model and has no index.
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
if [ -n "$cf_token" ] && [ -n "$cf_account" ]; then
  api="https://api.cloudflare.com/client/v4/accounts/$cf_account/ai-gateway/gateways"
  if curl -fsS -H "Authorization: Bearer $cf_token" "$api/$AI_GATEWAY" >/dev/null 2>&1; then
    echo "AI Gateway $AI_GATEWAY already exists"
  elif curl -fsS -X POST "$api" -H "Authorization: Bearer $cf_token" \
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

# The GitHub environment the deploy job runs in, and its secrets. A secret already set is left
# alone. DATA_KEY seals every stored secret and TOKEN_PEPPER is in every API key hash, and
# PASSWORD_PEPPER in every password hash: once a deployment runs, none may change, so none is
# generated while a Worker already holds one. None is ever written to disk.
#
# Only main may read the environment: a branch that could would hold every secret. An environment
# already limited to its branches is left as it is, because a PUT replaces its protection settings.
environment="repos/$repo/environments/$ENVIRONMENT"
if [ "$(gh api "$environment" --jq '.deployment_branch_policy.custom_branch_policies' 2>/dev/null)" != true ]; then
  gh api --method PUT "$environment" --input - >/dev/null <<<'{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
fi
if ! gh api "$environment/deployment-branch-policies" --jq '.branch_policies[].name' | grep -qx main; then
  gh api --method POST "$environment/deployment-branch-policies" -f name=main -f type=branch >/dev/null
fi
API_WORKER="contentworker-api$SUFFIX"
EXISTING=$(gh secret list -R "$repo" --env "$ENVIRONMENT" --json name -q '.[].name')
# The api holds DATA_KEY and TOKEN_PEPPER, and web alone holds PASSWORD_PEPPER.
WORKER_SECRETS=""
for WORKER in "$API_WORKER" "contentworker-web$SUFFIX"; do
  if HELD=$(wrangler secret list --name "$WORKER" 2>/dev/null); then
    WORKER_SECRETS+=$'\n'$(jq -r '.[].name' <<<"$HELD" 2>/dev/null || true)
  fi
done
# The engine's ASSISTANT_PRINCIPAL_KEY (and _PREVIOUS) isn't generated here: it is derived from
# PRINCIPAL_KEY (and PRINCIPAL_KEY_PREVIOUS) at every deploy, by `fleet.ts secrets`, so a new
# deployment gets it on its first deploy and a rotation of PRINCIPAL_KEY carries it along.
for KEY in PRINCIPAL_KEY DATA_KEY TOKEN_PEPPER MEDIA_SIGNING_SECRET PASSWORD_PEPPER; do
  if grep -qx "$KEY" <<<"$EXISTING"; then
    echo "$ENVIRONMENT already has $KEY"
  elif [ "$KEY" != PRINCIPAL_KEY ] && [ "$KEY" != MEDIA_SIGNING_SECRET ] && grep -qx "$KEY" <<<"$WORKER_SECRETS"; then
    echo "$ENVIRONMENT has no $KEY, but a Worker already holds one. Set the deployment's own"
    echo "value on $ENVIRONMENT from its escrowed copy; a new one would make what it protects unreadable."
    exit 1
  else
    openssl rand -hex 32 | tr -d '\n' | gh secret set "$KEY" -R "$repo" --env "$ENVIRONMENT"
    echo "Set $KEY on $ENVIRONMENT"
  fi
done

# The first administrator's one-time setup code, kept in .secrets/<id>/ (gitignored).
mkdir -p ".secrets/$id"
chmod 700 ".secrets/$id"
file=".secrets/$id/setup-code"
if grep -qx SETUP_TOKEN <<<"$EXISTING"; then
  echo "$ENVIRONMENT already has SETUP_TOKEN"
else
  [ -s "$file" ] || (umask 077 && openssl rand -hex 16 | tr -d '\n' >"$file")
  gh secret set SETUP_TOKEN -R "$repo" --env "$ENVIRONMENT" <"$file"
  echo "Set SETUP_TOKEN on $ENVIRONMENT (value in $file)"
fi

echo
echo "Next: if $repo doesn't hold CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID as repository"
echo "secrets, add them to $ENVIRONMENT. Then commit $id.jsonc in the registry, and merge: CI deploys it in its ring."
echo "Then send the customer's first admin https://$DOMAIN/setup and the setup code in $file."
echo "Escrow its secrets: run the Escrow secrets workflow on $repo for $ENVIRONMENT"
echo "(docs/backup-and-restore.md, \"Escrowing secrets\")."
