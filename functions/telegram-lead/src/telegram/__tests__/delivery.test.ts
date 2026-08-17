import assert from 'node:assert/strict';
import { getDefaultResultOrder } from 'node:dns';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';

import { _private, buildMessage, retryBatchSize, sendTelegram, telegramTimeoutMs } from '../delivery';
import type {
  ClaimedTelegramNotification,
  LeadTelegramNotification,
} from '../../domain/telegram-notification';

function leadNotification(
  overrides: Partial<LeadTelegramNotification & { attempts: number }> = {},
): ClaimedTelegramNotification {
  return {
    notificationId: 'notification-1',
    kind: 'lead_created',
    aggregateId: 'lead-1',
    createdAt: new Date('2026-08-09T00:00:00.000Z'),
    name: 'Анна',
    phone: '+79990000000',
    contactMethod: 'Telegram',
    telegramUsername: '@username',
    utm: { utm_source: 'test' },
    attempts: 1,
    ...overrides,
  };
}

function newsletterNotification(): ClaimedTelegramNotification {
  return {
    notificationId: 'notification-2',
    kind: 'newsletter_subscription_requested',
    aggregateId: 'notification-2',
    createdAt: new Date('2026-08-09T00:00:00.000Z'),
    phone: '+79990000000',
    utm: {},
    attempts: 1,
  };
}

test('Telegram networking prefers IPv4 for Yandex Cloud Functions', () => {
  assert.equal(getDefaultResultOrder(), 'ipv4first');
});

test('message supports lead and newsletter payloads without leaking delivery state', () => {
  const lead = buildMessage(leadNotification({ notificationId: 'notification-1', attempts: 2 }));
  const newsletter = buildMessage(newsletterNotification());

  assert.match(lead, /ID: notification-1/);
  assert.match(lead, /source: test/);
  assert.match(newsletter, /Запрос на подписку/);
  assert.doesNotMatch(newsletter, /Имя:/);
  assert.doesNotMatch(lead, /attempt/i);
});

test('Telegram timeout is configurable and capped below the function timeout', () => {
  const previousTimeout = process.env.TELEGRAM_TIMEOUT_MS;

  try {
    delete process.env.TELEGRAM_TIMEOUT_MS;
    assert.equal(telegramTimeoutMs(), 15_000);

    process.env.TELEGRAM_TIMEOUT_MS = '20000';
    assert.equal(telegramTimeoutMs(), 20_000);

    process.env.TELEGRAM_TIMEOUT_MS = '999999';
    assert.equal(telegramTimeoutMs(), 25_000);
  } finally {
    if (previousTimeout === undefined) {
      delete process.env.TELEGRAM_TIMEOUT_MS;
    } else {
      process.env.TELEGRAM_TIMEOUT_MS = previousTimeout;
    }
  }
});

test('Telegram worker uses a small configurable retry batch', () => {
  const previousBatchSize = process.env.TELEGRAM_RETRY_BATCH_SIZE;

  try {
    delete process.env.TELEGRAM_RETRY_BATCH_SIZE;
    assert.equal(retryBatchSize(), 5);

    process.env.TELEGRAM_RETRY_BATCH_SIZE = '10';
    assert.equal(retryBatchSize(), 10);

    process.env.TELEGRAM_RETRY_BATCH_SIZE = '999';
    assert.equal(retryBatchSize(), 25);
  } finally {
    if (previousBatchSize === undefined) {
      delete process.env.TELEGRAM_RETRY_BATCH_SIZE;
    } else {
      process.env.TELEGRAM_RETRY_BATCH_SIZE = previousBatchSize;
    }
  }
});

