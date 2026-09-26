import assert from 'node:assert/strict';
import test from 'node:test';

import { _private } from '../../handler';
import { QueueReadUnavailableError } from '../queue-read-unavailable';

import type { HandlerDependencies } from '../../handler';
import type { ClaimedTelegramNotification, TelegramNotificationKind } from '../../domain/telegram-notification';
import type { HttpResponse, JsonObject } from '../../types';

const TIMER = {
  messages: [{ event_metadata: { event_type: 'yandex.cloud.events.serverless.triggers.TimerMessage' } }],
};
const NOW = new Date('2026-09-25T10:00:00Z');

function fixture(kind: TelegramNotificationKind = 'lead_created') {
  const logs: JsonObject[] = [];
  const gauges: Array<{ name: string; value: number }> = [];
  let sends = 0;
  let claims = 0;
  let flushes = 0;
  let delivered = false;
  const notification: ClaimedTelegramNotification = {
    kind,
    notificationId: 'synthetic-notification',
    aggregateId: 'synthetic-aggregate',
    createdAt: NOW,
    phone: '+70000000000',
    utm: {},
    attempts: 1,
    ...(kind === 'lead_created' ? { name: 'Synthetic', contactMethod: 'phone', telegramUsername: '' } : {}),
  } as ClaimedTelegramNotification;
  const dependencies: Partial<HandlerDependencies> & Pick<HandlerDependencies, 'outbox'> = {
    loggerFactory: () => ({
      error: fields => logs.push(fields),
      warn: fields => logs.push(fields),
      info: fields => logs.push(fields),
    }),
    metricsFactory: () => ({
      recordGauge: (name, value) => { gauges.push({ name, value }); },
      async flush() { flushes += 1; },
    }),
    now: () => NOW,
    uuid: () => 'synthetic-token',
    maxAttempts: () => 12,
    retryBatchSize: () => 5,
    rateLimiter: async () => true,
    leadRepository: { async recordLead() { assert.fail('Timer must not change domain data'); } },
    newsletterRepository: {
      async recordOptInRequest() { assert.fail('Timer must not record consent'); },
      async confirmOptIn() { assert.fail('Timer must not confirm consent'); },
      async getSubscription() { assert.fail('Timer must not read consent'); },
      async unsubscribe() { assert.fail('Timer must not revoke consent'); },
      async isSuppressed() { assert.fail('Timer must not change consent'); },
    },
    telegramSender: async claimed => {
      assert.equal(claimed.kind, kind);
      sends += 1;
    },
    outbox: {
      async listCandidates() { return delivered ? [] : [notification.notificationId]; },
      async claim() { claims += 1; return delivered ? null : notification; },
      async markDelivered() { delivered = true; },
      async markFailed() { assert.fail('No delivery failure expected'); },
      async getQueueHealth() { return { pendingCount: delivered ? 0 : 1, oldestPendingAgeSeconds: 0 }; },
    },
  };
  return {
    dependencies, logs, gauges,
    handler: () => _private.createHandler(dependencies),
    sends: () => sends, claims: () => claims, flushes: () => flushes, delivered: () => delivered,
  };
}

