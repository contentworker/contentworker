#!/usr/bin/env bash
# Ships the checked-out commit to your install: render the Workers' configs, collect secrets, record
# a D1 bookmark, migrate, deploy the Workers, smoke-test, and roll back on a failure. See
# docs/deployment.md.
#
#   pnpm contentworker:deploy [--env-file <path>]
#
# Reads the install's settings from the environment and its settings file (.env by default), and
# its secrets from the environment or the secrets file scripts/setup.sh wrote. Deploys with
# wrangler's login, or CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (required in CI). Run it as
# `pnpm contentworker:deploy` (or in CI); started directly, it refuses unless CONTENTWORKER_DEPLOY=1.
set -euo pipefail
env_file=.env
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) env_file="${2:?--env-file needs a path}"; shift 2 ;;
    *) echo "usage: pnpm contentworker:deploy [--env-file <path>]" >&2; exit 2 ;;
  esac
done
if [ "${GITHUB_ACTIONS:-}" != true ] && [ "${CONTENTWORKER_DEPLOY:-}" != 1 ]; then
  echo "This ships to production. Run it as \`pnpm contentworker:deploy\`, or set CONTENTWORKER_DEPLOY=1." >&2
  exit 1
fi
cd "$(dirname "$0")/.."

# The commit being shipped: the checkout's, which a workflow_run job's GITHUB_SHA is not.
sha="${DEPLOY_SHA:-$(git rev-parse HEAD)}"
short="${sha::7}"
config="wrangler.deploy.json"
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/deploy.XXXXXX")
current="start"
group_open=""
cancelled=""
app_live=""
# What deployed, so a failure rolls back only those.
engine_deployed=""
media_deployed=""
api_deployed=""
delivery_deployed=""
web_deployed=""

# A titled, collapsible section of the Actions log (a heading elsewhere). `current` names it in the
# failure message.
step() {
  current="$1"
  if [ "${GITHUB_ACTIONS:-}" != true ]; then
    printf '\n== %s\n' "$1"
    return
  fi
  [ -n "$group_open" ] && echo "::endgroup::"
  echo "::group::$1"
  group_open=1
}

summary() {
  echo "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$1" >>"$GITHUB_STEP_SUMMARY"; fi
}

# The Cloudflare API sometimes fails a request outright and succeeds on the next try. Everything
# retried here is idempotent.
retry() {
  local attempt
  for attempt in 1 2 3; do
    if "$@"; then return 0; fi
    echo "::warning::attempt $attempt failed: $*" >&2
    if [ "$attempt" -lt 3 ]; then sleep $((attempt * 15)); fi
  done
  return 1
}

# rollback <name> <pnpm filter>: 0 rolled back, 2 no earlier version, 1 failed.
rollback() {
  local name=$1 filter=$2 out attempt
  for attempt in 1 2 3; do
    if out=$(pnpm --filter "$filter" exec wrangler rollback -y -m "Deploy failed for $short" --config "$config" </dev/null 2>&1); then
      printf '%s\n' "$out"
      summary "Rolled back $name"
      return 0
    fi
    printf '%s\n' "$out"
    if grep -q 'Could not find stable Worker Version to rollback to' <<<"$out"; then
      echo "::notice::$name has no earlier version (its first deploy), so it stays as it is"
      return 2
    fi
    echo "::warning::attempt $attempt to roll back $name failed"
    if [ "$attempt" -lt 3 ]; then sleep $((attempt * 15)); fi
  done
  echo "::error::$name could not be rolled back; it is still on $short"
  return 1
}

# Any failure after the engine shipped puts each Worker that deployed back on its previous version,
# engine first: it is the one that can refuse (Cloudflare won't roll a Worker back past a Durable
# Object migration). If it can't go back, nothing else is rolled back either, so a new engine never
# runs behind old Workers that bind it; a person decides. A first deploy has no earlier version and
# stays. D1 migrations are not rolled back, which is why they must be additive.
roll_back_app() {
  local engine=0
  rollback engine @contentworker/engine || engine=$?
  if [ "$engine" = 1 ]; then
    echo "::error::The engine could not be rolled back (a Durable Object migration since its last version prevents it), so the other Workers were left on $short to match it. Fix forward."
    return
  fi
  if [ -n "$media_deployed" ]; then rollback media @contentworker/media || true; fi
  if [ -n "$api_deployed" ]; then rollback api @contentworker/api || true; fi
  if [ -n "$delivery_deployed" ]; then rollback delivery @contentworker/delivery || true; fi
  if [ -n "$web_deployed" ]; then rollback web @contentworker/web || true; fi
}

