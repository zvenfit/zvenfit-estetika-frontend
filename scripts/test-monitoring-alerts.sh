#!/usr/bin/env bash
set -euo pipefail

LOG_GROUP_NAME="${YC_LOG_GROUP_NAME:-default}"
APPLICATION_NAME="zvenfit-estetika-frontend"
SERVICE_NAME="zvenfit-estetika-telegram-lead"
MONITORING_ENVIRONMENT="production"

if [[ "${1:-}" != "--confirm" ]]; then
  echo "Usage: bash scripts/test-monitoring-alerts.sh --confirm" >&2
  echo "This writes synthetic technical records and intentionally triggers production alerts." >&2
  exit 2
fi

if ! command -v yc >/dev/null 2>&1; then
  echo "test-monitoring-alerts: install and configure Yandex Cloud CLI (yc)" >&2
  exit 1
fi

write_event() {
  local event="$1"
  local level="${2:-ERROR}"
  local extra="${3:-}"

  yc logging write \
    --group-name="${LOG_GROUP_NAME}" \
    --level="${level}" \
    --message="${event}" \
    --json-payload="{\"application\":\"${APPLICATION_NAME}\",\"environment\":\"${MONITORING_ENVIRONMENT}\",\"service\":\"${SERVICE_NAME}\",\"event\":\"${event}\",\"synthetic\":true,\"source\":\"monitoring-smoke-test\"${extra}}"
}

write_event submission_storage_error
write_event telegram_delivery_failed_permanently

for _ in 1 2 3 4 5 6; do
  write_event ydb_retry WARN
done

write_event ydb_slow_operation WARN

for _ in 1 2 3; do
  write_event submission_rate_limit_error
done

for _ in 1 2 3 4 5 6; do
  write_event submission_blocked WARN ',"reason":"rate_limit"'
done

for _ in {1..21}; do
  write_event submission_persisted INFO ',"form_type":"lead"'
done

echo "test-monitoring-alerts: synthetic events written to ${LOG_GROUP_NAME}"
echo "Runtime, throttling, trigger, heartbeat and YDB storage alerts require live platform metrics."
echo "Verify Telegram and email delivery, then acknowledge the test alerts in Monium."
