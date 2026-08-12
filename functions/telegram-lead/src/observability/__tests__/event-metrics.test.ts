import assert from 'node:assert/strict';
import test from 'node:test';

import { withEventMetrics } from '../event-metrics';

import type { ApplicationMetrics, JsonObject, LoggerLike } from '../../types';

function recorder(): {
  calls: Array<{ name: string; value: number; attributes?: Record<string, string | number | boolean> }>;
  metrics: ApplicationMetrics;
} {
  const calls: Array<{
    name: string;
    value: number;
    attributes?: Record<string, string | number | boolean>;
  }> = [];

  return {
    calls,
    metrics: {
      addCounter(name, value = 1, attributes) {
        calls.push({ name, value, attributes });
      },
      recordGauge() {},
      async flush() {},
    },
  };
}

test('maps delivery, storage and YDB events to direct Monium counters', () => {
  const { calls, metrics } = recorder();
  const forwarded: JsonObject[] = [];
  const logger: LoggerLike = {
    error(fields) {
      forwarded.push(fields);
    },
    info(fields) {
      forwarded.push(fields);
    },
    warn(fields) {
      forwarded.push(fields);
    },
  };
  const observed = withEventMetrics(logger, metrics);

  observed.error({ event: 'submission_storage_error' });
  observed.error({ event: 'telegram_delivery_failed_permanently' });
  observed.warn?.({ event: 'ydb_retry', retry_attempts: 3 });
  observed.warn?.({ event: 'submission_blocked', reason: 'rate_limit' });
  observed.info?.({ event: 'submission_persisted', form_type: 'newsletter' });

  assert.deepEqual(calls, [
    { name: 'zvenfit_estetika_storage_errors', value: 1, attributes: undefined },
    { name: 'zvenfit_estetika_telegram_failed_1m', value: 1, attributes: undefined },
    { name: 'zvenfit_estetika_ydb_retries_5m', value: 3, attributes: undefined },
    { name: 'zvenfit_estetika_rate_limited_5m', value: 1, attributes: undefined },
    {
      name: 'zvenfit_estetika_submissions_5m',
      value: 1,
      attributes: { form_type: 'newsletter' },
    },
  ]);
  assert.equal(forwarded.length, 5);
});

test('does not emit a metric for unrelated log events', () => {
  const { calls, metrics } = recorder();
  const observed = withEventMetrics({ error() {} }, metrics);

  observed.error({ event: 'request_completed' });

  assert.deepEqual(calls, []);
});
