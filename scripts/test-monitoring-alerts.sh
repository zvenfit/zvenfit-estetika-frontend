#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "--confirm" ]]; then
  echo "Usage: bash scripts/test-monitoring-alerts.sh --confirm" >&2
  exit 1
fi

if ! command -v yc >/dev/null 2>&1; then
  echo "test-monitoring-alerts: install and configure Yandex Cloud CLI (yc)" >&2
  exit 1
fi

LOG_GROUP_NAME="${LOG_GROUP_NAME:-default}"
APPLICATION_NAME="zvenfit-estetika-frontend"
MONITORING_ENVIRONMENT="production"

write_event() {
  local event="$1"
  local extra="${2:-}"
  yc logging write \
    --group-name="${LOG_GROUP_NAME}" \
    --level=ERROR \
    --message="${event}" \
    --json-payload="{\"application\":\"${APPLICATION_NAME}\",\"environment\":\"${MONITORING_ENVIRONMENT}\",\"event\":\"${event}\",\"synthetic\":true,\"source\":\"monitoring-smoke-test\"${extra}}"
}

write_event submission_storage_error
write_event telegram_delivery_failed_permanently
write_event ydb_retry
write_event ydb_slow_operation
write_event submission_blocked ',"reason":"rate_limit"'
write_event submission_persisted ',"form_type":"lead"'

echo "test-monitoring-alerts: synthetic events written to ${LOG_GROUP_NAME}"
echo "Verify Telegram/email notifications and wait for alerts to return to OK."
