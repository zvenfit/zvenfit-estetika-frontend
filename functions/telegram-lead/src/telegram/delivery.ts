import { setDefaultResultOrder } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIPv4 } from 'node:net';

import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import type { LookupFunction } from 'node:net';

import { TRACKED_UTM_PARAMS } from '../domain/shared';

import type { ClaimedTelegramNotification } from '../domain/telegram-notification';
import type { UtmKey } from '../domain/shared';

const DEFAULT_TELEGRAM_TIMEOUT_MS = 15_000;
const MAX_TELEGRAM_TIMEOUT_MS = 25_000;
const DEFAULT_RETRY_BATCH_SIZE = 5;
const MAX_RETRY_BATCH_SIZE = 25;
const DEFAULT_MAX_TELEGRAM_ATTEMPTS = 12;
const MAX_TELEGRAM_RESPONSE_BYTES = 64 * 1024;
const TELEGRAM_API_HOST = 'api.telegram.org';

type RequestFactory = (
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

// Yandex Cloud Functions has public IPv4 egress, while Telegram DNS can return IPv6 first.
setDefaultResultOrder('ipv4first');

const UTM_LABELS: Record<UtmKey, string> = {
  utm_source: 'source',
  utm_medium: 'medium',
  utm_campaign: 'campaign',
  utm_term: 'term',
  utm_content: 'content',
  yclid: 'yclid',
  gclid: 'gclid',
  fbclid: 'fbclid',
};

export function buildMessage(notification: ClaimedTelegramNotification): string {
  const lines =
    notification.kind === 'newsletter_subscription_requested'
      ? [
          'Запрос на подписку (Косметология)',
          `ID: ${notification.notificationId}`,
          `Телефон: ${notification.phone}`,
        ]
      : [
          'Новая заявка (Косметология)',
          `ID: ${notification.notificationId}`,
          `Имя: ${notification.name}`,
          `Телефон: ${notification.phone}`,
          `Способ связи: ${notification.contactMethod}`,
        ];

  if (notification.kind === 'lead_created' && notification.telegramUsername) {
    lines.push(`Телеграм: ${notification.telegramUsername}`);
  }
  if (Object.keys(notification.utm).length > 0) {
    lines.push('---', 'Маркировка:');
    for (const key of TRACKED_UTM_PARAMS) {
      const value = notification.utm[key];
      if (value) {
        lines.push(`${UTM_LABELS[key]}: ${value}`);
      }
    }
  }

  return lines.join('\n');
}

export function maxTelegramAttempts(): number {
  const value = Number.parseInt(process.env.MAX_TELEGRAM_ATTEMPTS ?? '', 10);

  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_TELEGRAM_ATTEMPTS;
}

export function telegramTimeoutMs(): number {
  const value = Number.parseInt(process.env.TELEGRAM_TIMEOUT_MS ?? '', 10);

  return Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_TELEGRAM_TIMEOUT_MS)
    : DEFAULT_TELEGRAM_TIMEOUT_MS;
}

export function retryBatchSize(): number {
  const value = Number.parseInt(process.env.TELEGRAM_RETRY_BATCH_SIZE ?? '', 10);

  return Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_RETRY_BATCH_SIZE)
    : DEFAULT_RETRY_BATCH_SIZE;
}

function telegramError(
  message: string,
  code: string,
  status?: number,
): Error & { code: string; status?: number } {
  return Object.assign(new Error(message), { code, name: 'TelegramError', status });
}

function telegramApiIpv4(): string {
  const value = process.env.TELEGRAM_API_IPV4?.trim() || '';
  if (value && !isIPv4(value)) {
    throw telegramError('Telegram API IPv4 override is invalid', 'telegram_misconfigured');
  }

  return value;
}

function telegramLookup(address: string): LookupFunction | undefined {
  if (!address) {
    return undefined;
  }

  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address, family: 4 }]);
      return;
    }

    callback(null, address, 4);
  };
}

function telegramNetworkErrorCode(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'name' in error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  ) {
    return 'telegram_timeout';
  }

  const directCode = error && typeof error === 'object' && 'code' in error ? error.code : null;
  const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : null;
  const causeCode = cause && typeof cause === 'object' && 'code' in cause ? cause.code : null;
  const code = typeof directCode === 'string' ? directCode : causeCode;
  if (typeof code !== 'string') {
    return 'telegram_unreachable';
  }

  const normalizedCode = code
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 40);

  return normalizedCode ? `telegram_${normalizedCode}` : 'telegram_unreachable';
}

export async function sendTelegram(
  notification: ClaimedTelegramNotification,
  requestFactory: RequestFactory = httpsRequest,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw telegramError('Telegram is not configured', 'telegram_misconfigured');
  }

  const lookup = telegramLookup(telegramApiIpv4());
  const body = JSON.stringify({ chat_id: chatId, text: buildMessage(notification) });
  let response: { body: string; statusCode: number };
  try {
    response = await new Promise((resolve, reject) => {
      const request = requestFactory(
        new URL(`https://${TELEGRAM_API_HOST}/bot${token}/sendMessage`),
        {
          method: 'POST',
          family: 4,
          ...(lookup ? { lookup } : {}),
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          signal: AbortSignal.timeout(telegramTimeoutMs()),
        },
        incoming => {
          let responseBody = '';
          incoming.setEncoding('utf8');
          incoming.on('data', (chunk: string) => {
            if (responseBody.length < MAX_TELEGRAM_RESPONSE_BYTES) {
              responseBody += chunk.slice(0, MAX_TELEGRAM_RESPONSE_BYTES - responseBody.length);
            }
          });
          incoming.on('end', () => {
            resolve({ body: responseBody, statusCode: incoming.statusCode || 0 });
          });
          incoming.on('error', reject);
        },
      );
      request.on('error', reject);
      request.end(body);
    });
  } catch (error) {
    throw telegramError('Telegram is unreachable', telegramNetworkErrorCode(error));
  }

  let responseBody: unknown = null;
  try {
    responseBody = JSON.parse(response.body);
  } catch {
    responseBody = null;
  }
  const telegramOk =
    typeof responseBody === 'object' &&
    responseBody !== null &&
    'ok' in responseBody &&
    responseBody.ok === true;
  if (response.statusCode < 200 || response.statusCode >= 300 || !telegramOk) {
    throw telegramError('Telegram returned an error', 'telegram_error', response.statusCode);
  }
}

export const _private = { telegramApiIpv4, telegramLookup, telegramNetworkErrorCode };
