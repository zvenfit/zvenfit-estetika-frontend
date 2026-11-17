#!/usr/bin/env bash
# Apply static response security headers to the Yandex Cloud CDN resource.
#
# Source of truth: scripts/cdn-security-headers.json (also read by smoke-production).
# Default is a dry run that only reads the resource; pass --apply to change it.
#
# Notes:
# - `yc cdn resource update --static-headers` splits values on commas, so Permissions-Policy
#   cannot be set through it; this script PATCHes the CDN REST API instead.
# - The PATCH names its field mask (options.staticHeaders; the REST JSON form is camelCase): without a mask the API resets the
#   fields that are not sent. The full resource is saved first and every other option is compared
#   after the update; the script fails if any of them changed.
# - Header names are matched case-insensitively. Headers on the resource that the config does not
#   manage are kept. Removing a header from the config does not remove it from the CDN.
# - HSTS: hsts.enabled=false removes the header from the CDN, which does NOT revoke the policy in
#   browsers that already stored it. To revoke, keep enabled=true and set value "max-age=0".
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${CDN_HEADERS_CONFIG:-${SCRIPT_DIR}/cdn-security-headers.json}"
API_BASE="https://cdn.api.cloud.yandex.net/cdn/v1/resources"
APPLY=false
FORCE=false

for arg in "$@"; do
  case "${arg}" in
    --apply) APPLY=true ;;
    --force) FORCE=true ;; # re-send identical headers, e.g. to verify the PATCH path
    -h | --help)
      echo "Usage: bash scripts/configure-cdn-headers.sh [--apply [--force]]"
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

# Everything below that holds a token or a resource snapshot lives in 0600 temp files.
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/zvenfit-estetika-cdn-headers.XXXXXX")"
trap 'rm -rf -- "${WORK_DIR}"' EXIT
chmod 700 "${WORK_DIR}"

BEFORE_FILE="${WORK_DIR}/resource-before.json"
yc cdn resource get "${RESOURCE_ID}" --format=json >"${BEFORE_FILE}"

CURRENT="$(jq -c '.options.static_headers.value // {}' "${BEFORE_FILE}")"
CURRENT_ENABLED="$(jq -r '.options.static_headers.enabled // false' "${BEFORE_FILE}")"

# Drop existing keys that collide (case-insensitively) with managed headers, then add ours.
# HSTS is added only when enabled in the config and otherwise removed from the CDN.
DESIRED="$(jq -c --argjson current "${CURRENT}" '
  . as $cfg
  | ([$cfg.headers | keys[] | ascii_downcase] + [$cfg.hsts.header | ascii_downcase]) as $managed
  | ($current | with_entries(select((.key | ascii_downcase) as $k | ($managed | index($k)) == null)))
    + $cfg.headers
    + (if $cfg.hsts.enabled then {($cfg.hsts.header): $cfg.hsts.value} else {} end)
' "${CONFIG_FILE}")"

echo "Resource: ${RESOURCE_ID} (${CNAME})"
echo "Current static headers (enabled=${CURRENT_ENABLED}):"
jq . <<<"${CURRENT}"
echo "Desired static headers:"
jq . <<<"${DESIRED}"

if [[ "${FORCE}" != "true" && "${CURRENT_ENABLED}" == "true" && "$(jq -S -c . <<<"${CURRENT}")" == "$(jq -S -c . <<<"${DESIRED}")" ]]; then
  echo "configure-cdn-headers: already up to date"
  exit 0
fi

if [[ "${APPLY}" != "true" ]]; then
  echo "configure-cdn-headers: dry run, nothing changed (use --apply)"
  exit 0
fi

REQUEST_BODY="${WORK_DIR}/request.json"
AUTH_HEADER="${WORK_DIR}/auth-header.txt"
RESPONSE_BODY="${WORK_DIR}/response.json"
umask 077

# Assign the token first so a failed `yc iam create-token` aborts instead of sending an empty one.
IAM_TOKEN="$(yc iam create-token)"
printf 'Authorization: Bearer %s\n' "${IAM_TOKEN}" >"${AUTH_HEADER}"
unset IAM_TOKEN

jq -n --argjson value "${DESIRED}" '{
  updateMask: "options.staticHeaders",
  options: {staticHeaders: {enabled: true, value: $value}}
}' >"${REQUEST_BODY}"

if ! curl --silent --show-error --fail-with-body \
  --request PATCH \
  --header 'Content-Type: application/json' \
  --header "@${AUTH_HEADER}" \
  --data "@${REQUEST_BODY}" \
  --output "${RESPONSE_BODY}" \
  "${API_BASE}/${RESOURCE_ID}"; then
  echo "configure-cdn-headers: API request failed:" >&2
  cat "${RESPONSE_BODY}" >&2 || true
  exit 1
fi

OPERATION_ID="$(jq -r '.id // empty' "${RESPONSE_BODY}")"
if [[ -z "${OPERATION_ID}" ]]; then
  echo "configure-cdn-headers: no operation id in the API response" >&2
  exit 1
fi

# Wait for the operation and fail on an error instead of reporting a submitted request as success.
for _ in $(seq 1 30); do
  OPERATION="$(yc operation get "${OPERATION_ID}" --format=json)"
  if [[ "$(jq -r '.done // false' <<<"${OPERATION}")" == "true" ]]; then
    break
  fi
  sleep 2
done
if [[ "$(jq -r '.done // false' <<<"${OPERATION}")" != "true" ]]; then
  echo "configure-cdn-headers: operation ${OPERATION_ID} did not finish in time" >&2
  exit 1
fi
if [[ "$(jq -r '.error // empty' <<<"${OPERATION}")" != "" ]]; then
  echo "configure-cdn-headers: operation ${OPERATION_ID} failed:" >&2
  jq '.error' <<<"${OPERATION}" >&2
  exit 1
fi

# Guard against a reset of anything other than static_headers.
AFTER_FILE="${WORK_DIR}/resource-after.json"
yc cdn resource get "${RESOURCE_ID}" --format=json >"${AFTER_FILE}"
OTHERS='del(.options.static_headers) | del(.updated_at) | .options'
if [[ "$(jq -S -c "${OTHERS}" "${BEFORE_FILE}")" != "$(jq -S -c "${OTHERS}" "${AFTER_FILE}")" ]]; then
  echo "configure-cdn-headers: WARNING other CDN options changed; compare these (before / after):" >&2
  jq -S "${OTHERS}" "${BEFORE_FILE}" >&2
  jq -S "${OTHERS}" "${AFTER_FILE}" >&2
  exit 1
fi

echo "configure-cdn-headers: applied (operation ${OPERATION_ID}); other options unchanged."
echo "CDN edge nodes pick the change up gradually (about 20 minutes observed); check with repeated"
echo "requests, e.g. for p in / /form/ /404.html; do curl -sI https://${CNAME}\$p; done"
