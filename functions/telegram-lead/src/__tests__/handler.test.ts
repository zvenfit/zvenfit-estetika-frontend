import assert from 'node:assert/strict';
import test from 'node:test';

import { _private } from '../handler';

import type {
  LeadIntakeRepository,
  NewsletterRepository,
  TelegramOutbox,
} from '../application/ports';
import type { HandlerDependencies } from '../handler';
import type { Lead } from '../domain/lead';
import type { NewsletterOptInRequest } from '../domain/newsletter';
import type { ClaimedTelegramNotification } from '../domain/telegram-notification';
import type { HttpEvent, HttpResponse, LoggerLike } from '../types';

const ORIGIN = 'https://estetika.zvenfit.ru';
const REQUEST_ID = '1cc32f4f-8f06-4dc8-915f-92955c829523';
const DELIVERY_ID = '927c6260-678d-42d1-9293-a0ed5061c184';
const NOW = new Date('2026-08-09T00:00:00.000Z');
const logger: LoggerLike = { error() {}, info() {}, warn() {} };

function postEvent(overrides: Record<string, unknown> = {}, ip = '198.51.100.10'): HttpEvent {
  return {
    httpMethod: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    requestContext: { identity: { sourceIp: ip } },
    body: JSON.stringify({
      submission_id: REQUEST_ID,
      form_type: 'lead',
      name: 'Анна Смирнова',
      phone: '+7 (968) 844-00-88',
      service: 'WhatsApp',
      telegram_username: '',
      utm: { utm_source: 'test', ignored: 'drop' },
      consents: { version: '2026-08-14-v2', personal_data: true, marketing: false },
      ...overrides,
    }),
  };
}

function claimedNotification(
  overrides: Partial<ClaimedTelegramNotification> = {},
): ClaimedTelegramNotification {
  return {
    notificationId: REQUEST_ID,
    kind: 'lead_created',
    aggregateId: REQUEST_ID,
    createdAt: NOW,
    name: 'Анна Смирнова',
    phone: '+7 (968) 844-00-88',
    contactMethod: 'WhatsApp',
    telegramUsername: '',
    utm: { utm_source: 'test' },
    attempts: 1,
    ...overrides,
  } as ClaimedTelegramNotification;
}

interface RepositoryOverrides {
  lead?: Partial<LeadIntakeRepository>;
  newsletter?: Partial<NewsletterRepository>;
  outbox?: Partial<TelegramOutbox>;
}

