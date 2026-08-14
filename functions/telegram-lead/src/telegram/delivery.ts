import { setDefaultResultOrder } from 'node:dns';
import { request as httpsRequest } from 'node:https';

import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';

import { sanitize, TRACKED_UTM_PARAMS } from '../submission-payload';

import type {
  ClaimedSubmission,
  HandlerDependencies,
  JsonObject,
  LoggerLike,
  UtmKey,
} from '../types';

const DEFAULT_TELEGRAM_TIMEOUT_MS = 15_000;
const MAX_TELEGRAM_TIMEOUT_MS = 25_000;
const TELEGRAM_LEASE_MS = 2 * 60 * 1000;
const DEFAULT_RETRY_BATCH_SIZE = 5;
const MAX_RETRY_BATCH_SIZE = 25;
const DEFAULT_MAX_TELEGRAM_ATTEMPTS = 12;
const MAX_TELEGRAM_RESPONSE_BYTES = 64 * 1024;

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

export interface RetrySummary extends JsonObject {
  processed: number;
  sent: number;
  pending: number;
  failed: number;
  skipped: number;
}

export function buildMessage(submission: ClaimedSubmission): string {
  const lines =
    submission.formType === 'newsletter'
      ? [
          'Подписка на рассылку (Косметология)',
          `ID: ${submission.submissionId}`,
          `Телефон: ${submission.phone}`,
        ]
      : [
          'Новая заявка (Косметология)',
          `ID: ${submission.submissionId}`,
          `Имя: ${submission.name}`,
          `Телефон: ${submission.phone}`,
          `Способ связи: ${submission.service}`,
        ];

  if (submission.telegramUsername) {
    lines.push(`Телеграм: ${submission.telegramUsername}`);
  }
  if (Object.keys(submission.utm).length > 0) {
    lines.push('---', 'Маркировка:');
    for (const key of TRACKED_UTM_PARAMS) {
      const value = submission.utm[key];
      if (value) {
        lines.push(`${UTM_LABELS[key]}: ${value}`);
      }
    }
  }

  return lines.join('\n');
}

export function errorCode(error: unknown, fallback = 'internal_error'): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return sanitize(error.code, 64) || fallback;
  }

  return fallback;
}

export function logDeliveryFailure(
  logger: LoggerLike,
  event: string,
  submissionId: string,
  code: string,
  attempts: number,
): void {
  logger.error({ event, submission_id: submissionId, error_code: code, attempts }, event);
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

function nextRetryAt(now: Date, attempts: number): Date {
  const delayMinutes = [1, 5, 15, 60, 6 * 60][Math.min(Math.max(attempts - 1, 0), 4)] ?? 1;

  return new Date(now.getTime() + delayMinutes * 60 * 1000);
}

function telegramError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
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
  submission: ClaimedSubmission,
  requestFactory: RequestFactory = httpsRequest,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw telegramError('Telegram is not configured', 'telegram_misconfigured');
  }

  const body = JSON.stringify({ chat_id: chatId, text: buildMessage(submission) });
  let response: { body: string; statusCode: number };
  try {
    response = await new Promise((resolve, reject) => {
      const request = requestFactory(
        new URL(`https://api.telegram.org/bot${token}/sendMessage`),
        {
          method: 'POST',
          family: 4,
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
    throw telegramError('Telegram returned an error', 'telegram_error');
  }
}

export async function deliverSubmission(
  submissionId: string,
  dependencies: HandlerDependencies,
  logger: LoggerLike,
): Promise<'sent' | 'pending' | 'failed' | 'skipped'> {
  const now = dependencies.now();
  const deliveryToken = dependencies.uuid();
  const claimed = await dependencies.store.claimForTelegram({
    submissionId,
    now,
    leaseUntil: new Date(now.getTime() + TELEGRAM_LEASE_MS),
    deliveryToken,
    logger,
  });
  if (!claimed) {
    return 'skipped';
  }

  try {
    await dependencies.telegramSender(claimed);
    await dependencies.store.markTelegramDelivered({
      submissionId,
      deliveryToken,
      notifiedAt: dependencies.now(),
      logger,
    });

    return 'sent';
  } catch (error) {
    const code = errorCode(error, 'telegram_error');
    const terminal = claimed.telegramAttempts >= dependencies.maxAttempts();
    await dependencies.store.markTelegramFailed({
      submissionId,
      deliveryToken,
      failedAt: terminal ? dependencies.now() : nextRetryAt(dependencies.now(), claimed.telegramAttempts),
      errorCode: code,
      terminal,
      logger,
    });
    logDeliveryFailure(
      logger,
      terminal ? 'telegram_delivery_failed_permanently' : 'telegram_delivery_retry_scheduled',
      submissionId,
      code,
      claimed.telegramAttempts,
    );

    return terminal ? 'failed' : 'pending';
  }
}

export async function retryPendingSubmissions(
  dependencies: HandlerDependencies,
  logger: LoggerLike,
): Promise<RetrySummary> {
  const submissionIds = await dependencies.store.listTelegramCandidates({
    now: dependencies.now(),
    limit: retryBatchSize(),
    logger,
  });
  const summary: RetrySummary = {
    processed: submissionIds.length,
    sent: 0,
    pending: 0,
    failed: 0,
    skipped: 0,
  };

  for (const submissionId of submissionIds) {
    try {
      summary[await deliverSubmission(submissionId, dependencies, logger)] += 1;
    } catch (error) {
      summary.pending += 1;
      logDeliveryFailure(
        logger,
        'telegram_delivery_retry_error',
        submissionId,
        errorCode(error, 'storage_error'),
        0,
      );
    }
  }

  return summary;
}

export const _private = { nextRetryAt, telegramNetworkErrorCode };
