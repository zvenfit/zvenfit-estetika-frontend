import assert from 'node:assert/strict';
import test from 'node:test';

import { _private } from '../handler';

import type { SubmissionStore } from '../types';

test('timer exports queue health and heartbeat after a retry pass', async () => {
  const gauges: Array<{ name: string; value: number }> = [];
  const logs: Array<Record<string, unknown>> = [];
  let flushCalls = 0;
  const handler = _private.createHandler({
    loggerFactory: () => ({
      error() {},
      info(fields) {
        logs.push(fields);
      },
    }),
    metricsFactory: () => ({
      recordGauge(name, value) {
        gauges.push({ name, value });
      },
      async flush() {
        flushCalls += 1;
      },
    }),
    now: () => new Date('2026-08-12T12:00:00.000Z'),
    store: {
      async saveSubmission() {
        throw new Error('not_used');
      },
      async claimForTelegram() {
        return null;
      },
      async markTelegramDelivered() {},
      async markTelegramFailed() {},
      async listTelegramCandidates() {
        return [];
      },
      async getTelegramQueueHealth() {
        return { pendingCount: 2, oldestPendingAgeSeconds: 901 };
      },
    } satisfies SubmissionStore,
  });

  const result = await handler({
    messages: [
      { event_metadata: { event_type: 'yandex.cloud.events.serverless.triggers.TimerMessage' } },
    ],
  });

  assert.deepEqual(result, { processed: 0, sent: 0, pending: 0, failed: 0, skipped: 0 });
  assert.deepEqual(gauges, [
    { name: 'zvenfit_estetika_telegram_pending_submissions', value: 2 },
    { name: 'zvenfit_estetika_telegram_oldest_pending_age_seconds', value: 901 },
    { name: 'zvenfit_estetika_retry_worker_heartbeat', value: 1 },
  ]);
  assert.deepEqual(logs, [
    {
      event: 'retry_worker_completed',
      processed: 0,
      sent: 0,
      pending: 0,
      failed: 0,
      skipped: 0,
      queue_pending: 2,
      oldest_pending_age_seconds: 901,
    },
  ]);
  assert.equal(flushCalls, 1);
});

test('queue-health failure rejects the timer invocation and suppresses heartbeat', async () => {
  const gauges: Array<{ name: string; value: number }> = [];
  let flushCalls = 0;
  const handler = _private.createHandler({
    loggerFactory: () => ({ error() {} }),
    metricsFactory: () => ({
      recordGauge(name, value) {
        gauges.push({ name, value });
      },
      async flush() {
        flushCalls += 1;
      },
    }),
    store: {
      async saveSubmission() {
        throw new Error('not_used');
      },
      async claimForTelegram() {
        return null;
      },
      async markTelegramDelivered() {},
      async markTelegramFailed() {},
      async listTelegramCandidates() {
        return [];
      },
      async getTelegramQueueHealth() {
        throw Object.assign(new Error('offline'), { code: 'queue_offline' });
      },
    } satisfies SubmissionStore,
  });

  await assert.rejects(
    handler({
      messages: [
        { event_metadata: { event_type: 'yandex.cloud.events.serverless.triggers.TimerMessage' } },
      ],
    }),
    { code: 'queue_offline' },
  );

  assert.deepEqual(gauges, []);
  assert.equal(flushCalls, 1);
});
