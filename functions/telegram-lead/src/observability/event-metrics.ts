import type { ApplicationMetrics, JsonObject, LoggerLike } from '../types';

const EVENT_COUNTERS: Record<string, string> = {
  submission_storage_error: 'zvenfit_estetika_storage_errors',
  submission_rate_limit_error: 'zvenfit_estetika_rate_limit_errors_5m',
  telegram_delivery_failed_permanently: 'zvenfit_estetika_telegram_failed_1m',
  telegram_delivery_retry_error: 'zvenfit_estetika_storage_errors',
  ydb_retry: 'zvenfit_estetika_ydb_retries_5m',
  ydb_slow_operation: 'zvenfit_estetika_ydb_slow_5m',
};

function counterValue(event: string, fields: JsonObject): number {
  if (event !== 'ydb_retry') return 1;
  const attempts = fields.retry_attempts;

  return typeof attempts === 'number' && Number.isFinite(attempts) && attempts > 0 ? attempts : 1;
}

function recordEventMetric(metrics: ApplicationMetrics, fields: JsonObject): void {
  const event = typeof fields.event === 'string' ? fields.event : '';
  if (event === 'submission_blocked' && fields.reason === 'rate_limit') {
    metrics.addCounter('zvenfit_estetika_rate_limited_5m');

    return;
  }
  if (event === 'submission_persisted') {
    metrics.addCounter('zvenfit_estetika_submissions_5m', 1, {
      form_type: typeof fields.form_type === 'string' ? fields.form_type : 'unknown',
    });

    return;
  }

  const counter = EVENT_COUNTERS[event];
  if (counter) metrics.addCounter(counter, counterValue(event, fields));
}

export function withEventMetrics(logger: LoggerLike, metrics: ApplicationMetrics): LoggerLike {
  return {
    error(fields, message) {
      recordEventMetric(metrics, fields);
      logger.error(fields, message);
    },
    info: logger.info
      ? (fields, message) => {
          recordEventMetric(metrics, fields);
          logger.info?.(fields, message);
        }
      : undefined,
    warn: logger.warn
      ? (fields, message) => {
          recordEventMetric(metrics, fields);
          logger.warn?.(fields, message);
        }
      : undefined,
  };
}

export const _private = { counterValue, recordEventMetric };
