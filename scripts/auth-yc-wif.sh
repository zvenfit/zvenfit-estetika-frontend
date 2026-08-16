#!/usr/bin/env bash
set -euo pipefail

for name in YC_FOLDER_ID YC_DEPLOY_SERVICE_ACCOUNT_ID YC_WIF_AUDIENCE ACTIONS_ID_TOKEN_REQUEST_URL ACTIONS_ID_TOKEN_REQUEST_TOKEN; do
  if [[ -z "${!name:-}" ]]; then
    echo "auth-yc-wif: ${name} is required" >&2
    exit 1
  fi
done

if [[ -z "${GITHUB_ENV:-}" ]]; then
  echo 'auth-yc-wif: GITHUB_ENV is required' >&2
  exit 1
fi

ENCODED_AUDIENCE="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "${YC_WIF_AUDIENCE}")"
echo 'auth-yc-wif: requesting a GitHub OIDC token'
OIDC_RESPONSE="$(curl --fail --silent --show-error --location --retry 5 \
  --header "Authorization: Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
  "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${ENCODED_AUDIENCE}")"
OIDC_TOKEN="$(node -e '
const response = JSON.parse(process.argv[1]);
if (typeof response.value !== "string" || !response.value) process.exit(1);
process.stdout.write(response.value);
' "${OIDC_RESPONSE}")"

OIDC_IDENTITY="$(node -e '
const payload = process.argv[1].split(".")[1];
const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
const value = key => typeof claims[key] === "string" ? claims[key] : JSON.stringify(claims[key]);
process.stdout.write(`iss=${value("iss")} aud=${value("aud")} sub=${value("sub")}`);
' "${OIDC_TOKEN}")"

echo 'auth-yc-wif: exchanging the GitHub OIDC token for a Yandex Cloud IAM token'
if ! IAM_RESPONSE="$(curl --fail-with-body --silent --show-error --location --retry 5 \
  --request POST \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:token-exchange' \
  --data-urlencode 'requested_token_type=urn:ietf:params:oauth:token-type:access_token' \
  --data-urlencode "audience=${YC_DEPLOY_SERVICE_ACCOUNT_ID}" \
  --data-urlencode "subject_token=${OIDC_TOKEN}" \
  --data-urlencode 'subject_token_type=urn:ietf:params:oauth:token-type:id_token' \
  'https://auth.yandex.cloud/oauth/token')"; then
  echo "auth-yc-wif: token exchange rejected for ${OIDC_IDENTITY}" >&2
  IAM_ERROR="$(node -e '
try {
  const response = JSON.parse(process.argv[1]);
  const safe = {};
  for (const key of ["error", "error_description", "code", "message"]) {
    if (typeof response[key] === "string" || typeof response[key] === "number") safe[key] = response[key];
  }
  process.stdout.write(JSON.stringify(safe).slice(0, 512));
} catch {
  process.stdout.write("{\"error\":\"unparseable_error_response\"}");
}
' "${IAM_RESPONSE}")"
  echo "auth-yc-wif: Yandex Cloud response ${IAM_ERROR}" >&2
  exit 1
fi
IAM_TOKEN="$(node -e '
const response = JSON.parse(process.argv[1]);
if (typeof response.access_token !== "string" || !response.access_token) process.exit(1);
process.stdout.write(response.access_token);
' "${IAM_RESPONSE}")"

echo "::add-mask::${IAM_TOKEN}"
export YC_IAM_TOKEN="${IAM_TOKEN}"
yc config set folder-id "${YC_FOLDER_ID}" >/dev/null
printf 'YC_IAM_TOKEN=%s\n' "${IAM_TOKEN}" >> "${GITHUB_ENV}"

unset OIDC_RESPONSE OIDC_TOKEN OIDC_IDENTITY IAM_RESPONSE IAM_ERROR IAM_TOKEN
echo 'auth-yc-wif: authenticated with a short-lived IAM token'
