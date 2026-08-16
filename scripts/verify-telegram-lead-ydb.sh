#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FUNCTION_DIR="${1:-${ROOT_DIR}/functions/telegram-lead}"
YDB_DATABASE_NAME="${YDB_DATABASE_NAME:-zvenfit-estetika-leads}"
YDB_DATABASE_ID="${YDB_DATABASE_ID:-}"
YDB_SUBMISSIONS_TABLE="${YDB_SUBMISSIONS_TABLE:-submissions}"
YDB_RATE_LIMITS_TABLE="${YDB_RATE_LIMITS_TABLE:-submission_rate_limits}"
YDB_QUERY_TIMEOUT_MS="${YDB_QUERY_TIMEOUT_MS:-10000}"

if [[ ! -f "${FUNCTION_DIR}/package.json" || ! -d "${FUNCTION_DIR}/node_modules" ]]; then
  echo 'verify-telegram-lead-ydb: prebuilt verifier artifact is incomplete' >&2
  exit 1
fi

for name in YC_FOLDER_ID; do
  if [[ -z "${!name:-}" ]]; then
    echo "verify-telegram-lead-ydb: ${name} is required" >&2
    exit 1
  fi
done

if ! command -v yc >/dev/null 2>&1; then
  echo 'verify-telegram-lead-ydb: Yandex Cloud CLI is required' >&2
  exit 1
fi

yc config set folder-id "${YC_FOLDER_ID}" >/dev/null
if [[ -n "${YDB_DATABASE_ID}" ]]; then
  YDB_DATABASE_SELECTOR=(--id="${YDB_DATABASE_ID}")
  YDB_DATABASE_LABEL="${YDB_DATABASE_ID}"
else
  YDB_DATABASE_SELECTOR=(--name="${YDB_DATABASE_NAME}")
  YDB_DATABASE_LABEL="${YDB_DATABASE_NAME}"
fi

if ! yc ydb database get "${YDB_DATABASE_SELECTOR[@]}" >/dev/null 2>&1; then
  echo "verify-telegram-lead-ydb: database ${YDB_DATABASE_LABEL} is unavailable" >&2
  exit 1
fi

YDB_CONNECTION_STRING="$(yc ydb database get "${YDB_DATABASE_SELECTOR[@]}" --format=json | node -e "
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(data.endpoint || '');
")"
if [[ -z "${YDB_CONNECTION_STRING}" ]]; then
  echo 'verify-telegram-lead-ydb: YDB connection string is empty' >&2
  exit 1
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'connection_string=%s\n' "${YDB_CONNECTION_STRING}" >> "${GITHUB_OUTPUT}"
fi

YDB_IAM_TOKEN="$(yc iam create-token)"
trap 'unset YDB_IAM_TOKEN' EXIT

YDB_TEST_CONNECTION_STRING="${YDB_CONNECTION_STRING}" \
YDB_ACCESS_TOKEN_CREDENTIALS="${YDB_IAM_TOKEN}" \
npm --prefix "${FUNCTION_DIR}" run test:integration

SCHEMA_VERIFY_ATTEMPT=1
SCHEMA_VERIFY_MAX_ATTEMPTS=3
while ! YDB_ACCESS_TOKEN_CREDENTIALS="${YDB_IAM_TOKEN}" \
  YDB_CONNECTION_STRING="${YDB_CONNECTION_STRING}" \
  YDB_SUBMISSIONS_TABLE="${YDB_SUBMISSIONS_TABLE}" \
  YDB_RATE_LIMITS_TABLE="${YDB_RATE_LIMITS_TABLE}" \
  YDB_QUERY_TIMEOUT_MS="${YDB_QUERY_TIMEOUT_MS}" \
  npm --prefix "${FUNCTION_DIR}" run verify:schema; do
  if (( SCHEMA_VERIFY_ATTEMPT >= SCHEMA_VERIFY_MAX_ATTEMPTS )); then
    echo "verify-telegram-lead-ydb: schema verification failed after ${SCHEMA_VERIFY_MAX_ATTEMPTS} attempts" >&2
    exit 1
  fi

  echo 'verify-telegram-lead-ydb: transient schema verification failure; retrying' >&2
  sleep $((SCHEMA_VERIFY_ATTEMPT * 2))
  SCHEMA_VERIFY_ATTEMPT=$((SCHEMA_VERIFY_ATTEMPT + 1))
done

echo 'verify-telegram-lead-ydb: integration and schema checks passed'
