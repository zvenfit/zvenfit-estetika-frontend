#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_BUCKET="${YC_S3_BUCKET:-zvenfit-estetika-frontend}"
STORAGE_ENDPOINT="${AWS_ENDPOINT_URL:-https://storage.yandexcloud.net}"
STORAGE_REGION="${AWS_REGION:-ru-1}"
REDIRECT_BODY="${SCRIPT_DIR}/redirect-object.html"

upload_redirect() {
  local object_key="$1"
  local target_path="$2"

  aws s3 cp "${REDIRECT_BODY}" "s3://${TARGET_BUCKET}/${object_key}" \
    --website-redirect "${target_path}" \
    --cache-control "no-cache, must-revalidate" \
    --content-type "text/html" \
    --endpoint-url "${STORAGE_ENDPOINT}" \
    --region "${STORAGE_REGION}"
}

upload_redirect "documents/privacy-policy.html" "/privacy/"
upload_redirect "documents/personal-data-processing.html" "/personal-data-processing/"
