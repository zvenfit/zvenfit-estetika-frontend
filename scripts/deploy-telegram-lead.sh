#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$(mktemp -d /tmp/zvenfit-estetika-lead.XXXXXX)"
trap 'rm -rf -- "${SOURCE_DIR}"' EXIT
FUNCTION_NAME="${YC_LEAD_FUNCTION_NAME:-zvenfit-estetika-telegram-lead}"
TRIGGER_NAME="${YC_LEAD_RETRY_TRIGGER_NAME:-zvenfit-estetika-telegram-retry}"
YDB_DATABASE_NAME="${YDB_DATABASE_NAME:-zvenfit-estetika-leads}"
YDB_SUBMISSIONS_TABLE="${YDB_SUBMISSIONS_TABLE:-submissions}"
SUBMISSION_RETENTION_DAYS="${SUBMISSION_RETENTION_DAYS:-1096}"
MAX_TELEGRAM_ATTEMPTS="${MAX_TELEGRAM_ATTEMPTS:-12}"
RUNTIME="${YC_LEAD_RUNTIME:-nodejs22}"
MEMORY="${YC_LEAD_MEMORY:-256m}"
TIMEOUT="${YC_LEAD_TIMEOUT:-30s}"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://estetika.zvenfit.ru,https://www.estetika.zvenfit.ru}"

if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]]; then
  echo "deploy-telegram-lead: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID" >&2
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
    yc ydb database create \
      --name="${YDB_DATABASE_NAME}" \
      --description="Durable ZvenFit Estetika form submissions" \
      --serverless \
      --sls-storage-size=1GB \
      --deletion-protection
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

if ! yc serverless function get --name="${FUNCTION_NAME}" >/dev/null 2>&1; then
  yc serverless function create --name="${FUNCTION_NAME}"
fi

cp \
  "${ROOT_DIR}/functions/telegram-lead/index.js" \
  "${ROOT_DIR}/functions/telegram-lead/handler.js" \
  "${ROOT_DIR}/functions/telegram-lead/submission-store.js" \
  "${ROOT_DIR}/functions/telegram-lead/package.json" \
  "${ROOT_DIR}/functions/telegram-lead/package-lock.json" \
  "${SOURCE_DIR}/"

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
  --environment SUBMISSION_RETENTION_DAYS="${SUBMISSION_RETENTION_DAYS}" \
  --environment MAX_TELEGRAM_ATTEMPTS="${MAX_TELEGRAM_ATTEMPTS}"

yc serverless function allow-unauthenticated-invoke "${FUNCTION_NAME}"

if yc serverless trigger get --name="${TRIGGER_NAME}" >/dev/null 2>&1; then
  yc serverless trigger update timer \
    --name="${TRIGGER_NAME}" \
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
