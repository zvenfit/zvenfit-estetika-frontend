#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FUNCTION_SOURCE_DIR="${FUNCTION_SOURCE_DIR:-}"
PACKAGE_TEMP_DIR=''
cleanup() {
  if [[ -n "${PACKAGE_TEMP_DIR}" ]]; then
    rm -rf -- "${PACKAGE_TEMP_DIR}"
  fi
}
trap cleanup EXIT
FUNCTION_NAME="${YC_LEAD_FUNCTION_NAME:-zvenfit-estetika-telegram-lead}"
TRIGGER_NAME="${YC_LEAD_RETRY_TRIGGER_NAME:-zvenfit-estetika-telegram-retry}"
YDB_DATABASE_NAME="${YDB_DATABASE_NAME:-zvenfit-estetika-leads}"
YDB_DATABASE_ID="${YDB_DATABASE_ID:-}"
YDB_LEADS_TABLE="${YDB_LEADS_TABLE:-leads}"
YDB_NEWSLETTER_SUBSCRIPTIONS_TABLE="${YDB_NEWSLETTER_SUBSCRIPTIONS_TABLE:-newsletter_subscriptions}"
YDB_NEWSLETTER_CONSENT_EVENTS_TABLE="${YDB_NEWSLETTER_CONSENT_EVENTS_TABLE:-newsletter_consent_events}"
YDB_TELEGRAM_OUTBOX_TABLE="${YDB_TELEGRAM_OUTBOX_TABLE:-telegram_outbox}"
YDB_RATE_LIMITS_TABLE="${YDB_RATE_LIMITS_TABLE:-form_rate_limits}"
LEAD_RATE_LIMIT_MAX="${LEAD_RATE_LIMIT_MAX:-5}"
LEAD_RATE_LIMIT_WINDOW_SECONDS="${LEAD_RATE_LIMIT_WINDOW_SECONDS:-600}"
MAX_TELEGRAM_ATTEMPTS="${MAX_TELEGRAM_ATTEMPTS:-12}"
TELEGRAM_RETRY_BATCH_SIZE="${TELEGRAM_RETRY_BATCH_SIZE:-5}"
TELEGRAM_TIMEOUT_MS="${TELEGRAM_TIMEOUT_MS:-15000}"
YDB_QUERY_TIMEOUT_MS="${YDB_QUERY_TIMEOUT_MS:-10000}"
YDB_SLOW_OPERATION_MS="${YDB_SLOW_OPERATION_MS:-3000}"
YDB_SESSION_POOL_SIZE="${YDB_SESSION_POOL_SIZE:-5}"
RUNTIME="${YC_LEAD_RUNTIME:-nodejs22}"
MEMORY="${YC_LEAD_MEMORY:-256m}"
TIMEOUT="${YC_LEAD_TIMEOUT:-120s}"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://estetika.zvenfit.ru}"
LOG_LEVEL="${LOG_LEVEL:-info}"
MONIUM_METRICS_ENABLED="${MONIUM_METRICS_ENABLED:-true}"
MONIUM_PROJECT="${MONIUM_PROJECT:-folder__${YC_FOLDER_ID:-}}"
MONIUM_CLUSTER="${MONIUM_CLUSTER:-default}"
MONIUM_SERVICE="${MONIUM_SERVICE:-zvenfit-estetika-frontend}"
MONIUM_APPLICATION="${MONIUM_APPLICATION:-zvenfit-estetika-frontend}"
MONIUM_ENVIRONMENT="${MONIUM_ENVIRONMENT:-production}"
MONIUM_COMPONENT="${MONIUM_COMPONENT:-zvenfit-estetika-telegram-lead}"
MONIUM_RESOURCE_ID="${MONIUM_RESOURCE_ID:-${FUNCTION_NAME}}"
MONIUM_METRICS_TIMEOUT_MS="${MONIUM_METRICS_TIMEOUT_MS:-3000}"

if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" || -z "${LEAD_RATE_LIMIT_SECRET:-}" ]]; then
  echo "deploy-telegram-lead: set TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID and LEAD_RATE_LIMIT_SECRET" >&2
  exit 1
fi

