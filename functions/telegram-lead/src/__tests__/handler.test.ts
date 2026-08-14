import assert from 'node:assert/strict';
import test from 'node:test';

import { _private } from '../handler';

import type {
  ClaimedSubmission,
  HandlerDependencies,
  HttpEvent,
  HttpResponse,
  LoggerLike,
  Submission,
  SubmissionStore,
} from '../types';

const ORIGIN = 'https://estetika.zvenfit.ru';
const SUBMISSION_ID = '1cc32f4f-8f06-4dc8-915f-92955c829523';
const DELIVERY_ID = '927c6260-678d-42d1-9293-a0ed5061c184';
const NOW = new Date('2026-08-09T00:00:00.000Z');
const logger: LoggerLike = { error() {}, info() {}, warn() {} };

function postEvent(overrides: Record<string, unknown> = {}, ip = '198.51.100.10'): HttpEvent {
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
      consents: { version: '2026-08-14', personal_data: true, marketing: false },
      ...overrides,
    }),
  };
}

function claimedSubmission(overrides: Partial<ClaimedSubmission> = {}): ClaimedSubmission {
  return {
    submissionId: SUBMISSION_ID,
    formType: 'lead',
    createdAt: NOW,
    name: 'Анна Смирнова',
    phone: '+7 (968) 844-00-88',
    service: 'WhatsApp',
    telegramUsername: '',
    utm: { utm_source: 'test' },
    consents: { version: '2026-08-14', personalData: true, marketing: false },
    telegramAttempts: 1,
    ...overrides,
  };
}

function dependencies(
  store: Partial<SubmissionStore>,
  overrides: Partial<HandlerDependencies> = {},
): Partial<HandlerDependencies> {
  return {
    loggerFactory: () => logger,
    maxAttempts: () => 12,
    metricsFactory: () => ({ addCounter() {}, recordGauge() {}, async flush() {} }),
    now: () => NOW,
    rateLimiter: async () => true,
    store: {
      async getTelegramQueueHealth() {
        return { pendingCount: 0, oldestPendingAgeSeconds: 0 };
      },
      ...store,
    } as SubmissionStore,
    telegramSender: async () => {},
    uuid: () => DELIVERY_ID,
    ...overrides,
  };
}

function httpResponse(value: unknown): HttpResponse {
  return value as HttpResponse;
}

test.beforeEach(() => {
  process.env.ALLOWED_ORIGINS = ORIGIN;
});

test('POST persists a pending lead and returns before Telegram delivery', async () => {
  const calls: Array<[string, unknown?]> = [];
  let telegramCalled = false;
  const handler = _private.createHandler(
    dependencies(
      {
        async saveSubmission(submission) {
          calls.push(['save', submission]);
          return { created: true, telegramStatus: 'pending' };
        },
      },
      {
        async telegramSender() {
          telegramCalled = true;
        },
      },
    ),
  );

  const response = httpResponse(await handler(postEvent({ extra: 'drop' })));

  assert.equal(response.statusCode, 202);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    submission_id: SUBMISSION_ID,
    notification: 'pending',
  });
  assert.deepEqual(calls.map(call => call[0]), ['save']);
  assert.equal(telegramCalled, false);
  const saved = calls[0]?.[1] as Submission;
  assert.deepEqual(saved.utm, { utm_source: 'test' });
  assert.deepEqual(saved.consents, {
    version: '2026-08-14',
    personalData: true,
    marketing: false,
  });
  assert.equal('extra' in saved, false);
});

test('POST stores a newsletter subscription for asynchronous delivery', async () => {
  let saved: Submission | undefined;
  let telegramCalled = false;
  const handler = _private.createHandler(
    dependencies(
      {
        async saveSubmission(submission) {
          saved = submission;
          return { created: true, telegramStatus: 'pending' };
        },
      },
      {
        async telegramSender() {
          telegramCalled = true;
        },
      },
    ),
  );

  const response = httpResponse(
    await handler(
      postEvent({
        form_type: 'newsletter',
        name: 'drop',
        service: 'drop',
        consents: { version: '2026-08-14', personal_data: true, marketing: true },
      }),
    ),
  );

  assert.equal(response.statusCode, 202);
  assert.equal(saved?.formType, 'newsletter');
  assert.equal(saved?.name, '');
  assert.equal(saved?.service, 'Рассылка');
  assert.equal(saved?.consents.marketing, true);
  assert.equal(telegramCalled, false);
});

test('timer keeps persisted data pending when Telegram is unavailable', async () => {
  let failedDelivery: { terminal: boolean; errorCode: string; failedAt: Date } | undefined;
  const handler = _private.createHandler(
    dependencies(
      {
        async listTelegramCandidates() {
          return [SUBMISSION_ID];
        },
        async claimForTelegram() {
          return claimedSubmission();
        },
        async markTelegramFailed(args) {
          failedDelivery = args;
        },
      },
      {
        async telegramSender() {
          throw Object.assign(new Error('offline'), { code: 'telegram_unreachable' });
        },
      },
    ),
  );

  const result = await handler({
    messages: [
      { event_metadata: { event_type: 'yandex.cloud.events.serverless.triggers.TimerMessage' } },
    ],
  });

  assert.deepEqual(result, { processed: 1, sent: 0, pending: 1, failed: 0, skipped: 0 });
  assert.equal(failedDelivery?.errorCode, 'telegram_unreachable');
  assert.equal(failedDelivery?.terminal, false);
  assert.equal(failedDelivery?.failedAt.toISOString(), '2026-08-09T00:01:00.000Z');
});

