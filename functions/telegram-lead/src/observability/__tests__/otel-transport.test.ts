import { ExportResultCode } from '@opentelemetry/core';
import { MetricReader, type PushMetricExporter } from '@opentelemetry/sdk-metrics';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as drainMicrotasks } from 'node:timers/promises';

import { _private } from '../../handler';
import { createInvocationMetrics } from '../metrics';
import { createOtelTransport } from '../otel-transport';

import type { TelegramOutbox } from '../../application/ports';
import type { ClaimedTelegramNotification } from '../../domain/telegram-notification';
import type { HandlerDependencies } from '../../handler';
import type { JsonObject, LoggerLike } from '../../types';

const METRICS_TIMEOUT_MS = 5000;
const FUNCTION_TIMEOUT_MS = 120000;
const NOTIFICATION_ID = '0b6f6a52-2f5c-4c6e-9d0e-6a1f3c2b7e10';
const EMPTY_QUEUE_RESULT = {
  processed: 0,
  sent: 0,
  pending: 0,
  failed: 0,
  skipped: 0,
  queue_pending: 0,
  oldest_pending_age_seconds: 0,
};
const DELIVERED_RESULT = { ...EMPTY_QUEUE_RESULT, processed: 1, sent: 1 };
const TIMER_EVENT = {
  messages: [{ event_metadata: { event_type: 'yandex.cloud.events.serverless.triggers.TimerMessage' } }],
};

type StalledStage = 'none' | 'export' | 'forceFlush' | 'shutdown' | 'export-and-shutdown';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });

  return { promise, resolve, reject };
}

function claimedNotification(): ClaimedTelegramNotification {
  return {
    notificationId: NOTIFICATION_ID,
    kind: 'lead_created',
    aggregateId: NOTIFICATION_ID,
    createdAt: new Date('2026-11-26T09:00:00.000Z'),
    name: 'Test Client',
    phone: '+7 (900) 000-00-00',
    contactMethod: 'Telegram',
    telegramUsername: '',
    utm: {},
    attempts: 1,
  } as ClaimedTelegramNotification;
}

// Use the real handler, metrics wrapper, SDK collection and transport; only
// storage, Telegram and the exporter are synthetic. No YDB, Telegram or Monium requests.
function fixture(stalledStage: StalledStage, { pendingNotification = false } = {}) {
  const blocked = deferred();
  const entered = deferred();
  const logs: JsonObject[] = [];
  const calls: string[] = [];
  const delivered: string[] = [];
  let exportCallback: Parameters<PushMetricExporter['export']>[1] | undefined;
  let exporterBudget: number | undefined;
  const logger: LoggerLike = {
    info: fields => logs.push(fields),
    warn: fields => logs.push(fields),
    error: fields => logs.push(fields),
  };
  const exporter: PushMetricExporter = {
    export(_metrics, callback) {
      calls.push('export');
      exportCallback = callback;
      if (stalledStage === 'export' || stalledStage === 'export-and-shutdown') {
        entered.resolve();

        return;
      }
      callback({ code: ExportResultCode.SUCCESS });
    },
    async forceFlush() {
      calls.push('forceFlush');
      if (stalledStage === 'forceFlush') {
        entered.resolve();
        await blocked.promise;
      }
    },
    async shutdown() {
      calls.push('shutdown');
      if (stalledStage === 'shutdown' || stalledStage === 'export-and-shutdown') {
        entered.resolve();
        await blocked.promise;
      }
    },
  };
  const outbox: TelegramOutbox = {
    async listCandidates() {
      return pendingNotification && delivered.length === 0 ? [NOTIFICATION_ID] : [];
    },
    async claim() {
      return pendingNotification ? claimedNotification() : null;
    },
    async markDelivered(args) {
      delivered.push(args.notificationId);
    },
    async markFailed() {
      assert.fail('a healthy delivery must not be marked failed');
    },
    async getQueueHealth() {
      return { pendingCount: 0, oldestPendingAgeSeconds: 0 };
    },
  };
  const dependencies: Partial<HandlerDependencies> = {
    loggerFactory: () => logger,
    metricsFactory: (context, invocationLogger) =>
      createInvocationMetrics(context, invocationLogger, {
        env: {
          MONIUM_METRICS_ENABLED: 'true',
          MONIUM_PROJECT: 'test-project',
          MONIUM_API_KEY: 'test-only',
          MONIUM_METRICS_TIMEOUT_MS: String(METRICS_TIMEOUT_MS),
        },
        transportFactory: options =>
          createOtelTransport(options, configured => {
            exporterBudget = configured.timeoutMs;

            return exporter;
          }),
      }),
    maxAttempts: () => 12,
    now: () => new Date(),
    outbox,
    rateLimiter: async () => assert.fail('a timer must not check submission rate limits'),
    retryBatchSize: () => 5,
    telegramSender: async notification => {
      if (!pendingNotification) {
        assert.fail('an empty queue must not send notifications');
      }
      assert.equal(notification.notificationId, NOTIFICATION_ID);
    },
    uuid: () => 'test-unused-id',
  };

  return {
    handler: _private.createHandler(dependencies),
    blocked,
    entered,
    logs,
    calls,
    delivered,
    completeExport: (result: Parameters<NonNullable<typeof exportCallback>>[0]) => exportCallback?.(result),
    exporterBudget: () => exporterBudget,
  };
}