function dependencies(
  repositories: RepositoryOverrides = {},
  overrides: Partial<HandlerDependencies> = {},
): Partial<HandlerDependencies> {
  return {
    leadRepository: {
      async recordLead() {
        throw new Error('not_used');
      },
      ...repositories.lead,
    },
    newsletterRepository: {
      async recordOptInRequest() {
        throw new Error('not_used');
      },
      async confirmOptIn() {
        return { eventCreated: false, stateChanged: false };
      },
      async getSubscription() {
        return null;
      },
      async unsubscribe() {
        return { eventCreated: false, stateChanged: false };
      },
      async isSuppressed() {
        return true;
      },
      ...repositories.newsletter,
    },
    outbox: {
      async claim() {
        return null;
      },
      async markDelivered() {},
      async markFailed() {},
      async listCandidates() {
        return [];
      },
      async getQueueHealth() {
        return { pendingCount: 0, oldestPendingAgeSeconds: 0 };
      },
      ...repositories.outbox,
    },
    loggerFactory: () => logger,
    maxAttempts: () => 12,
    metricsFactory: () => ({ recordGauge() {}, async flush() {} }),
    now: () => NOW,
    rateLimiter: async () => true,
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

test('POST persists a lead through the lead repository and returns before Telegram delivery', async () => {
  let saved: Lead | undefined;
  let telegramCalled = false;
  const handler = _private.createHandler(
    dependencies(
      {
        lead: {
          async recordLead(lead) {
            saved = lead;
            return { created: true, notificationStatus: 'pending' };
          },
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
    submission_id: REQUEST_ID,
    notification: 'pending',
  });
  assert.equal(saved?.contactMethod, 'WhatsApp');
  assert.deepEqual(saved?.utm, { utm_source: 'test' });
  assert.deepEqual(saved?.consents, {
    version: '2026-08-14-v2',
    personalData: true,
    marketing: false,
  });
  assert.equal(telegramCalled, false);
});

test('POST records a newsletter opt-in request without claiming it is active', async () => {
  let saved: NewsletterOptInRequest | undefined;
  const handler = _private.createHandler(
    dependencies({
      newsletter: {
        async recordOptInRequest(request) {
          saved = request;
          return { created: true, notificationStatus: 'pending' };
        },
      },
    }),
  );

  const response = httpResponse(
    await handler(
      postEvent({
        form_type: 'newsletter',
        name: 'drop',
        service: 'drop',
        consents: { version: '2026-08-14-v2', personal_data: true, marketing: true },
      }),
    ),
  );

  assert.equal(response.statusCode, 202);
  assert.equal(JSON.parse(response.body).confirmation_required, true);
  assert.equal(saved?.phoneNormalized, '+79688440088');
  assert.equal(saved?.consents.marketing, true);
});

test('timer keeps an outbox notification pending when Telegram is unavailable', async () => {
  let failedDelivery: { terminal: boolean; errorCode: string; failedAt: Date } | undefined;
  const handler = _private.createHandler(
    dependencies(
      {
        outbox: {
          async listCandidates() {
            return [REQUEST_ID];
          },
          async claim() {
            return claimedNotification();
          },
          async markFailed(args) {
            failedDelivery = args;
          },
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

test('POST returns the existing outbox delivery status for an idempotent request', async () => {
  const handler = _private.createHandler(
    dependencies({
      lead: {
        async recordLead() {
          return { created: false, notificationStatus: 'sent' };
        },
      },
    }),
  );

  const response = httpResponse(await handler(postEvent()));

  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).notification, 'sent');
});

test('POST returns 503 without attempting Telegram when YDB is unavailable', async () => {
  let telegramCalled = false;
  const handler = _private.createHandler(
    dependencies(
      {
        lead: {
          async recordLead() {
            throw new Error('database offline');
          },
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

test('timer claims and delivers pending outbox notifications', async () => {
  const delivered: string[] = [];
  const handler = _private.createHandler(
    dependencies({
      outbox: {
        async listCandidates() {
          return [REQUEST_ID];
        },
        async claim() {
          return claimedNotification({ attempts: 2 });
        },
        async markDelivered(args) {
          delivered.push(args.notificationId);
        },
      },
    }),
  );

  const result = await handler({
    messages: [
      { event_metadata: { event_type: 'yandex.cloud.events.serverless.triggers.TimerMessage' } },
    ],
  });

  assert.deepEqual(result, { processed: 1, sent: 1, pending: 0, failed: 0, skipped: 0 });
  assert.deepEqual(delivered, [REQUEST_ID]);
});

test('rejects origin, honeypot, malformed values and oversized bodies', async () => {
  const handler = _private.createHandler(dependencies());
  const forbidden = httpResponse(
    await handler({ httpMethod: 'POST', headers: { Origin: 'https://evil.example' } }),
  );
  const honeypot = httpResponse(await handler(postEvent({ website: 'bot' })));
  const invalidId = httpResponse(await handler(postEvent({ submission_id: 'invalid' })));
  const invalidService = httpResponse(await handler(postEvent({ service: 'Unknown' })));
  const missingPersonalDataConsent = httpResponse(
    await handler(postEvent({ consents: { version: '2026-08-14-v2', personal_data: false } })),
  );
  const staleConsentVersion = httpResponse(
    await handler(postEvent({ consents: { version: 'old', personal_data: true } })),
  );
  const missingMarketingConsent = httpResponse(
    await handler(
      postEvent({
        form_type: 'newsletter',
        consents: { version: '2026-08-14-v2', personal_data: true, marketing: false },
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
  let saved = 0;
  const repository = {
    lead: {
      async recordLead() {
        saved += 1;
        return { created: false, notificationStatus: 'sent' as const };
      },
    },
  };
  const handler = _private.createHandler(
    dependencies(repository, {
      async rateLimiter({ sourceIp }) {
        assert.equal(sourceIp, '198.51.100.42');
        return false;
      },
    }),
  );
  const event = postEvent({}, '198.51.100.42');
  event.headers = { ...event.headers, 'X-Forwarded-For': '203.0.113.99' };

  assert.equal(httpResponse(await handler(event)).statusCode, 429);
  assert.equal(saved, 0);

  const failOpen = _private.createHandler(
    dependencies(repository, {
      async rateLimiter() {
        throw new Error('unavailable');
      },
    }),
  );
  assert.equal(httpResponse(await failOpen(postEvent())).statusCode, 200);
});
