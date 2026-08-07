#!/usr/bin/env bash
# Manual scoped upload: vendor CSS (minified) and webflow.js.
# Images and fonts are CDN-managed separately and are never touched by this script.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUCKET="${YC_ASSETS_BUCKET:-zvenfit-estetika}"
PREFIX="${YC_ASSETS_PREFIX:-}"
ENDPOINT="${YC_S3_ENDPOINT:-https://storage.yandexcloud.net}"
REGION="${YC_S3_REGION:-ru-1}"
STAGING="${ROOT_DIR}/.cdn-upload"

node "${ROOT_DIR}/scripts/prepare-cdn-assets.cjs"

if [[ -z "${YC_ACCESS_KEY_ID:-}" || -z "${YC_SECRET_ACCESS_KEY:-}" ]]; then
  echo "upload-assets: set YC_ACCESS_KEY_ID and YC_SECRET_ACCESS_KEY" >&2
  exit 1
fi

export AWS_ACCESS_KEY_ID="${YC_ACCESS_KEY_ID}"
export AWS_SECRET_ACCESS_KEY="${YC_SECRET_ACCESS_KEY}"
export AWS_DEFAULT_REGION="${REGION}"

if [[ -n "${PREFIX}" ]]; then
  DEST="s3://${BUCKET}/${PREFIX}"
  CDN_BASE="https://storage.yandexcloud.net/${BUCKET}/${PREFIX}"
else
  DEST="s3://${BUCKET}"
  CDN_BASE="https://storage.yandexcloud.net/${BUCKET}"
fi
sync_prefix() {
  local prefix="$1"
  local source_dir="${STAGING}/${prefix}"

  if [[ ! -d "${source_dir}" ]]; then
    echo "==> skip missing staging prefix: ${prefix}/"
    return
  fi

  echo "==> sync CDN prefix: ${prefix}/"
  aws s3 sync "${source_dir}" "${DEST%/}/${prefix}/" \
    --delete \
    --endpoint-url "${ENDPOINT}" \
    --region "${REGION}" \
    --cache-control "public,max-age=31536000"
}

for prefix in css js; do
  sync_prefix "${prefix}"
done

echo ""
echo "upload-assets: OK → ${DEST}/ (css/ and js/ only)"
echo "CDN base: ${CDN_BASE}"