test('timer returns its queue result after healthy metric export and shutdown', async () => {
  const f = fixture('none');

  assert.deepEqual(await f.handler(TIMER_EVENT), EMPTY_QUEUE_RESULT);
  assert.deepEqual(f.calls, ['export', 'forceFlush', 'shutdown']);
  assert.deepEqual(
    f.logs.map(log => log.event),
    ['retry_worker_completed', 'monium_metrics_export_completed'],
  );
});

test('the overall deadline releases a missing export callback', { timeout: 2000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture('export');
  const invocation = f.handler(TIMER_EVENT);
  await f.entered.promise;

  t.mock.timers.tick(METRICS_TIMEOUT_MS);
  await drainMicrotasks();

  assert.deepEqual(await invocation, EMPTY_QUEUE_RESULT);
  assert.deepEqual(f.calls, ['export', 'shutdown']);
  const failure = f.logs.find(log => log.event === 'monium_metrics_export_error');
  assert.equal(failure?.error_code, 'metrics_export_timeout');
  assert.equal(failure?.phase, 'export');
  assert.equal(failure?.duration_ms, METRICS_TIMEOUT_MS);
});

const TIMED_OUT_PHASE = { forceFlush: 'force_flush', shutdown: 'shutdown', 'export-and-shutdown': 'export' } as const;
for (const stage of ['forceFlush', 'shutdown', 'export-and-shutdown'] as const) {
  test(`timer completes within the metrics budget when ${stage} stalls`, { timeout: 2000 }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const f = fixture(stage);
    let settled = false;
    const invocation = f.handler(TIMER_EVENT).finally(() => {
      settled = true;
    });
    try {
      await f.entered.promise;
      const completed = f.logs.find(log => log.event === 'retry_worker_completed');
      assert.equal(completed?.outbox_pending, 0);
      assert.equal(completed?.failed, 0);
      assert.equal(settled, false, `${stage} returned before the metrics budget elapsed`);

      t.mock.timers.tick(METRICS_TIMEOUT_MS);
      await drainMicrotasks();
      assert.equal(settled, true, `${stage} retained a completed retry pass past the 5s metrics budget`);
      assert.deepEqual(await invocation, EMPTY_QUEUE_RESULT);
      assert.deepEqual(
        f.logs.filter(log => log.event === 'monium_metrics_export_error'),
        [
          {
            event: 'monium_metrics_export_error',
            outcome: 'failure',
            error_type: 'timeout',
            error_code: 'metrics_export_timeout',
            phase: TIMED_OUT_PHASE[stage],
            duration_ms: METRICS_TIMEOUT_MS,
          },
        ],
      );
      assert.equal(f.calls.filter(call => call === 'shutdown').length, 1);

      // Reject cleanup/forceFlush after the caller has returned. Neither a
      // second result log nor an unhandled rejection may escape.
      f.blocked.reject(new Error('late exporter failure'));
      f.completeExport({ code: ExportResultCode.SUCCESS });
      t.mock.timers.tick(FUNCTION_TIMEOUT_MS - METRICS_TIMEOUT_MS);
      await drainMicrotasks();
      assert.equal(f.logs.length, 2);
      assert.equal(f.calls.filter(call => call === 'shutdown').length, 1);
    } finally {
      f.blocked.resolve();
      await invocation;
    }
  });
}

test('a completed delivery keeps its worker result when the metric export stalls', { timeout: 2000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture('export', { pendingNotification: true });
  const invocation = f.handler(TIMER_EVENT);
  await f.entered.promise;
  assert.deepEqual(f.delivered, [NOTIFICATION_ID]);

  t.mock.timers.tick(METRICS_TIMEOUT_MS);
  await drainMicrotasks();

  assert.deepEqual(await invocation, DELIVERED_RESULT);
  assert.deepEqual(f.delivered, [NOTIFICATION_ID]);
  const failure = f.logs.find(log => log.event === 'monium_metrics_export_error');
  assert.equal(failure?.error_code, 'metrics_export_timeout');
  assert.equal(failure?.phase, 'export');
});