test('Telegram forces an IPv4 socket and preserves a safe network diagnostic code', async () => {
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousChatId = process.env.TELEGRAM_CHAT_ID;
  let requestOptions: Record<string, unknown> = {};

  process.env.TELEGRAM_BOT_TOKEN = '123456789:test-token-value-with-valid-length';
  process.env.TELEGRAM_CHAT_ID = '-1001234567890';
  _private.resetTelegramRouteCache();
  const requestFactory = ((_url: URL, options: Record<string, unknown>) => {
    requestOptions = options;
    const request = new EventEmitter() as EventEmitter & { end: () => void };
    request.end = () => {
      process.nextTick(() => {
        request.emit('error', Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' }));
      });
    };

    return request;
  }) as never;

  try {
    await assert.rejects(
      sendTelegram(
        leadNotification({
          notificationId: 'notification-network-test',
          contactMethod: 'Позвонить',
          telegramUsername: '',
          utm: {},
        }),
        requestFactory,
      ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'telegram_etimedout' &&
        !error.message.includes(process.env.TELEGRAM_BOT_TOKEN ?? ''),
    );
    assert.equal(requestOptions.family, 4);
  } finally {
    _private.resetTelegramRouteCache();
    if (previousToken === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = previousToken;
    }
    if (previousChatId === undefined) {
      delete process.env.TELEGRAM_CHAT_ID;
    } else {
      process.env.TELEGRAM_CHAT_ID = previousChatId;
    }
  }
});

test('Telegram falls back after a safe probe and sends exactly one POST', async () => {
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousChatId = process.env.TELEGRAM_CHAT_ID;
  const previousFallbackIpv4s = process.env.TELEGRAM_API_FALLBACK_IPV4S;
  let requestBody = '';
  let requestUrl: URL | undefined;
  let requestOptions: Record<string, unknown> = {};
  let postCount = 0;

  process.env.TELEGRAM_BOT_TOKEN = '123456789:test-token-value-with-valid-length';
  process.env.TELEGRAM_CHAT_ID = '-1001234567890';
  process.env.TELEGRAM_API_FALLBACK_IPV4S = '149.154.167.220';
  const requestFactory = ((url: URL, options: Record<string, unknown>, callback: Function) => {
    const request = new EventEmitter() as EventEmitter & { end: (body?: string) => void };
    request.end = body => {
      if (options.method === 'HEAD' && !options.lookup) {
        request.emit('error', Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' }));
        return;
      }
      const response = new Readable({ read() {} }) as Readable & { statusCode: number };
      response.statusCode = options.method === 'HEAD' ? 302 : 200;
      callback(response);
      if (options.method === 'POST') {
        postCount += 1;
        requestUrl = url;
        requestOptions = options;
        requestBody = body || '';
        response.push('{"ok":true}');
      }
      response.push(null);
    };

    return request;
  }) as never;

  try {
    _private.resetTelegramRouteCache();
    await sendTelegram(newsletterNotification(), requestFactory);
    assert.equal(JSON.parse(requestBody).chat_id, '-1001234567890');
    assert.equal(postCount, 1);
    assert.equal(requestUrl?.hostname, 'api.telegram.org');
    assert.equal(typeof requestOptions.lookup, 'function');
    assert.deepEqual(
      await new Promise(resolve => {
        (requestOptions.lookup as Function)(
          'api.telegram.org',
          { all: true, family: 4 },
          (error: Error | null, addresses: unknown) => resolve({ error, addresses }),
        );
      }),
      { error: null, addresses: [{ address: '149.154.167.220', family: 4 }] },
    );
  } finally {
    _private.resetTelegramRouteCache();
    if (previousToken === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = previousToken;
    }
    if (previousChatId === undefined) {
      delete process.env.TELEGRAM_CHAT_ID;
    } else {
      process.env.TELEGRAM_CHAT_ID = previousChatId;
    }
    if (previousFallbackIpv4s === undefined) {
      delete process.env.TELEGRAM_API_FALLBACK_IPV4S;
    } else {
      process.env.TELEGRAM_API_FALLBACK_IPV4S = previousFallbackIpv4s;
    }
  }
});

test('Telegram rejects an invalid fallback list before opening a request', async () => {
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousChatId = process.env.TELEGRAM_CHAT_ID;
  const previousFallbackIpv4s = process.env.TELEGRAM_API_FALLBACK_IPV4S;

  process.env.TELEGRAM_BOT_TOKEN = '123456789:test-token-value-with-valid-length';
  process.env.TELEGRAM_CHAT_ID = '-1001234567890';
  process.env.TELEGRAM_API_FALLBACK_IPV4S = '149.154.167.220,not-an-ip';

  try {
    _private.resetTelegramRouteCache();
    await assert.rejects(
      sendTelegram(newsletterNotification()),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'telegram_misconfigured' &&
        !error.message.includes(process.env.TELEGRAM_BOT_TOKEN ?? ''),
    );
    assert.throws(() => _private.telegramFallbackIpv4s(), /fallback IPv4 list is invalid/);
  } finally {
    _private.resetTelegramRouteCache();
    if (previousToken === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = previousToken;
    }
    if (previousChatId === undefined) {
      delete process.env.TELEGRAM_CHAT_ID;
    } else {
      process.env.TELEGRAM_CHAT_ID = previousChatId;
    }
    if (previousFallbackIpv4s === undefined) {
      delete process.env.TELEGRAM_API_FALLBACK_IPV4S;
    } else {
      process.env.TELEGRAM_API_FALLBACK_IPV4S = previousFallbackIpv4s;
    }
  }
});

test('Telegram prefers DNS and reuses the healthy route from the warm cache', async () => {
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousChatId = process.env.TELEGRAM_CHAT_ID;
  const previousFallbackIpv4s = process.env.TELEGRAM_API_FALLBACK_IPV4S;
  let headCount = 0;
  let postCount = 0;
  const postLookups: unknown[] = [];

  process.env.TELEGRAM_BOT_TOKEN = '123456789:test-token-value-with-valid-length';
  process.env.TELEGRAM_CHAT_ID = '-1001234567890';
  process.env.TELEGRAM_API_FALLBACK_IPV4S = '149.154.167.220';
  const requestFactory = ((_url: URL, options: Record<string, unknown>, callback: Function) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void };
    request.end = () => {
      const response = new Readable({ read() {} }) as Readable & { statusCode: number };
      response.statusCode = options.method === 'HEAD' ? 302 : 200;
      callback(response);
      if (options.method === 'HEAD') {
        headCount += 1;
      } else {
        postCount += 1;
        postLookups.push(options.lookup);
        response.push('{"ok":true}');
      }
      response.push(null);
    };
    return request;
  }) as never;

  try {
    _private.resetTelegramRouteCache();
    await sendTelegram(newsletterNotification(), requestFactory);
    await sendTelegram(newsletterNotification(), requestFactory);
    assert.equal(headCount, 2);
    assert.equal(postCount, 2);
    assert.deepEqual(postLookups, [undefined, undefined]);
  } finally {
    _private.resetTelegramRouteCache();
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    if (previousChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = previousChatId;
    if (previousFallbackIpv4s === undefined) delete process.env.TELEGRAM_API_FALLBACK_IPV4S;
    else process.env.TELEGRAM_API_FALLBACK_IPV4S = previousFallbackIpv4s;
  }
});

test('Telegram never retries an ambiguous POST over another route', async () => {
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousChatId = process.env.TELEGRAM_CHAT_ID;
  const previousFallbackIpv4s = process.env.TELEGRAM_API_FALLBACK_IPV4S;
  let postCount = 0;

  process.env.TELEGRAM_BOT_TOKEN = '123456789:test-token-value-with-valid-length';
  process.env.TELEGRAM_CHAT_ID = '-1001234567890';
  process.env.TELEGRAM_API_FALLBACK_IPV4S = '149.154.167.220';
  const requestFactory = ((_url: URL, options: Record<string, unknown>, callback: Function) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void };
    request.end = () => {
      if (options.method === 'HEAD' && !options.lookup) {
        request.emit('error', Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' }));
        return;
      }
      if (options.method === 'POST') {
        postCount += 1;
        request.emit('error', Object.assign(new Error('ambiguous timeout'), { code: 'ETIMEDOUT' }));
        return;
      }
      const response = new Readable({ read() {} }) as Readable & { statusCode: number };
      response.statusCode = 302;
      callback(response);
      response.push(null);
    };
    return request;
  }) as never;

  try {
    _private.resetTelegramRouteCache();
    await assert.rejects(sendTelegram(newsletterNotification(), requestFactory));
    assert.equal(postCount, 1);
  } finally {
    _private.resetTelegramRouteCache();
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    if (previousChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = previousChatId;
    if (previousFallbackIpv4s === undefined) delete process.env.TELEGRAM_API_FALLBACK_IPV4S;
    else process.env.TELEGRAM_API_FALLBACK_IPV4S = previousFallbackIpv4s;
  }
});

test('Telegram HTTP failures preserve a safe type and upstream status', async () => {
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousChatId = process.env.TELEGRAM_CHAT_ID;

  process.env.TELEGRAM_BOT_TOKEN = '123456789:test-token-value-with-valid-length';
  process.env.TELEGRAM_CHAT_ID = '-1001234567890';
  const requestFactory = ((_url: URL, options: Record<string, unknown>, callback: Function) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void };
    request.end = () => {
      const response = new Readable({ read() {} }) as Readable & { statusCode: number };
      response.statusCode = options.method === 'HEAD' ? 302 : 429;
      callback(response);
      if (options.method === 'POST') response.push('{"ok":false}');
      response.push(null);
    };

    return request;
  }) as never;

  try {
    _private.resetTelegramRouteCache();
    await assert.rejects(
      sendTelegram(
        leadNotification({
          notificationId: 'notification-http-error-test',
          contactMethod: 'Позвонить',
          telegramUsername: '',
          utm: {},
        }),
        requestFactory,
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.name === 'TelegramError' &&
        'code' in error &&
        error.code === 'telegram_error' &&
        'status' in error &&
        error.status === 429,
    );
  } finally {
    _private.resetTelegramRouteCache();
    if (previousToken === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = previousToken;
    }
    if (previousChatId === undefined) {
      delete process.env.TELEGRAM_CHAT_ID;
    } else {
      process.env.TELEGRAM_CHAT_ID = previousChatId;
    }
  }
});
