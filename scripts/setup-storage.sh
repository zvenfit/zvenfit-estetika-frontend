#!/usr/bin/env bash
# Create site bucket (CI deploy) + assets bucket (direct object publishing).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE_BUCKET="${YC_S3_BUCKET:-zvenfit-estetika-frontend}"
ASSETS_BUCKET="${YC_ASSETS_BUCKET:-zvenfit-estetika}"
FOLDER_ID="${YC_FOLDER_ID:-}"
STORAGE_SA_NAME="${YC_STORAGE_SA_NAME:-zvenfit-estetika-site-storage-sa}"
WEBSITE_SETTINGS_FILE="${SCRIPT_DIR}/website-settings.json"

if [[ -z "${FOLDER_ID}" ]]; then
  FOLDER_ID="$(yc config get folder-id 2>/dev/null || true)"
fi

if [[ -z "${FOLDER_ID}" ]]; then
  echo "setup-storage: set YC_FOLDER_ID or run yc init" >&2
  exit 1
fi

if ! command -v yc >/dev/null 2>&1; then
  echo "setup-storage: install Yandex Cloud CLI (yc)" >&2
  exit 1
fi

yc config set folder-id "${FOLDER_ID}" >/dev/null

create_bucket() {
  local name="$1"
  local website="$2"

  echo "==> Bucket: ${name}"
  if yc storage bucket get --name "${name}" >/dev/null 2>&1; then
    echo "    already exists"
  else
    yc storage bucket create --name "${name}"
    echo "    created"
  fi

  yc storage bucket update --name "${name}" --public-read

  if [[ "${website}" == "yes" ]]; then
    yc storage bucket update \
      --name "${name}" \
      --website-settings-from-file "${WEBSITE_SETTINGS_FILE}"
  fi

}

echo ""
echo "--- Site bucket (CI: HTML + app JS) ---"
create_bucket "${SITE_BUCKET}" "yes"

echo ""
echo "--- Assets bucket (objects are published directly; no staging sync) ---"
create_bucket "${ASSETS_BUCKET}" "no"
yc storage bucket update \
  --name "${ASSETS_BUCKET}" \
  --cors allowed-methods='[method-get,method-head]',allowed-origins='[*]',allowed-headers='[*]',max-age-seconds=86400
echo "    CORS enabled for public fonts and assets"

if ! yc iam service-account get --name "${STORAGE_SA_NAME}" >/dev/null 2>&1; then
  echo "setup-storage: required storage identity ${STORAGE_SA_NAME} does not exist" >&2
  exit 1
fi

STORAGE_SA_ID="$(yc iam service-account get --name "${STORAGE_SA_NAME}" --format json | jq -r '.id')"
echo ""
echo "==> Grant bucket-scoped read/write ACL to storage identity ${STORAGE_SA_NAME}"
yc storage bucket update \
  --name "${SITE_BUCKET}" \
  --public-read \
  --grants grant-type=grant-type-account,grantee-id="${STORAGE_SA_ID}",permission=permission-read \
  --grants grant-type=grant-type-account,grantee-id="${STORAGE_SA_ID}",permission=permission-write

echo ""
echo "setup-storage: OK"
echo ""
echo "Site (CDN origin):  s3://${SITE_BUCKET}/"
echo "Assets (manual):    s3://${ASSETS_BUCKET}/"
echo "Assets CDN base:    https://storage.yandexcloud.net/${ASSETS_BUCKET}"
echo ""
echo "Workflow:"
echo "  1. Publish changed CDN objects directly with Cache-Control: public, max-age=31536000, immutable"
echo "     yc storage s3api put-object --bucket ${ASSETS_BUCKET} --key <key> --body <file> --cache-control 'public, max-age=31536000, immutable'"
echo "  2. Verify the public URL, Content-Type, Cache-Control and Access-Control-Allow-Origin"
echo "  3. git push   # CI deploys full dist/ → site bucket"
