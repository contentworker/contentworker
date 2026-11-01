#!/usr/bin/env bash
# Creates the Cloudflare resources and the GitHub environment for one deployment in
# deployments/<id>.jsonc, and records its D1 and KV ids there. Safe to re-run: existing resources,
# and secrets already set, are kept. See docs/deployment.md.
#
#   ./scripts/provision.sh <id>
#
# Needs `wrangler login` (or CLOUDFLARE_API_TOKEN) and `gh auth login`. The AI Gateway is created
# through the API, so it also needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID; without them
# it prints what to create instead.
set -euo pipefail
id="${1:?usage: scripts/provision.sh <id>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

eval "$(node scripts/fleet.ts names "$id")"
wrangler() { pnpm --filter @contentworker/engine exec wrangler "$@"; }
j=()
[ -n "$JURISDICTION" ] && j=(--jurisdiction "$JURISDICTION")

echo "== $id: D1 $D1, KV $KV, R2 $MEDIA, index ${VECTORS:-none}, gateway $AI_GATEWAY"
echo "   https://$DOMAIN (admin), https://$API_DOMAIN (api), https://$CDN_DOMAIN (delivery); environment $ENVIRONMENT"

# D1, the system of record, with read replication on: delivery and admin reads go to the nearest
# replica (the Workers open Sessions API sessions; writes always go to the primary).
wrangler d1 create "$D1" ${j[@]+"${j[@]}"} || echo "D1 database $D1 already exists"
uuid=$(wrangler d1 info "$D1" --json | jq -er .uuid)
node scripts/fleet.ts set-d1 "$id" "$uuid"
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  curl -fsS -X PUT "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database/$uuid" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' \
    --data '{"read_replication":{"mode":"auto"}}' >/dev/null && echo "D1 read replication: auto"
else
  echo "Turn on read replication for $D1 (dashboard: D1 > $D1 > Settings), or re-run with CLOUDFLARE_API_TOKEN."
fi

# The KV namespace the api, engine and delivery share (delivery cache, cached principals).
kv_id() { wrangler kv namespace list | jq -er --arg t "$KV" '.[] | select(.title == $t) | .id'; }
kv=$(kv_id 2>/dev/null) || { wrangler kv namespace create "$KV" >/dev/null; kv=$(kv_id); }
node scripts/fleet.ts set-kv "$id" "$kv"

# Media, import staging, plugin bundles and dead letters. Staged imports and dead letters expire.
wrangler r2 bucket create "$MEDIA" ${j[@]+"${j[@]}"} || echo "R2 bucket $MEDIA already exists"
for rule in "imports imports/ 7" "dlq dlq/ 30"; do
  set -- $rule
  wrangler r2 bucket lifecycle remove "$MEDIA" --name "$1" ${j[@]+"${j[@]}"} >/dev/null 2>&1 || true
  wrangler r2 bucket lifecycle add "$MEDIA" "$1" "$2" --expire-days "$3" --force ${j[@]+"${j[@]}"}
done

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

# Queues: domain events (+ dead letters), bulk chunks, agent jobs, delivery purges (+ dead letters).
for q in $QUEUES; do
  if wrangler queues info "$q" >/dev/null 2>&1; then echo "Queue $q already exists"
  else wrangler queues create "$q"; fi
  wrangler queues update "$q" --message-retention-period-secs 1209600 >/dev/null
done

# The AI Gateway every model call goes through.
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  api="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai-gateway/gateways"
  if curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$api/$AI_GATEWAY" >/dev/null 2>&1; then
    echo "AI Gateway $AI_GATEWAY already exists"
  else
    curl -fsS -X POST "$api" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      -H 'Content-Type: application/json' \
      --data "$(jq -n --arg id "$AI_GATEWAY" --argjson logs "$AI_GATEWAY_LOGS" '{
        id: $id, authentication: true, collect_logs: $logs,
        log_management: 100000, log_management_strategy: "DELETE_OLDEST",
        cache_ttl: 0, cache_invalidate_on_update: false,
        rate_limiting_limit: 120, rate_limiting_interval: 60, rate_limiting_technique: "sliding",
        retry_max_attempts: 3, retry_delay: 500, retry_backoff: "exponential"
      }')" >/dev/null
    echo "Created AI Gateway $AI_GATEWAY"
  fi
else
  echo "Skipped the AI Gateway: set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or create"
  echo "\"$AI_GATEWAY\" in the dashboard (AI > AI Gateway)."
fi

# The GitHub environment the deploy job runs in, and its secrets. A secret already set is left
# alone. DATA_KEY seals every stored secret and TOKEN_PEPPER is in every API key hash, and
# PASSWORD_PEPPER in every password hash: once a deployment runs, none may change, so none is
# generated while its api Worker already holds one. None is ever written to disk.
gh api --method PUT "repos/{owner}/{repo}/environments/$ENVIRONMENT" >/dev/null
API_WORKER="contentworker-api$SUFFIX"
EXISTING=$(gh secret list --env "$ENVIRONMENT" --json name -q '.[].name')
WORKER_SECRETS=""
if WORKER_SECRETS=$(wrangler secret list --name "$API_WORKER" 2>/dev/null); then
  WORKER_SECRETS=$(jq -r '.[].name' <<<"$WORKER_SECRETS" 2>/dev/null || true)
fi
# The engine's ASSISTANT_PRINCIPAL_KEY (and _PREVIOUS) isn't generated here: it is derived from
# PRINCIPAL_KEY (and PRINCIPAL_KEY_PREVIOUS) at every deploy, by `fleet.ts secrets`, so a new
# deployment gets it on its first deploy and a rotation of PRINCIPAL_KEY carries it along.
for KEY in PRINCIPAL_KEY DATA_KEY TOKEN_PEPPER MEDIA_SIGNING_SECRET PASSWORD_PEPPER; do
  if grep -qx "$KEY" <<<"$EXISTING"; then
    echo "$ENVIRONMENT already has $KEY"
  elif [ "$KEY" != PRINCIPAL_KEY ] && [ "$KEY" != MEDIA_SIGNING_SECRET ] && grep -qx "$KEY" <<<"$WORKER_SECRETS"; then
    echo "$ENVIRONMENT has no $KEY, but $API_WORKER already holds one. Set the deployment's own"
    echo "value on $ENVIRONMENT from its escrowed copy; a new one would make what it protects unreadable."
    exit 1
  else
    openssl rand -hex 32 | tr -d '\n' | gh secret set "$KEY" --env "$ENVIRONMENT"
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
  gh secret set SETUP_TOKEN --env "$ENVIRONMENT" <"$file"
  echo "Set SETUP_TOKEN on $ENVIRONMENT (value in $file)"
fi

echo
echo "Next: add CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID to $ENVIRONMENT if they aren't"
echo "repository secrets, commit deployments/$id.jsonc, and merge: CI deploys it in its ring."
echo "Then send the customer's first admin https://$DOMAIN/setup and the setup code in $file."