if (( ${#LEAD_RATE_LIMIT_SECRET} < 32 )); then
  echo "deploy-telegram-lead: LEAD_RATE_LIMIT_SECRET must contain at least 32 characters" >&2
  exit 1
fi

if ! command -v yc >/dev/null 2>&1; then
  echo "deploy-telegram-lead: install Yandex Cloud CLI (yc)" >&2
  exit 1
fi

if [[ -z "${YC_FOLDER_ID:-}" ]]; then
  echo "deploy-telegram-lead: set YC_FOLDER_ID" >&2
  exit 1
fi

if [[ "${MONIUM_METRICS_ENABLED}" == "true" || "${MONIUM_METRICS_ENABLED}" == "1" ]]; then
  if [[ -z "${MONIUM_API_KEY:-}" || -z "${MONIUM_PROJECT}" ]]; then
    echo "deploy-telegram-lead: enabled Monium metrics require MONIUM_API_KEY and MONIUM_PROJECT" >&2
    exit 1
  fi
fi

if [[ -z "${YC_LEAD_SERVICE_ACCOUNT_ID:-}" ]]; then
  echo "deploy-telegram-lead: set YC_LEAD_SERVICE_ACCOUNT_ID for YDB access and timer invocation" >&2
  exit 1
fi

if [[ -z "${FUNCTION_SOURCE_DIR}" ]]; then
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    echo 'deploy-telegram-lead: CI requires a prebuilt FUNCTION_SOURCE_DIR artifact' >&2
    exit 1
  fi

  PACKAGE_TEMP_DIR="$(mktemp -d /tmp/zvenfit-estetika-lead.XXXXXX)"
  npm --prefix "${ROOT_DIR}/functions/telegram-lead" run build
  bash "${ROOT_DIR}/scripts/package-telegram-lead.sh" "${PACKAGE_TEMP_DIR}"
  FUNCTION_SOURCE_DIR="${PACKAGE_TEMP_DIR}"
fi

if [[ ! -f "${FUNCTION_SOURCE_DIR}/index.js" || ! -f "${FUNCTION_SOURCE_DIR}/package.json" ]]; then
  echo 'deploy-telegram-lead: FUNCTION_SOURCE_DIR is not a deployable artifact' >&2
  exit 1
fi

yc config set folder-id "${YC_FOLDER_ID}" >/dev/null

if [[ -z "${YDB_CONNECTION_STRING:-}" ]]; then
  if [[ -n "${YDB_DATABASE_ID}" ]]; then
    YDB_DATABASE_SELECTOR=(--id="${YDB_DATABASE_ID}")
    YDB_DATABASE_LABEL="${YDB_DATABASE_ID}"
  else
    YDB_DATABASE_SELECTOR=(--name="${YDB_DATABASE_NAME}")
    YDB_DATABASE_LABEL="${YDB_DATABASE_NAME}"
  fi

  if ! yc ydb database get "${YDB_DATABASE_SELECTOR[@]}" >/dev/null 2>&1; then
    echo "deploy-telegram-lead: YDB database ${YDB_DATABASE_LABEL} must be provisioned and accessible before CI deploy" >&2
    exit 1
  fi

  YDB_CONNECTION_STRING="$(yc ydb database get "${YDB_DATABASE_SELECTOR[@]}" --format=json | node -e "
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(data.endpoint || '');
")"
fi

if [[ -z "${YDB_CONNECTION_STRING}" ]]; then
  echo "deploy-telegram-lead: YDB connection string is empty" >&2
  exit 1
fi

if ! yc serverless function get --name="${FUNCTION_NAME}" >/dev/null 2>&1; then
  echo "deploy-telegram-lead: function ${FUNCTION_NAME} must be provisioned before CI deploy" >&2
  exit 1
fi

if ! yc serverless function list-access-bindings --name="${FUNCTION_NAME}" --format=json | node -e "
const fs = require('fs');
const bindings = JSON.parse(fs.readFileSync(0, 'utf8'));
const publicInvoker = bindings.some(binding =>
  binding.role_id === 'functions.functionInvoker' &&
  binding.subject?.type === 'system' &&
  binding.subject?.id === 'allUsers'
);
process.exit(publicInvoker ? 0 : 1);
"; then
  echo "deploy-telegram-lead: ${FUNCTION_NAME} is missing the one-time public functionInvoker binding" >&2
  echo "Run with an admin identity: yc serverless function allow-unauthenticated-invoke ${FUNCTION_NAME}" >&2
  exit 1
fi

yc serverless function version create \
  --function-name="${FUNCTION_NAME}" \
  --runtime="${RUNTIME}" \
  --entrypoint=index.handler \
  --memory="${MEMORY}" \
  --execution-timeout="${TIMEOUT}" \
  --source-path="${FUNCTION_SOURCE_DIR}" \
  --service-account-id="${YC_LEAD_SERVICE_ACCOUNT_ID}" \
  --environment TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN}" \
  --environment TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID}" \
  --environment ALLOWED_ORIGINS="${ALLOWED_ORIGINS}" \
  --environment YDB_CONNECTION_STRING="${YDB_CONNECTION_STRING}" \
  --environment YDB_LEADS_TABLE="${YDB_LEADS_TABLE}" \
  --environment YDB_NEWSLETTER_SUBSCRIPTIONS_TABLE="${YDB_NEWSLETTER_SUBSCRIPTIONS_TABLE}" \
  --environment YDB_NEWSLETTER_CONSENT_EVENTS_TABLE="${YDB_NEWSLETTER_CONSENT_EVENTS_TABLE}" \
  --environment YDB_TELEGRAM_OUTBOX_TABLE="${YDB_TELEGRAM_OUTBOX_TABLE}" \
  --environment YDB_RATE_LIMITS_TABLE="${YDB_RATE_LIMITS_TABLE}" \
  --environment LEAD_RATE_LIMIT_SECRET="${LEAD_RATE_LIMIT_SECRET}" \
  --environment LEAD_RATE_LIMIT_MAX="${LEAD_RATE_LIMIT_MAX}" \
  --environment LEAD_RATE_LIMIT_WINDOW_SECONDS="${LEAD_RATE_LIMIT_WINDOW_SECONDS}" \
  --environment MAX_TELEGRAM_ATTEMPTS="${MAX_TELEGRAM_ATTEMPTS}" \
  --environment TELEGRAM_RETRY_BATCH_SIZE="${TELEGRAM_RETRY_BATCH_SIZE}" \
  --environment TELEGRAM_TIMEOUT_MS="${TELEGRAM_TIMEOUT_MS}" \
  --environment YDB_QUERY_TIMEOUT_MS="${YDB_QUERY_TIMEOUT_MS}" \
  --environment YDB_SLOW_OPERATION_MS="${YDB_SLOW_OPERATION_MS}" \
  --environment YDB_SESSION_POOL_SIZE="${YDB_SESSION_POOL_SIZE}" \
  --environment MONIUM_METRICS_ENABLED="${MONIUM_METRICS_ENABLED}" \
  --environment MONIUM_API_KEY="${MONIUM_API_KEY:-}" \
  --environment MONIUM_PROJECT="${MONIUM_PROJECT}" \
  --environment MONIUM_CLUSTER="${MONIUM_CLUSTER}" \
  --environment MONIUM_SERVICE="${MONIUM_SERVICE}" \
  --environment MONIUM_APPLICATION="${MONIUM_APPLICATION}" \
  --environment MONIUM_ENVIRONMENT="${MONIUM_ENVIRONMENT}" \
  --environment MONIUM_COMPONENT="${MONIUM_COMPONENT}" \
  --environment MONIUM_RESOURCE_ID="${MONIUM_RESOURCE_ID}" \
  --environment MONIUM_METRICS_TIMEOUT_MS="${MONIUM_METRICS_TIMEOUT_MS}" \
  --environment LOG_LEVEL="${LOG_LEVEL}" \
  --environment NODE_ENV="${NODE_ENV:-production}"

INVOKE_URL="$(yc serverless function get --name="${FUNCTION_NAME}" --format=json | node -e "
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(data.http_invoke_url || '');
")"

if [[ -z "${INVOKE_URL}" ]]; then
  echo "deploy-telegram-lead: function deployed, but http_invoke_url is empty" >&2
  exit 0
fi

echo "deploy-telegram-lead: OK"
echo "YDB_DATABASE_NAME=${YDB_DATABASE_NAME}"
echo "LEAD_RETRY_TRIGGER=${TRIGGER_NAME}"
echo "LEAD_API_URL=${INVOKE_URL}"
