#!/usr/bin/env bash
# Apply static response security headers to the Yandex Cloud CDN resource.
#
# Source of truth: scripts/cdn-security-headers.json (also read by smoke-production).
# Default is a dry run that only reads the resource; pass --apply to change it.
# The CLI flag --static-headers splits values on commas, so Permissions-Policy cannot
# be set through `yc cdn resource update`; this script PATCHes the CDN REST API instead.
# Headers already present on the resource that are not listed in the config are kept.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${CDN_HEADERS_CONFIG:-${SCRIPT_DIR}/cdn-security-headers.json}"
API_BASE="https://cdn.api.cloud.yandex.net/cdn/v1/resources"
APPLY=false

for arg in "$@"; do
  case "${arg}" in
    --apply) APPLY=true ;;
    -h | --help)
      echo "Usage: bash scripts/configure-cdn-headers.sh [--apply]"
      exit 0
      ;;
    *)
      echo "configure-cdn-headers: unknown argument ${arg}" >&2
      exit 2
      ;;
  esac
done

for tool in yc jq curl; do
  command -v "${tool}" >/dev/null 2>&1 || {
    echo "configure-cdn-headers: ${tool} is required" >&2
    exit 1
  }
done

CNAME="$(jq -r '.cname' "${CONFIG_FILE}")"
RESOURCE_ID="${CDN_RESOURCE_ID:-}"
if [[ -z "${RESOURCE_ID}" ]]; then
  RESOURCE_ID="$(yc cdn resource list --format=json | jq -r --arg cname "${CNAME}" '[.[] | select(.cname == $cname)][0].id // empty')"
fi
if [[ -z "${RESOURCE_ID}" ]]; then
  echo "configure-cdn-headers: CDN resource for ${CNAME} not found" >&2
  exit 1
fi

CURRENT="$(yc cdn resource get "${RESOURCE_ID}" --format=json | jq -c '.options.static_headers.value // {}')"
# Keep unrelated headers, always (re)set ours; HSTS is added only when enabled in the config
# and removed otherwise, so flipping hsts.enabled to false is the rollback path.
DESIRED="$(jq -c --argjson current "${CURRENT}" '
  . as $cfg
  | ($current | del(.[$cfg.hsts.header]))
    + $cfg.headers
    + (if $cfg.hsts.enabled then {($cfg.hsts.header): $cfg.hsts.value} else {} end)
' "${CONFIG_FILE}")"

echo "Resource: ${RESOURCE_ID} (${CNAME})"
echo "Current static headers:"
jq . <<<"${CURRENT}"
echo "Desired static headers:"
jq . <<<"${DESIRED}"

if [[ "$(jq -S -c . <<<"${CURRENT}")" == "$(jq -S -c . <<<"${DESIRED}")" ]]; then
  echo "configure-cdn-headers: already up to date"
  exit 0
fi

if [[ "${APPLY}" != "true" ]]; then
  echo "configure-cdn-headers: dry run, nothing changed (use --apply)"
  exit 0
fi

REQUEST_BODY="$(mktemp "${TMPDIR:-/tmp}/zvenfit-estetika-cdn-headers.XXXXXX")"
AUTH_HEADER="$(mktemp "${TMPDIR:-/tmp}/zvenfit-estetika-cdn-auth.XXXXXX")"
trap 'rm -f -- "${REQUEST_BODY}" "${AUTH_HEADER}"' EXIT
chmod 600 "${REQUEST_BODY}" "${AUTH_HEADER}"

jq -n --argjson value "${DESIRED}" '{options: {staticHeaders: {enabled: true, value: $value}}}' >"${REQUEST_BODY}"
printf 'Authorization: Bearer %s\n' "$(yc iam create-token)" >"${AUTH_HEADER}"

curl --silent --show-error --fail-with-body \
  --request PATCH \
  --header 'Content-Type: application/json' \
  --header "@${AUTH_HEADER}" \
  --data "@${REQUEST_BODY}" \
  "${API_BASE}/${RESOURCE_ID}" | jq '{id, done, error}'

echo "configure-cdn-headers: submitted; CDN may need up to 15 minutes to propagate."
echo "Then purge the cache and verify: curl -sI https://${CNAME}/"
