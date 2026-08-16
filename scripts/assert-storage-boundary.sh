#!/usr/bin/env bash
set -euo pipefail

for name in OBJECT_STORAGE_BUCKET FORBIDDEN_STORAGE_BUCKETS AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN; do
  if [[ -z "${!name:-}" ]]; then
    echo "assert-storage-boundary: ${name} is required" >&2
    exit 1
  fi
done

if ! aws s3api list-objects-v2 --bucket "${OBJECT_STORAGE_BUCKET}" --max-items 1 >/dev/null; then
  echo 'assert-storage-boundary: allowed Estetika site bucket is unavailable' >&2
  exit 1
fi

IFS=',' read -r -a FORBIDDEN_BUCKETS <<< "${FORBIDDEN_STORAGE_BUCKETS}"
for bucket in "${FORBIDDEN_BUCKETS[@]}"; do
  if [[ -z "${bucket}" || "${bucket}" == "${OBJECT_STORAGE_BUCKET}" ]]; then
    echo 'assert-storage-boundary: forbidden bucket list is invalid' >&2
    exit 1
  fi

  ERROR_FILE="$(mktemp /tmp/zvenfit-estetika-storage-boundary.XXXXXX.txt)"
  if aws s3api list-objects-v2 --bucket "${bucket}" --max-items 1 >/dev/null 2>"${ERROR_FILE}"; then
    rm -f -- "${ERROR_FILE}"
    echo "assert-storage-boundary: FAILED; session can list forbidden bucket ${bucket}" >&2
    exit 1
  fi
  rm -f -- "${ERROR_FILE}"
done

echo 'assert-storage-boundary: session is limited to the Estetika site bucket'