finish() {
  local rc=$?
  trap - EXIT
  set +e
  # First: nothing below needs the secrets files, and a second signal can end this function.
  rm -rf "$work"
  local failed_at=$current
  if [ "$rc" != 0 ]; then
    echo
    echo "::error::Deploy failed at: $failed_at"
    # A cancelled or timed-out deploy doesn't roll back: a person decides what happens next.
    if [ -z "$cancelled" ] && [ -n "$engine_deployed" ] && [ -z "$app_live" ]; then
      step "Roll back"
      roll_back_app
    fi
  fi
  [ -n "$group_open" ] && echo "::endgroup::"
  # Last, so it is what a truncated failure log ends on.
  if [ "$rc" != 0 ]; then echo "::error::Deploy failed at: $failed_at"; fi
  exit "$rc"
}
trap finish EXIT
# Bash runs these once the current command returns. A cancel during a long `wrangler deploy` may
# instead end in the runner's SIGKILL, which no trap sees; deploy.yml `exec`s this script so that kill
# reaches it. A closed log pipe counts as a cancel, so it can't start a rollback.
trap 'cancelled=1; exit 130' INT TERM HUP PIPE

# A merge that silently skips its deploy looks like a deploy: fail instead. On a workstation,
# wrangler's own login will do.
step "Check deploy credentials"
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  if [ "${GITHUB_ACTIONS:-}" = true ]; then
    echo "::error::CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set to deploy"
    exit 1
  fi
  if ! pnpm --filter @contentworker/engine exec wrangler whoami >/dev/null 2>&1; then
    echo "Not signed in to Cloudflare: run \`pnpm --filter @contentworker/engine exec wrangler login\`, or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID." >&2
    exit 1
  fi
fi

step "Render config"
eval "$(node scripts/install.ts names --settings "$env_file")"
config="$DEPLOY_CONFIG"
# The database and KV namespace ids, looked up by the names scripts/setup.sh created them with
# (or given as D1_ID and KV_ID).
lookup_d1() {
  pnpm --filter @contentworker/engine exec wrangler d1 list --json </dev/null |
    sed -n '/^\[/,$p' | jq -er --arg n "$D1" '.[] | select(.name == $n) | .uuid'
}
lookup_kv() {
  pnpm --filter @contentworker/engine exec wrangler kv namespace list </dev/null |
    sed -n '/^\[/,$p' | jq -er --arg t "$KV" '.[] | select(.title == $t) | .id'
}
if [ -z "${D1_ID:-}" ]; then
  D1_ID=$(retry lookup_d1) || { echo "::error::no D1 database $D1: run scripts/setup.sh first"; exit 1; }
fi
if [ -z "${KV_ID:-}" ]; then
  KV_ID=$(retry lookup_kv) || { echo "::error::no KV namespace $KV: run scripts/setup.sh first"; exit 1; }
fi
export D1_ID KV_ID
node scripts/install.ts render --settings "$env_file"

# Only the secrets that are set; `--secrets-file` adds to a Worker's secrets and never removes one,
# so a secret set by hand survives. The engine's ASSISTANT_PRINCIPAL_KEY and
# ASSISTANT_PRINCIPAL_KEY_PREVIOUS aren't set anywhere: `install.ts secrets` derives them from
# PRINCIPAL_KEY and PRINCIPAL_KEY_PREVIOUS (HKDF, scripts/derive-assistant-key.ts) straight into the
# engine's secrets file, never printing them.
step "Collect secrets"
for app in engine media api delivery web; do
  node scripts/install.ts secrets "$app" "$work/$app-secrets.json" --settings "$env_file"
done
# Nothing after this needs them in the environment, and builds and their dependencies shouldn't see
# them: from here each Worker's secrets exist only in its 0600 file.
unset PRINCIPAL_KEY PRINCIPAL_KEY_PREVIOUS DATA_KEY DATA_KEY_PREVIOUS TOKEN_PEPPER \
  MEDIA_SIGNING_SECRET PASSWORD_PEPPER SETUP_TOKEN OIDC_CLIENT_SECRET STREAM_WEBHOOK_SECRET \
  MCP_TOKEN ADMIN_TOKEN

