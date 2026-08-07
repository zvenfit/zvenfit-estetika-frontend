#!/usr/bin/env bash
# Create site bucket (CI deploy) + assets bucket (manual upload).
set -euo pipefail

SITE_BUCKET="${YC_S3_BUCKET:-zvenfit-estetika-frontend}"
ASSETS_BUCKET="${YC_ASSETS_BUCKET:-zvenfit-estetika}"
FOLDER_ID="${YC_FOLDER_ID:-}"
SA_NAME="${YC_SA_NAME:-github-ci-zvenfit-estetika}"

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
      --website-settings '{"index":"index.html","error":"404.html"}'
  fi

  # CORS optional — yc CLI flag format varies; not required for CDN origin
  echo "    (CORS: configure in console if needed for direct bucket access)"
}

echo ""
echo "--- Site bucket (CI: HTML + app JS) ---"
create_bucket "${SITE_BUCKET}" "yes"

echo ""
echo "--- Assets bucket (images/fonts direct; uploader manages vendor CSS/webflow.js) ---"
create_bucket "${ASSETS_BUCKET}" "no"

if yc iam service-account get --name "${SA_NAME}" >/dev/null 2>&1; then
  SA_ID="$(yc iam service-account get --name "${SA_NAME}" --format json | jq -r '.id')"
  echo ""
  echo "==> Grant storage.editor to ${SA_NAME}"
  yc resource-manager folder add-access-binding \
    --id "${FOLDER_ID}" \
    --role storage.editor \
    --service-account-id "${SA_ID}" \
    2>/dev/null || echo "    (binding may already exist)"
fi

echo ""
echo "setup-storage: OK"
echo ""
echo "Site (CDN origin):  s3://${SITE_BUCKET}/"
echo "Assets (manual):    s3://${ASSETS_BUCKET}/"
echo "Assets CDN base:    https://storage.yandexcloud.net/${ASSETS_BUCKET}"
echo ""
echo "Workflow:"
echo "  1. npm run upload:assets   # vendor CSS/webflow.js only"
echo "  2. git push                # CI deploys full dist/ → site bucket"
