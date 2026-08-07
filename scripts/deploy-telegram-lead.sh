#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FUNCTION_NAME="${YC_LEAD_FUNCTION_NAME:-zvenfit-estetika-telegram-lead}"
RUNTIME="${YC_LEAD_RUNTIME:-nodejs22}"
MEMORY="${YC_LEAD_MEMORY:-128m}"
TIMEOUT="${YC_LEAD_TIMEOUT:-10s}"
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

yc config set folder-id "${YC_FOLDER_ID}" >/dev/null

if ! yc serverless function get --name="${FUNCTION_NAME}" >/dev/null 2>&1; then
  yc serverless function create --name="${FUNCTION_NAME}"
fi

yc serverless function version create \
  --function-name="${FUNCTION_NAME}" \
  --runtime="${RUNTIME}" \
  --entrypoint=index.handler \
  --memory="${MEMORY}" \
  --execution-timeout="${TIMEOUT}" \
  --source-path="${ROOT_DIR}/functions/telegram-lead" \
  --environment TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN}" \
  --environment TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID}" \
  --environment ALLOWED_ORIGINS="${ALLOWED_ORIGINS}"

yc serverless function allow-unauthenticated-invoke "${FUNCTION_NAME}"

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
echo "LEAD_API_URL=${INVOKE_URL}"
