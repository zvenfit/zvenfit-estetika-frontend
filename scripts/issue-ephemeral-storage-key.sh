#!/usr/bin/env bash
set -euo pipefail

for name in YC_IAM_TOKEN YC_STORAGE_SERVICE_ACCOUNT_ID OBJECT_STORAGE_BUCKET GITHUB_ENV; do
  if [[ -z "${!name:-}" ]]; then
    echo "issue-ephemeral-storage-key: ${name} is required" >&2
    exit 1
  fi
done

if [[ ! "${OBJECT_STORAGE_BUCKET}" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]]; then
  echo 'issue-ephemeral-storage-key: OBJECT_STORAGE_BUCKET is invalid' >&2
  exit 1
fi

SESSION_POLICY="$(mktemp /tmp/zvenfit-estetika-storage-session-policy.XXXXXX.json)"
REQUEST_BODY="$(mktemp /tmp/zvenfit-estetika-ephemeral-key-request.XXXXXX.json)"
RESPONSE_BODY="$(mktemp /tmp/zvenfit-estetika-ephemeral-key-response.XXXXXX.json)"
AUTH_HEADER="$(mktemp /tmp/zvenfit-estetika-ephemeral-key-auth.XXXXXX.txt)"
trap 'rm -f -- "${SESSION_POLICY}" "${REQUEST_BODY}" "${RESPONSE_BODY}" "${AUTH_HEADER}"' EXIT
SESSION_NAME="gha-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"

node -e '
const fs = require("node:fs");
const bucket = process.argv[2];
const policy = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: "*",
      Action: ["s3:GetBucketAcl", "s3:GetBucketPolicy", "s3:ListBucket"],
      Resource: [`arn:aws:s3:::${bucket}`],
    },
    {
      Effect: "Allow",
      Principal: "*",
      Action: ["s3:DeleteObject", "s3:GetObjectAcl", "s3:PutObject"],
      Resource: [`arn:aws:s3:::${bucket}/*`],
    },
  ],
};
fs.writeFileSync(process.argv[1], JSON.stringify(policy), { mode: 0o600 });
' "${SESSION_POLICY}" "${OBJECT_STORAGE_BUCKET}"

node -e '
const fs = require("node:fs");
const policy = fs.readFileSync(process.argv[2], "utf8");
const request = {
  subjectId: process.argv[3],
  sessionName: process.argv[4],
  policy,
  duration: "3600s",
};
fs.writeFileSync(process.argv[1], JSON.stringify(request), { mode: 0o600 });
' "${REQUEST_BODY}" "${SESSION_POLICY}" "${YC_STORAGE_SERVICE_ACCOUNT_ID}" "${SESSION_NAME}"
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

if [[ ! "${HTTP_STATUS}" =~ ^2[0-9][0-9]$ ]]; then
  echo "issue-ephemeral-storage-key: IAM API returned HTTP ${HTTP_STATUS}" >&2
  exit 1
fi

read -r ACCESS_KEY SECRET_KEY SESSION_TOKEN < <(node -e '
const fs = require("node:fs");
const key = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
for (const field of ["accessKeyId", "secret", "sessionToken"]) {
  if (typeof key[field] !== "string" || !key[field]) {
    console.error(`issue-ephemeral-storage-key: IAM response is missing ${field}`);
    process.exit(1);
  }
}
process.stdout.write(`${[key.accessKeyId, key.secret, key.sessionToken].join(" ")}\n`);
' "${RESPONSE_BODY}")

echo "::add-mask::${ACCESS_KEY}"
echo "::add-mask::${SECRET_KEY}"
echo "::add-mask::${SESSION_TOKEN}"
{
  printf 'AWS_ACCESS_KEY_ID=%s\n' "${ACCESS_KEY}"
  printf 'AWS_SECRET_ACCESS_KEY=%s\n' "${SECRET_KEY}"
  printf 'AWS_SESSION_TOKEN=%s\n' "${SESSION_TOKEN}"
  printf 'AWS_REGION=ru-central1\n'
  printf 'AWS_ENDPOINT_URL=https://storage.yandexcloud.net\n'
  printf 'AWS_ENDPOINT_URL_S3=https://storage.yandexcloud.net\n'
} >> "${GITHUB_ENV}"

unset HTTP_STATUS ACCESS_KEY SECRET_KEY SESSION_TOKEN
echo "issue-ephemeral-storage-key: issued a one-hour session for ${OBJECT_STORAGE_BUCKET}"
