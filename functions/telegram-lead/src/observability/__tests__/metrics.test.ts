import { ExportResultCode } from '@opentelemetry/core';
import {
  AggregationTemporality,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import assert from 'node:assert/strict';
import test from 'node:test';

import { createInvocationMetrics } from '../metrics';
import { createOtelTransport } from '../otel-transport';

import type { JsonObject, LoggerLike } from '../../types';
import type { MetricAttributes } from '@opentelemetry/api';

class TestLogger implements LoggerLike {
  public readonly errors: JsonObject[] = [];
  public readonly warnings: JsonObject[] = [];

  public error(fields: JsonObject): void {
    this.errors.push(fields);
  }

  public warn(fields: JsonObject): void {
    this.warnings.push(fields);
  }
}

function enabledEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MONIUM_METRICS_ENABLED: 'true',
    MONIUM_API_KEY: 'monium-api-key',
    MONIUM_PROJECT: 'folder__test',
    ...overrides,
  };
}

test('stays inert when metrics are disabled and validates required credentials', async () => {
  const logger = new TestLogger();
  let factoryCalls = 0;
  const disabled = createInvocationMetrics(undefined, logger, {
    env: {},
    transportFactory: () => {
      factoryCalls += 1;
      throw new Error('must not initialize');
    },
  });

  disabled.recordGauge('test_gauge', 1);
  await disabled.flush();
  assert.equal(factoryCalls, 0);

  createInvocationMetrics(undefined, logger, { env: { MONIUM_METRICS_ENABLED: '1' } });
  createInvocationMetrics(undefined, logger, { env: enabledEnv({ MONIUM_API_KEY: '' }) });
  assert.deepEqual(logger.warnings, [
    { event: 'monium_metrics_misconfigured', reason: 'missing_project' },
    { event: 'monium_metrics_misconfigured', reason: 'missing_api_key' },
  ]);
});

test('records gauges with canonical taxonomy and flushes once', async () => {
  const logger = new TestLogger();
  const calls: Array<{ name: string; value: number; attributes?: MetricAttributes }> = [];
  const options: unknown[] = [];
  let flushCalls = 0;
  const metrics = createInvocationMetrics(undefined, logger, {
    env: enabledEnv({
      MONIUM_CLUSTER: 'production',
      MONIUM_METRICS_TIMEOUT_MS: '750',
    }),
    transportFactory: transportOptions => {
      options.push(transportOptions);

      return {
        recordGauge: (name, value, attributes) => calls.push({ name, value, attributes }),
        async flush() {
          flushCalls += 1;
        },
      };
    },
  });

  assert.deepEqual(options, []);
  metrics.recordGauge('queue_depth', 3, { resource_id: 'must-not-override' });
  await metrics.flush();
  await metrics.flush();

  assert.deepEqual(calls, [
    {
      name: 'queue_depth',
      value: 3,
      attributes: {
        application: 'zvenfit-estetika-frontend',
        environment: 'production',
        component: 'zvenfit-estetika-telegram-lead',
        resource_id: 'zvenfit-estetika-telegram-lead',
      },
    },
  ]);
  assert.equal(flushCalls, 1);
  assert.deepEqual(options, [
    {
      endpoint: 'https://ingest.monium.yandex.cloud/otlp/v1/metrics',
      headers: {
        Authorization: 'Api-Key monium-api-key',
        'x-monium-project': 'folder__test',
        'x-monium-cluster': 'production',
        'x-monium-service': 'zvenfit-estetika-frontend',
      },
      timeoutMs: 750,
    },
  ]);
});

test('does not propagate initialization or export failures or expose credentials', async () => {
  const initializationLogger = new TestLogger();
  const initializationMetrics = createInvocationMetrics(undefined, initializationLogger, {
    env: enabledEnv(),
    transportFactory: () => {
      throw Object.assign(new Error('unavailable'), { code: 'collector_unavailable' });
    },
  });
  assert.doesNotThrow(() => initializationMetrics.recordGauge('queue_health', 0));
  assert.deepEqual(initializationLogger.errors, [
    { event: 'monium_metrics_init_error', error_code: 'collector_unavailable' },
  ]);

  const exportLogger = new TestLogger();
  const exportMetrics = createInvocationMetrics(undefined, exportLogger, {
    env: enabledEnv(),
    transportFactory: () => ({
      recordGauge() {},
      async flush() {
        throw Object.assign(new Error('timeout'), { code: 'export_timeout' });
      },
    }),
  });
  exportMetrics.recordGauge('queue_health', 0);
  await assert.doesNotReject(exportMetrics.flush());
  assert.deepEqual(exportLogger.errors, [
    { event: 'monium_metrics_export_error', error_code: 'export_timeout' },
  ]);
  assert.equal(JSON.stringify(exportLogger.errors).includes('monium-api-key'), false);
});

test('bounds exporter timeout', () => {
  const timeouts: number[] = [];
  const defaultMetrics = createInvocationMetrics(undefined, new TestLogger(), {
    env: enabledEnv(),
    transportFactory: options => {
      timeouts.push(options.timeoutMs);

      return { recordGauge() {}, async flush() {} };
    },
  });
  defaultMetrics.recordGauge('test_gauge', 1);

  for (const configured of ['10', '9000']) {
    const metrics = createInvocationMetrics(undefined, new TestLogger(), {
      env: enabledEnv({ MONIUM_METRICS_TIMEOUT_MS: configured }),
      transportFactory: options => {
        timeouts.push(options.timeoutMs);

        return { recordGauge() {}, async flush() {} };
      },
    });
    metrics.recordGauge('test_gauge', 1);
  }
  assert.deepEqual(timeouts, [3000, 100, 5000]);
});

