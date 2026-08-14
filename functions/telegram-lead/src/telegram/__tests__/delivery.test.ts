import assert from 'node:assert/strict';
import { getDefaultResultOrder } from 'node:dns';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';

import { buildMessage, retryBatchSize, sendTelegram, telegramTimeoutMs } from '../delivery';

test('Telegram networking prefers IPv4 for Yandex Cloud Functions', () => {
  assert.equal(getDefaultResultOrder(), 'ipv4first');
});

test('message supports lead and newsletter payloads without leaking delivery state', () => {
  const lead = buildMessage({
    submissionId: 'submission-1',
    formType: 'lead',
    createdAt: new Date('2026-08-09T00:00:00.000Z'),
    name: 'Анна',
    phone: '+79990000000',
    service: 'Telegram',
    telegramUsername: '@username',
    utm: { utm_source: 'test' },
    consents: { version: '2026-08-14', personalData: true, marketing: false },
    telegramAttempts: 2,
  });
  const newsletter = buildMessage({
    submissionId: 'submission-2',
    formType: 'newsletter',
    createdAt: new Date('2026-08-09T00:00:00.000Z'),
    name: '',
    phone: '+79990000000',
    service: 'Рассылка',
    telegramUsername: '',
    utm: {},
    consents: { version: '2026-08-14', personalData: true, marketing: true },
    telegramAttempts: 1,
  });

  assert.match(lead, /ID: submission-1/);
  assert.match(lead, /source: test/);
  assert.match(newsletter, /Подписка на рассылку/);
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
        {
          submissionId: 'submission-network-test',
          formType: 'lead',
          createdAt: new Date('2026-08-09T00:00:00.000Z'),
          name: 'Анна',
          phone: '+79990000000',
          service: 'Позвонить',
          telegramUsername: '',
          utm: {},
          consents: { version: '2026-08-14', personalData: true, marketing: false },
          telegramAttempts: 1,
        },
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

test('Telegram accepts a successful bounded JSON response over the IPv4 request', async () => {
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousChatId = process.env.TELEGRAM_CHAT_ID;
  let requestBody = '';

  process.env.TELEGRAM_BOT_TOKEN = '123456789:test-token-value-with-valid-length';
  process.env.TELEGRAM_CHAT_ID = '-1001234567890';
  const requestFactory = ((_url: URL, _options: Record<string, unknown>, callback: Function) => {
    const request = new EventEmitter() as EventEmitter & { end: (body: string) => void };
    request.end = body => {
      requestBody = body;
      const response = new Readable({ read() {} }) as Readable & { statusCode: number };
      response.statusCode = 200;
      callback(response);
      response.push('{"ok":true}');
      response.push(null);
    };

    return request;
  }) as never;

  try {
    await sendTelegram(
      {
        submissionId: 'submission-success-test',
        formType: 'newsletter',
        createdAt: new Date('2026-08-09T00:00:00.000Z'),
        name: '',
        phone: '+79990000000',
        service: 'Рассылка',
        telegramUsername: '',
        utm: {},
        consents: { version: '2026-08-14', personalData: true, marketing: true },
        telegramAttempts: 1,
      },
      requestFactory,
    );
    assert.equal(JSON.parse(requestBody).chat_id, '-1001234567890');
  } finally {
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