test('a completed delivery keeps its worker result when the exporter rejects', async () => {
  const f = fixture('export', { pendingNotification: true });
  const invocation = f.handler(TIMER_EVENT);
  await f.entered.promise;
  f.completeExport({
    code: ExportResultCode.FAILED,
    error: Object.assign(new Error('rejected'), { code: 'collector_rejected' }),
  });

  assert.deepEqual(await invocation, DELIVERED_RESULT);
  const failure = f.logs.find(log => log.event === 'monium_metrics_export_error');
  assert.equal(failure?.error_code, 'collector_rejected');
  assert.equal(failure?.phase, 'export');
});

test('collection time counts against the same budget as export and shutdown', { timeout: 2000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const collect = MetricReader.prototype.collect;
  t.mock.method(
    MetricReader.prototype,
    'collect',
    async function (this: MetricReader, options: Parameters<MetricReader['collect']>[0]) {
      await new Promise<void>(resolve => setTimeout(resolve, 3000));

      return collect.call(this, options);
    },
  );
  const f = fixture('forceFlush');
  let settled = false;
  const invocation = f.handler(TIMER_EVENT).finally(() => {
    settled = true;
  });
  await drainMicrotasks();
  t.mock.timers.tick(3000);
  await f.entered.promise;
  assert.equal(f.exporterBudget(), 2000);
  t.mock.timers.tick(1999);
  await drainMicrotasks();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await drainMicrotasks();
  assert.equal(settled, true);
  assert.deepEqual(await invocation, EMPTY_QUEUE_RESULT);
  f.blocked.resolve();
  await drainMicrotasks();
});

test('collection that finishes after cancellation cannot start an export', { timeout: 2000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const collect = MetricReader.prototype.collect;
  const gate = deferred();
  const entered = deferred();
  t.mock.method(
    MetricReader.prototype,
    'collect',
    async function (this: MetricReader, options: Parameters<MetricReader['collect']>[0]) {
      const result = await collect.call(this, options);
      entered.resolve();
      await gate.promise;

      return result;
    },
  );
  const f = fixture('none');
  const invocation = f.handler(TIMER_EVENT);
  await entered.promise;
  t.mock.timers.tick(METRICS_TIMEOUT_MS);
  await drainMicrotasks();
  assert.deepEqual(await invocation, EMPTY_QUEUE_RESULT);
  gate.resolve();
  await drainMicrotasks();
  assert.deepEqual(f.calls, []);
  assert.equal(f.logs.length, 2);
  assert.equal(f.logs[1]?.error_code, 'metrics_export_timeout');
  assert.equal(f.logs[1]?.phase, 'collect');
});

// Outcomes that land exactly on the deadline, before its timer has run, must be
// reported as what they are: the budget only gates starting network work.
test('an export that fails at the deadline keeps the exporter error code and phase', { timeout: 2000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture('export');
  const invocation = f.handler(TIMER_EVENT);
  await f.entered.promise;

  t.mock.timers.setTime(Date.now() + METRICS_TIMEOUT_MS);
  f.completeExport({
    code: ExportResultCode.FAILED,
    error: Object.assign(new Error('rejected'), { code: 'collector_rejected' }),
  });
  await drainMicrotasks();

  assert.deepEqual(await invocation, EMPTY_QUEUE_RESULT);
  assert.deepEqual(f.calls, ['export', 'shutdown']);
  const failure = f.logs.find(log => log.event === 'monium_metrics_export_error');
  assert.equal(failure?.error_code, 'collector_rejected');
  assert.equal(failure?.phase, 'export');
  assert.equal(failure?.duration_ms, METRICS_TIMEOUT_MS);
  assert.equal(f.logs.length, 2);
});

test('an export acknowledged at the deadline is reported as completed', { timeout: 2000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture('export');
  const invocation = f.handler(TIMER_EVENT);
  await f.entered.promise;

  t.mock.timers.setTime(Date.now() + METRICS_TIMEOUT_MS);
  f.completeExport({ code: ExportResultCode.SUCCESS });
  await drainMicrotasks();

  assert.deepEqual(await invocation, EMPTY_QUEUE_RESULT);
  assert.deepEqual(f.calls, ['export', 'forceFlush', 'shutdown']);
  assert.deepEqual(
    f.logs.map(log => log.event),
    ['retry_worker_completed', 'monium_metrics_export_completed'],
  );
});

test('a malformed endpoint is reported as an initialization error before any export', () => {
  const logs: JsonObject[] = [];
  const logger: LoggerLike = {
    info: fields => logs.push(fields),
    warn: fields => logs.push(fields),
    error: fields => logs.push(fields),
  };
  const metrics = createInvocationMetrics(undefined, logger, {
    env: {
      MONIUM_METRICS_ENABLED: 'true',
      MONIUM_PROJECT: 'test-project',
      MONIUM_API_KEY: 'test-only',
      MONIUM_METRICS_ENDPOINT: 'not a url',
    },
  });

  metrics.recordGauge('local_probe', 1);

  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.event, 'monium_metrics_init_error');
  assert.equal(logs[0]?.error_code, 'metrics_endpoint_invalid');
});
