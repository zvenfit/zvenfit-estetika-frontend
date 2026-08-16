#!/usr/bin/env bash
set -euo pipefail

YC_CLI_VERSION='1.26.0'
YC_CLI_SHA256='b6bc853d132c40792675363d301241bf3e00d46daba49c8824b876816028eab3'
INSTALL_ROOT="${RUNNER_TEMP:-/tmp}/zvenfit-estetika-yc-cli-${YC_CLI_VERSION}"
YC_BINARY="${INSTALL_ROOT}/yc"

mkdir -p "${INSTALL_ROOT}"
curl --fail --silent --show-error --location --retry 5 \
  "https://storage.yandexcloud.net/yandexcloud-yc/release/${YC_CLI_VERSION}/linux/amd64/yc" \
  --output "${YC_BINARY}"

printf '%s  %s\n' "${YC_CLI_SHA256}" "${YC_BINARY}" | sha256sum --check --status
chmod 0755 "${YC_BINARY}"
"${YC_BINARY}" version

if [[ -n "${GITHUB_PATH:-}" ]]; then
  printf '%s\n' "${INSTALL_ROOT}" >> "${GITHUB_PATH}"
else
  printf '%s\n' "${INSTALL_ROOT}"
fi