test('exports cumulative gauges and surfaces collector rejection', async () => {
  let exportedMetrics: ResourceMetrics | undefined;
  const exporter: PushMetricExporter = {
    export(metrics, callback) {
      exportedMetrics = metrics;
      callback({ code: ExportResultCode.SUCCESS });
    },
    async forceFlush() {},
    async shutdown() {},
  };
  const transport = createOtelTransport(
    { endpoint: 'https://example.test', headers: {}, timeoutMs: 100 },
    () => exporter,
  );
  transport.recordGauge('zvenfit_test_health', 2, { outcome: 'stored' });
  await transport.flush();

  const metric = exportedMetrics?.scopeMetrics
    .flatMap(scope => scope.metrics)
    .find(item => item.descriptor.name === 'zvenfit_test_health');
  assert.ok(metric);
  assert.equal(metric.aggregationTemporality, AggregationTemporality.CUMULATIVE);
  assert.equal(metric.dataPoints[0]?.value, 2);

  const rejected: PushMetricExporter = {
    export(_metrics, callback) {
      callback({
        code: ExportResultCode.FAILED,
        error: Object.assign(new Error('rejected'), { code: 'collector_rejected' }),
      });
    },
    async forceFlush() {},
    async shutdown() {},
  };
  const rejectedTransport = createOtelTransport(
    { endpoint: 'https://example.test', headers: {}, timeoutMs: 100 },
    () => rejected,
  );
  rejectedTransport.recordGauge('zvenfit_test_health', 1);
  await assert.rejects(rejectedTransport.flush(), { code: 'collector_rejected' });
});

test('bounds exporter cleanup stages independently', async () => {
  for (const [stuckMethod, errorCode] of [
    ['forceFlush', 'metrics_force_flush_timeout'],
    ['shutdown', 'metrics_shutdown_timeout'],
  ] as const) {
    const never = () => new Promise<void>(() => {});
    const exporter: PushMetricExporter = {
      export(_metrics, callback) {
        callback({ code: ExportResultCode.SUCCESS });
      },
      forceFlush: stuckMethod === 'forceFlush' ? never : async () => {},
      shutdown: stuckMethod === 'shutdown' ? never : async () => {},
    };
    const transport = createOtelTransport(
      { endpoint: 'https://example.test', headers: {}, timeoutMs: 30 },
      () => exporter,
    );
    transport.recordGauge('zvenfit_test_health', 1);

    const startedAt = Date.now();
    await assert.rejects(transport.flush(), { code: errorCode });
    assert.ok(Date.now() - startedAt < 1_000, `${stuckMethod} exceeded the flush deadline`);
  }
});

test('does not charge sequential lifecycle stages against one shared deadline', async () => {
  const delay = () => new Promise<void>(resolve => setTimeout(resolve, 20));
  const exporter: PushMetricExporter = {
    export(_metrics, callback) {
      setTimeout(() => callback({ code: ExportResultCode.SUCCESS }), 20);
    },
    forceFlush: delay,
    shutdown: delay,
  };
  const transport = createOtelTransport(
    { endpoint: 'https://example.test', headers: {}, timeoutMs: 30 },
    () => exporter,
  );
  transport.recordGauge('zvenfit_test_health', 1);

  await assert.doesNotReject(transport.flush());
});

test('exports zero-valued queue gauges as real samples', async () => {
  let exportedMetrics: ResourceMetrics | undefined;
  const exporter: PushMetricExporter = {
    export(metrics, callback) {
      exportedMetrics = metrics;
      callback({ code: ExportResultCode.SUCCESS });
    },
    async forceFlush() {},
    async shutdown() {},
  };
  const transport = createOtelTransport(
    { endpoint: 'https://example.test', headers: {}, timeoutMs: 100 },
    () => exporter,
  );

  transport.recordGauge('zvenfit_estetika_telegram_pending_submissions', 0);
  transport.recordGauge('zvenfit_estetika_telegram_pending_notifications', 0);
  transport.recordGauge('zvenfit_estetika_telegram_oldest_pending_age_seconds', 0);
  transport.recordGauge('zvenfit_estetika_retry_worker_heartbeat', 1);
  await transport.flush();

  const metrics = exportedMetrics?.scopeMetrics.flatMap(scope => scope.metrics) ?? [];
  const gauges = new Map(metrics.map(metric => [metric.descriptor.name, metric]));
  for (const [name, expectedValue] of [
    ['zvenfit_estetika_telegram_pending_submissions', 0],
    ['zvenfit_estetika_telegram_pending_notifications', 0],
    ['zvenfit_estetika_telegram_oldest_pending_age_seconds', 0],
    ['zvenfit_estetika_retry_worker_heartbeat', 1],
  ] as const) {
    const gauge = gauges.get(name);
    assert.ok(gauge, `${name} was not exported`);
    assert.equal(gauge.aggregationTemporality, AggregationTemporality.CUMULATIVE);
    assert.equal(gauge.dataPoints[0]?.value, expectedValue);
  }
});