test('POST does not resend a submission already marked as sent', async () => {
  let claimed = false;
  const handler = _private.createHandler(
    dependencies({
      async saveSubmission() {
        return { created: false, telegramStatus: 'sent' };
      },
      async claimForTelegram() {
        claimed = true;
        return null;
      },
    }),
  );

  const response = httpResponse(await handler(postEvent()));

  assert.equal(JSON.parse(response.body).notification, 'sent');
  assert.equal(claimed, false);
});

test('POST returns 503 without Telegram when YDB is unavailable', async () => {
  let telegramCalled = false;
  const handler = _private.createHandler(
    dependencies(
      {
        async saveSubmission() {
          throw new Error('database offline');
        },
      },
      {
        async telegramSender() {
          telegramCalled = true;
        },
      },
    ),
  );

  const response = httpResponse(await handler(postEvent()));

  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: 'storage_unavailable' });
  assert.equal(telegramCalled, false);
});

test('timer retries persisted pending submissions', async () => {
  const delivered: string[] = [];
  const handler = _private.createHandler(
    dependencies({
      async listTelegramCandidates() {
        return [SUBMISSION_ID];
      },
      async claimForTelegram() {
        return claimedSubmission({ telegramAttempts: 2 });
      },
      async markTelegramDelivered(args) {
        delivered.push(args.submissionId);
      },
    }),
  );
  const event = {
    messages: [
      { event_metadata: { event_type: 'yandex.cloud.events.serverless.triggers.TimerMessage' } },
    ],
  };

  const result = await handler(event);

  assert.deepEqual(result, { processed: 1, sent: 1, pending: 0, failed: 0, skipped: 0 });
  assert.deepEqual(delivered, [SUBMISSION_ID]);
});

test('rejects origin, honeypot, malformed values and oversized bodies', async () => {
  const handler = _private.createHandler(dependencies({}));
  const forbidden = httpResponse(
    await handler({ httpMethod: 'POST', headers: { Origin: 'https://evil.example' } }),
  );
  const honeypot = httpResponse(await handler(postEvent({ website: 'bot' })));
  const invalidId = httpResponse(await handler(postEvent({ submission_id: 'invalid' })));
  const invalidService = httpResponse(await handler(postEvent({ service: 'Unknown' })));
  const missingPersonalDataConsent = httpResponse(
    await handler(postEvent({ consents: { version: '2026-08-14', personal_data: false } })),
  );
  const staleConsentVersion = httpResponse(
    await handler(postEvent({ consents: { version: 'old', personal_data: true } })),
  );
  const missingMarketingConsent = httpResponse(
    await handler(
      postEvent({
        form_type: 'newsletter',
        consents: { version: '2026-08-14', personal_data: true, marketing: false },
      }),
    ),
  );
  const oversizedEvent = postEvent();
  oversizedEvent.body = JSON.stringify({ website: 'x'.repeat(20_000) });
  const oversized = httpResponse(await handler(oversizedEvent));

  assert.equal(forbidden.statusCode, 403);
  assert.deepEqual(JSON.parse(honeypot.body), { ok: true });
  assert.equal(invalidId.statusCode, 400);
  assert.equal(invalidService.statusCode, 400);
  assert.equal(missingPersonalDataConsent.statusCode, 400);
  assert.equal(staleConsentVersion.statusCode, 400);
  assert.equal(missingMarketingConsent.statusCode, 400);
  assert.equal(oversized.statusCode, 413);
});

test('rate-limits trusted request-context IP and fails open without exposing it', async () => {
  let rateLimitCalls = 0;
  let saved = 0;
  const handler = _private.createHandler(
    dependencies(
      {
        async saveSubmission() {
          saved += 1;
          return { created: false, telegramStatus: 'sent' };
        },
      },
      {
        async rateLimiter({ sourceIp }) {
          rateLimitCalls += 1;
          assert.equal(sourceIp, '198.51.100.42');
          return false;
        },
      },
    ),
  );
  const event = postEvent({}, '198.51.100.42');
  event.headers = { ...event.headers, 'X-Forwarded-For': '203.0.113.99' };

  const limited = httpResponse(await handler(event));

  assert.equal(limited.statusCode, 429);
  assert.equal(rateLimitCalls, 1);
  assert.equal(saved, 0);

  const failOpen = _private.createHandler(
    dependencies(
      {
        async saveSubmission() {
          return { created: false, telegramStatus: 'sent' };
        },
      },
      {
        async rateLimiter() {
          throw new Error('unavailable');
        },
      },
    ),
  );
  assert.equal(httpResponse(await failOpen(postEvent())).statusCode, 200);
});
