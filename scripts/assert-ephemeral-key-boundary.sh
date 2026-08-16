#!/usr/bin/env bash
set -euo pipefail

for name in YC_IAM_TOKEN YC_STORAGE_SERVICE_ACCOUNT_ID YC_FORBIDDEN_EPHEMERAL_SUBJECT_ID; do
  if [[ -z "${!name:-}" ]]; then
    echo "assert-ephemeral-key-boundary: ${name} is required" >&2
    exit 1
  fi
done

if [[ "${YC_STORAGE_SERVICE_ACCOUNT_ID}" == "${YC_FORBIDDEN_EPHEMERAL_SUBJECT_ID}" ]]; then
  echo 'assert-ephemeral-key-boundary: allowed and forbidden subjects must differ' >&2
  exit 1
fi

REQUEST_BODY="$(mktemp /tmp/zvenfit-estetika-boundary-request.XXXXXX.json)"
RESPONSE_BODY="$(mktemp /tmp/zvenfit-estetika-boundary-response.XXXXXX.json)"
AUTH_HEADER="$(mktemp /tmp/zvenfit-estetika-boundary-auth.XXXXXX.txt)"
trap 'rm -f -- "${REQUEST_BODY}" "${RESPONSE_BODY}" "${AUTH_HEADER}"' EXIT

node -e '
const fs = require("node:fs");
const request = {
  subjectId: process.argv[2],
  sessionName: "estetika-deny-boundary-test",
  policy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [{ Effect: "Deny", Principal: "*", Action: "s3:*", Resource: "*" }],
  }),
  duration: "900s",
};
fs.writeFileSync(process.argv[1], JSON.stringify(request), { mode: 0o600 });
' "${REQUEST_BODY}" "${YC_FORBIDDEN_EPHEMERAL_SUBJECT_ID}"
printf 'Authorization: Bearer %s\n' "${YC_IAM_TOKEN}" > "${AUTH_HEADER}"

HTTP_STATUS="$(curl --silent --show-error \
  --connect-timeout 10 \
  --max-time 30 \
  --retry 3 \
  --retry-delay 1 \
  --output "${RESPONSE_BODY}" \
  --write-out '%{http_code}' \
  --request POST \
  --header 'Content-Type: application/json' \
  --header "@${AUTH_HEADER}" \
  --data-binary "@${REQUEST_BODY}" \
  'https://iam.api.cloud.yandex.net/iam/aws-compatibility/v1/ephemeralAccessKeys')"

if [[ "${HTTP_STATUS}" == "403" ]]; then
  echo 'assert-ephemeral-key-boundary: forbidden service account is not issuable'
  exit 0
fi

if [[ "${HTTP_STATUS}" =~ ^2[0-9][0-9]$ ]]; then
  echo 'assert-ephemeral-key-boundary: FAILED; WIF identity can issue a key for the forbidden service account' >&2
else
  echo "assert-ephemeral-key-boundary: expected HTTP 403, received ${HTTP_STATUS}" >&2
fi
exit 1
