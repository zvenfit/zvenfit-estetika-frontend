'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { _private, _resetRateLimitForTests } = require('../handler');

const ORIGIN = 'https://estetika.zvenfit.ru';
const SUBMISSION_ID = '1cc32f4f-8f06-4dc8-915f-92955c829523';
const DELIVERY_ID = '927c6260-678d-42d1-9293-a0ed5061c184';
const NOW = new Date('2026-08-09T00:00:00.000Z');

function postEvent(overrides = {}, ip = '198.51.100.10') {
  return {
    httpMethod: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    requestContext: { identity: { sourceIp: ip } },
    body: JSON.stringify({
      submission_id: SUBMISSION_ID,
      form_type: 'lead',
      name: 'Анна Смирнова',
      phone: '+7 (968) 844-00-88',
      service: 'WhatsApp',
      telegram_username: '',
      utm: { utm_source: 'test', ignored: 'drop' },
      ...overrides,
    }),
  };
}

function claimedSubmission(overrides = {}) {
  return {
    submissionId: SUBMISSION_ID,
    formType: 'lead',
    createdAt: NOW,
    name: 'Анна Смирнова',
    phone: '+7 (968) 844-00-88',
    service: 'WhatsApp',
    telegramUsername: '',
    utm: { utm_source: 'test' },
    telegramAttempts: 1,
    ...overrides,
  };
}

function dependencies(store, overrides = {}) {
  return {
    maxAttempts: () => 12,
    now: () => NOW,
    store,
    telegramSender: async () => {},
    uuid: () => DELIVERY_ID,
    ...overrides,
  };
}

test.beforeEach(() => {
  process.env.ALLOWED_ORIGINS = ORIGIN;
  _resetRateLimitForTests();
});

test('POST persists a lead before Telegram delivery', async () => {
  const calls = [];
  const store = {
    async saveSubmission(submission) {
      calls.push(['save', submission]);
      return { created: true, telegramStatus: 'pending' };
    },
    async claimForTelegram() {
      calls.push(['claim']);
      return claimedSubmission();
    },
    async markTelegramDelivered(args) {
      calls.push(['delivered', args]);
    },
  };
  const handler = _private.createHandler(
    dependencies(store, {
      async telegramSender(submission) {
        calls.push(['telegram', submission]);
      },
    }),
  );

  const response = await handler(postEvent({ extra: 'drop' }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    submission_id: SUBMISSION_ID,
    notification: 'sent',
  });
  assert.deepEqual(calls.map(call => call[0]), ['save', 'claim', 'telegram', 'delivered']);
  assert.deepEqual(calls[0][1].utm, { utm_source: 'test' });
  assert.equal(calls[0][1].extra, undefined);
});

test('POST stores and delivers a newsletter subscription', async () => {
  let saved;
  let delivered;
  const store = {
    async saveSubmission(submission) {
      saved = submission;
      return { created: true, telegramStatus: 'pending' };
    },
    async claimForTelegram() {
      return claimedSubmission({
        formType: 'newsletter',
        name: '',
        service: 'Рассылка',
      });
    },
    async markTelegramDelivered() {},
  };
  const handler = _private.createHandler(
    dependencies(store, {
      async telegramSender(submission) {
        delivered = submission;
      },
    }),
  );

  const response = await handler(
    postEvent({ form_type: 'newsletter', name: 'drop', service: 'drop' }),
  );

  assert.equal(response.statusCode, 200);
  assert.equal(saved.formType, 'newsletter');
  assert.equal(saved.name, '');
  assert.equal(saved.service, 'Рассылка');
  assert.match(_private.buildMessage(delivered), /Подписка на рассылку/);
  assert.doesNotMatch(_private.buildMessage(delivered), /Имя:/);
});

test('POST acknowledges persisted data when Telegram is unavailable', async () => {
  let failedDelivery;
  const store = {
    async saveSubmission() {
      return { created: true, telegramStatus: 'pending' };
    },
    async claimForTelegram() {
      return claimedSubmission();
    },
    async markTelegramFailed(args) {
      failedDelivery = args;
    },
  };
  const handler = _private.createHandler(
    dependencies(store, {
      async telegramSender() {
        const error = new Error('offline');
        error.code = 'telegram_unreachable';
        throw error;
      },
    }),
  );
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const response = await handler(postEvent());

    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body).notification, 'pending');
    assert.equal(failedDelivery.errorCode, 'telegram_unreachable');
    assert.equal(failedDelivery.terminal, false);
    assert.equal(failedDelivery.failedAt.toISOString(), '2026-08-09T00:01:00.000Z');
  } finally {
    console.error = originalConsoleError;
  }
});

