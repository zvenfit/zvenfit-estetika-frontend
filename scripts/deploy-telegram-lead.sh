#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$(mktemp -d /tmp/zvenfit-estetika-lead.XXXXXX)"
trap 'rm -rf -- "${SOURCE_DIR}"' EXIT
FUNCTION_NAME="${YC_LEAD_FUNCTION_NAME:-zvenfit-estetika-telegram-lead}"
TRIGGER_NAME="${YC_LEAD_RETRY_TRIGGER_NAME:-zvenfit-estetika-telegram-retry}"
YDB_DATABASE_NAME="${YDB_DATABASE_NAME:-zvenfit-estetika-leads}"
YDB_SUBMISSIONS_TABLE="${YDB_SUBMISSIONS_TABLE:-submissions}"
YDB_RATE_LIMITS_TABLE="${YDB_RATE_LIMITS_TABLE:-submission_rate_limits}"
LEAD_RATE_LIMIT_MAX="${LEAD_RATE_LIMIT_MAX:-5}"
LEAD_RATE_LIMIT_WINDOW_SECONDS="${LEAD_RATE_LIMIT_WINDOW_SECONDS:-600}"
MAX_TELEGRAM_ATTEMPTS="${MAX_TELEGRAM_ATTEMPTS:-12}"
TELEGRAM_RETRY_BATCH_SIZE="${TELEGRAM_RETRY_BATCH_SIZE:-5}"
TELEGRAM_TIMEOUT_MS="${TELEGRAM_TIMEOUT_MS:-15000}"
YDB_QUERY_TIMEOUT_MS="${YDB_QUERY_TIMEOUT_MS:-5000}"
YDB_SLOW_OPERATION_MS="${YDB_SLOW_OPERATION_MS:-1000}"
YDB_SESSION_POOL_SIZE="${YDB_SESSION_POOL_SIZE:-5}"
RUNTIME="${YC_LEAD_RUNTIME:-nodejs22}"
MEMORY="${YC_LEAD_MEMORY:-256m}"
TIMEOUT="${YC_LEAD_TIMEOUT:-120s}"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://estetika.zvenfit.ru,https://www.estetika.zvenfit.ru}"
LOG_LEVEL="${LOG_LEVEL:-info}"

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

if [[ -z "${YC_LEAD_SERVICE_ACCOUNT_ID:-}" ]]; then
  echo "deploy-telegram-lead: set YC_LEAD_SERVICE_ACCOUNT_ID for YDB access and timer invocation" >&2
  exit 1
fi

yc config set folder-id "${YC_FOLDER_ID}" >/dev/null

if [[ -z "${YDB_CONNECTION_STRING:-}" ]]; then
  if ! yc ydb database get --name="${YDB_DATABASE_NAME}" >/dev/null 2>&1; then
    echo "deploy-telegram-lead: YDB database ${YDB_DATABASE_NAME} must be provisioned before CI deploy" >&2
    exit 1
  fi

  YDB_CONNECTION_STRING="$(yc ydb database get --name="${YDB_DATABASE_NAME}" --format=json | node -e "
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(data.endpoint || '');
")"
fi

if [[ -z "${YDB_CONNECTION_STRING}" ]]; then
  echo "deploy-telegram-lead: YDB connection string is empty" >&2
  exit 1
fi

YDB_IAM_TOKEN="$(yc iam create-token)"

YDB_TEST_CONNECTION_STRING="${YDB_CONNECTION_STRING}" \
YDB_ACCESS_TOKEN_CREDENTIALS="${YDB_IAM_TOKEN}" \
npm --prefix "${ROOT_DIR}/functions/telegram-lead" run test:integration

YDB_ACCESS_TOKEN_CREDENTIALS="${YDB_IAM_TOKEN}" \
YDB_CONNECTION_STRING="${YDB_CONNECTION_STRING}" \
YDB_SUBMISSIONS_TABLE="${YDB_SUBMISSIONS_TABLE}" \
YDB_RATE_LIMITS_TABLE="${YDB_RATE_LIMITS_TABLE}" \
YDB_QUERY_TIMEOUT_MS="${YDB_QUERY_TIMEOUT_MS}" \
npm --prefix "${ROOT_DIR}/functions/telegram-lead" run migrate

unset YDB_IAM_TOKEN

if ! yc serverless function get --name="${FUNCTION_NAME}" >/dev/null 2>&1; then
  yc serverless function create --name="${FUNCTION_NAME}"
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

cp -R "${ROOT_DIR}/functions/telegram-lead/build/." "${SOURCE_DIR}/"
cp \
  "${ROOT_DIR}/functions/telegram-lead/package.json" \
  "${ROOT_DIR}/functions/telegram-lead/package-lock.json" \
  "${SOURCE_DIR}/"

npm pkg delete devDependencies --prefix "${SOURCE_DIR}"

yc serverless function version create \
  --function-name="${FUNCTION_NAME}" \
  --runtime="${RUNTIME}" \
  --entrypoint=index.handler \
  --memory="${MEMORY}" \
  --execution-timeout="${TIMEOUT}" \
  --source-path="${SOURCE_DIR}" \
  --service-account-id="${YC_LEAD_SERVICE_ACCOUNT_ID}" \
  --environment TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN}" \
  --environment TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID}" \
  --environment ALLOWED_ORIGINS="${ALLOWED_ORIGINS}" \
  --environment YDB_CONNECTION_STRING="${YDB_CONNECTION_STRING}" \
  --environment YDB_SUBMISSIONS_TABLE="${YDB_SUBMISSIONS_TABLE}" \
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
  --environment LOG_LEVEL="${LOG_LEVEL}" \
  --environment NODE_ENV="${NODE_ENV:-production}"

if yc serverless trigger get --name="${TRIGGER_NAME}" >/dev/null 2>&1; then
  TRIGGER_ID="$(yc serverless trigger get --name="${TRIGGER_NAME}" --format=json | node -e "
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(data.id || '');
")"
  if [[ -z "${TRIGGER_ID}" ]]; then
    echo "deploy-telegram-lead: failed to resolve trigger id for ${TRIGGER_NAME}" >&2
    exit 1
  fi

  yc serverless trigger update timer \
    --id="${TRIGGER_ID}" \
    --new-cron-expression='* * * * ? *' \
    --new-payload='retry-telegram' \
    --new-invoke-function-name="${FUNCTION_NAME}" \
    --new-invoke-function-service-account-id="${YC_LEAD_SERVICE_ACCOUNT_ID}" \
    --new-function-retry-attempts=2 \
    --new-function-retry-interval=30s
else
  yc serverless trigger create timer \
    --name="${TRIGGER_NAME}" \
    --description="Retry pending ZvenFit Estetika Telegram notifications" \
    --cron-expression='* * * * ? *' \
    --payload='retry-telegram' \
    --invoke-function-name="${FUNCTION_NAME}" \
    --invoke-function-service-account-id="${YC_LEAD_SERVICE_ACCOUNT_ID}" \
    --retry-attempts=2 \
    --retry-interval=30s
fi

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