for (const kind of ['lead_created', 'newsletter_subscription_requested'] as const) {
  test(`${kind}: deferred passes preserve the outbox, then deliver once without changing consent`, async () => {
    const f = fixture(kind);
    const list = f.dependencies.outbox.listCandidates;
    f.dependencies.outbox.listCandidates = async () => {
      throw new QueueReadUnavailableError(new Error('private details'));
    };
    const handler = f.handler();
    for (let pass = 0; pass < 10; pass += 1) {
      assert.deepEqual(await handler(TIMER), { deferred: true, stage: 'delivery' });
    }
    assert.equal(f.claims(), 0);
    assert.equal(f.sends(), 0);
    assert.equal(f.delivered(), false);
    assert.deepEqual(f.gauges, []);
    assert.equal(f.flushes(), 10);
    assert.deepEqual(f.logs, Array.from({ length: 10 }, () => ({
      event: 'retry_worker_deferred', stage: 'delivery', reason: 'queue_read_unavailable',
    })));
    f.dependencies.outbox.listCandidates = list;
    await handler(TIMER);
    await handler(TIMER);
    assert.equal(f.sends(), 1);
    assert.equal(f.delivered(), true);
    assert.equal(f.logs.filter(log => log.event === 'retry_worker_completed').length, 2);
  });

  test(`${kind}: health failure after delivery does not send again or fabricate health`, async () => {
    const f = fixture(kind);
    const health = f.dependencies.outbox.getQueueHealth;
    f.dependencies.outbox.getQueueHealth = async () => {
      throw new QueueReadUnavailableError(new Error('private details'));
    };
    const handler = f.handler();
    assert.deepEqual(await handler(TIMER), { deferred: true, stage: 'queue_health' });
    assert.equal(f.delivered(), true);
    assert.deepEqual(f.gauges, []);
    assert.equal(f.logs.some(log => log.event === 'retry_worker_completed'), false);
    f.dependencies.outbox.getQueueHealth = health;
    await handler(TIMER);
    assert.equal(f.sends(), 1);
  });
}

test('unknown or permanent reads reject the timer and still flush metrics', async () => {
  for (const method of ['listCandidates', 'getQueueHealth'] as const) {
    for (const error of [new TypeError('private bug'), Object.assign(new Error('timeout'), { code: 7 })]) {
      const f = fixture();
      f.dependencies.outbox[method] = async () => { throw error; };
      await assert.rejects(f.handler()(TIMER), candidate => candidate === error);
      assert.deepEqual(f.logs, []);
      assert.deepEqual(f.gauges, []);
      assert.equal(f.flushes(), 1);
    }
  }
});

test('a delivery storage failure retains its critical event and never becomes a deferred read', async () => {
  for (const method of ['claim', 'markFailed'] as const) {
    const f = fixture();
    f.dependencies.outbox[method] = async () => {
      throw Object.assign(new Error('private storage failure'), { code: 4 });
    };
    if (method === 'markFailed') {
      f.dependencies.telegramSender = async () => { throw new Error('private transport failure'); };
    }
    await f.handler()(TIMER);
    assert.equal(f.logs.filter(log => log.event === 'telegram_delivery_retry_error').length, 1);
    assert.equal(f.logs.some(log => log.event === 'retry_worker_deferred'), false);
    assert.equal(f.delivered(), false);
    assert.equal(f.sends(), 0);
    assert.doesNotMatch(JSON.stringify(f.logs), /private/);
  }
});

test('HTTP persistence failures for lead and newsletter still return 503 and a storage event', async context => {
  const origin = 'https://estetika.zvenfit.ru';
  const previous = process.env.ALLOWED_ORIGINS;
  process.env.ALLOWED_ORIGINS = origin;
  context.after(() => {
    if (previous === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = previous;
  });
  for (const formType of ['lead', 'newsletter']) {
    const f = fixture();
    // Even a mistakenly supplied port error must never turn a failed HTTP write into success.
    const fail = async () => { throw new QueueReadUnavailableError(new Error('private')); };
    f.dependencies.leadRepository!.recordLead = fail;
    f.dependencies.newsletterRepository!.recordOptInRequest = fail;
    const response = await f.handler()({
      httpMethod: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        submission_id: '1cc32f4f-8f06-4dc8-915f-92955c829523',
        form_type: formType, name: 'Synthetic', phone: '+7 (999) 000-00-00', service: 'WhatsApp',
        consents: { version: '2026-08-14-v2', personal_data: true, marketing: true },
      }),
    }) as HttpResponse;
    assert.equal(response.statusCode, 503);
    assert.equal(f.logs.filter(log => log.event === 'submission_storage_error').length, 1);
    assert.equal(f.logs.some(log => log.event === 'retry_worker_deferred'), false);
    assert.equal(f.sends(), 0);
    assert.equal(f.flushes(), 1);
  }
});