test('POST does not resend a submission already marked as sent', async () => {
  let claimed = false;
  const store = {
    async saveSubmission() {
      return { created: false, telegramStatus: 'sent' };
    },
    async claimForTelegram() {
      claimed = true;
      return null;
    },
  };
  const handler = _private.createHandler(dependencies(store));

  const response = await handler(postEvent());

  assert.equal(JSON.parse(response.body).notification, 'sent');
  assert.equal(claimed, false);
});

test('POST returns 503 without Telegram when YDB is unavailable', async () => {
  let telegramCalled = false;
  const store = {
    async saveSubmission() {
      throw new Error('database offline');
    },
  };
  const handler = _private.createHandler(
    dependencies(store, {
      async telegramSender() {
        telegramCalled = true;
      },
    }),
  );
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const response = await handler(postEvent());

    assert.equal(response.statusCode, 503);
    assert.deepEqual(JSON.parse(response.body), { ok: false, error: 'storage_unavailable' });
    assert.equal(telegramCalled, false);
  } finally {
    console.error = originalConsoleError;
  }
});

test('timer retries persisted pending submissions', async () => {
  const delivered = [];
  const store = {
    async listTelegramCandidates() {
      return [SUBMISSION_ID];
    },
    async claimForTelegram() {
      return claimedSubmission({ telegramAttempts: 2 });
    },
    async markTelegramDelivered(args) {
      delivered.push(args.submissionId);
    },
  };
  const handler = _private.createHandler(dependencies(store));
  const event = {
    messages: [
      { event_metadata: { event_type: 'yandex.cloud.events.serverless.triggers.TimerMessage' } },
    ],
  };

  const result = await handler(event);

  assert.deepEqual(result, { processed: 1, sent: 1, pending: 0, failed: 0, skipped: 0 });
  assert.deepEqual(delivered, [SUBMISSION_ID]);
});

test('rejects an origin outside the allowlist', async () => {
  const handler = _private.createHandler(dependencies({}));
  const response = await handler({
    httpMethod: 'POST',
    headers: { Origin: 'https://evil.example' },
  });

  assert.equal(response.statusCode, 403);
});

test('honeypot returns success without persistence', async () => {
  let saved = false;
  const handler = _private.createHandler(
    dependencies({
      async saveSubmission() {
        saved = true;
      },
    }),
  );

  const response = await handler(postEvent({ website: 'bot' }));

  assert.equal(response.statusCode, 200);
  assert.equal(saved, false);
});

test('rejects malformed IDs, unknown services and oversized bodies', async () => {
  const handler = _private.createHandler(dependencies({}));
  const invalidId = await handler(postEvent({ submission_id: 'invalid' }));
  const invalidService = await handler(postEvent({ service: 'Unknown' }));
  const oversizedEvent = postEvent();
  oversizedEvent.body = JSON.stringify({ website: 'x'.repeat(20_000) });
  const oversized = await handler(oversizedEvent);

  assert.equal(invalidId.statusCode, 400);
  assert.equal(invalidService.statusCode, 400);
  assert.equal(oversized.statusCode, 413);
});

test('rate limits repeated requests and prefers the trusted request-context IP', async () => {
  const store = {
    async saveSubmission() {
      return { created: false, telegramStatus: 'sent' };
    },
  };
  const handler = _private.createHandler(dependencies(store));
  let last;

  for (let index = 0; index < 11; index += 1) {
    last = await handler(postEvent({}, '198.51.100.77'));
  }

  assert.equal(last.statusCode, 429);
  assert.equal(
    _private.getRequestIp({
      headers: { 'X-Forwarded-For': '203.0.113.99' },
      requestContext: { identity: { sourceIp: '198.51.100.42' } },
    }),
    '198.51.100.42',
  );
});
