import assert from 'node:assert/strict';
import { getDefaultResultOrder } from 'node:dns';
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

test('Telegram network failures preserve a safe diagnostic code', async () => {
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousChatId = process.env.TELEGRAM_CHAT_ID;
  const previousFetch = globalThis.fetch;

  process.env.TELEGRAM_BOT_TOKEN = '123456789:test-token-value-with-valid-length';
  process.env.TELEGRAM_CHAT_ID = '-1001234567890';
  globalThis.fetch = (async () => {
    throw Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      sendTelegram({
        submissionId: 'submission-network-test',
        formType: 'lead',
        createdAt: new Date('2026-08-09T00:00:00.000Z'),
        name: 'Анна',
        phone: '+79990000000',
        service: 'Позвонить',
        telegramUsername: '',
        utm: {},
        telegramAttempts: 1,
      }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'telegram_und_err_connect_timeout' &&
        !error.message.includes(process.env.TELEGRAM_BOT_TOKEN ?? ''),
    );
  } finally {
    globalThis.fetch = previousFetch;
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