# The restore point for this deploy: a migration can't be rolled back, but D1 Time Travel can
# restore the database to this bookmark (docs/backup-and-restore.md).
step "Record D1 bookmark"
read_bookmark() {
  pnpm --filter @contentworker/engine exec wrangler d1 time-travel info DB --json --config "$config" >"$work/d1-bookmark.json"
}
retry read_bookmark
bookmark=$(jq -er .bookmark "$work/d1-bookmark.json")
summary "D1 bookmark before $short: \`$bookmark\`"
echo "::notice::D1 bookmark before this deploy: $bookmark"

# Migrations run before the new code, and old code runs against the new schema until the Workers
# below are live: a migration must be additive (expand).
step "Migrate D1"
retry pnpm --filter @contentworker/engine exec wrangler d1 migrations apply DB --remote --config "$config"

# secrets_flag <app>: fills `flag` with this app's --secrets-file, or nothing when it has none.
flag=()
secrets_flag() {
  flag=()
  if [ "$(cat "$work/$1-secrets.json")" != "{}" ]; then flag=(--secrets-file "$work/$1-secrets.json"); fi
}

# The engine owns every Durable Object and Workflow class the others bind by script name, so it goes
# first; then media, so it already verifies the URLs the api and delivery hand out; then the api,
# delivery, and the web app that fronts the api.
for app in engine media api delivery; do
  step "Deploy $app"
  secrets_flag "$app"
  retry pnpm --filter "@contentworker/$app" exec wrangler deploy --config "$config" ${flag[@]+"${flag[@]}"}
  printf -v "${app}_deployed" 1
done

step "Build web"
CONTENTWORKER_WRANGLER_CONFIG="$config" pnpm --filter @contentworker/web build

# `wrangler deploy` picks up the build's own config (.wrangler/deploy), made from $config.
step "Deploy web"
secrets_flag web
retry pnpm --filter @contentworker/web exec wrangler deploy ${flag[@]+"${flag[@]}"}
web_deployed=1

# A new domain's certificate can take a few minutes to issue, so each check retries for up to five
# minutes before it counts as failed.
get() { curl -fsS --retry 30 --retry-all-errors --retry-delay 10 --retry-max-time 300 "$@"; }

step "Smoke test"
# Prints the body and ends its line, so what follows in the log still parses as a command.
show() { get "$@"; echo; }
show "https://$DOMAIN/health"
# D1 and the api (over the service binding) both answer.
show "https://$DOMAIN/health/deep"
# The admin itself renders (sign-in, or setup on a deployment with no people yet). Asked as a browser
# asks: before setup a page request redirects to /setup, anything else is a 503.
get -L -o /dev/null -H 'Accept: text/html' "https://$DOMAIN/login"
show "https://$API_DOMAIN/health"
get -o /dev/null "https://$API_DOMAIN/openapi.json"
show "https://$CDN_DOMAIN/health"
show "https://$MEDIA_DOMAIN/health"
# The media origin serves nothing it wasn't told to: an unknown asset is a 404.
status=$(curl -s -o /dev/null -w '%{http_code}' "https://$MEDIA_DOMAIN/smoke/main/none/v1/o/none")
[ "$status" = 404 ] || { echo "::error::an unknown media URL answered $status, not 404"; exit 1; }
# Delivery refuses an anonymous read (auth runs before its cache).
status=$(curl -s -o /dev/null -w '%{http_code}' "https://$CDN_DOMAIN/delivery/smoke/main/entries")
[ "$status" = 401 ] || { echo "::error::anonymous delivery read answered $status, not 401"; exit 1; }

# Warns rather than fails: a slow runner must not roll production back. Best of three.
check_latency() {
  local url=$1 budget=$2 best=999 t
  for _ in 1 2 3; do
    t=$(curl -fsSL -o /dev/null -H 'Accept: text/html' -w '%{time_total}' "$url") || continue
    best=$(awk -v a="$t" -v b="$best" 'BEGIN { print (a < b) ? a : b }')
  done
  echo "$url: ${best}s (budget ${budget}s)"
  if awk -v a="$best" -v b="$budget" 'BEGIN { exit !(a > b) }'; then
    echo "::warning title=Latency budget::$url took ${best}s, over its ${budget}s budget"
  fi
}
step "Latency check"
check_latency "https://$DOMAIN/login" 1.5 || true
check_latency "https://$DOMAIN/health/deep" 1.0 || true
check_latency "https://$CDN_DOMAIN/health" 0.3 || true

# The app is live: nothing below can roll it back.
app_live=1
summary "Deployed $short to https://$DOMAIN"
