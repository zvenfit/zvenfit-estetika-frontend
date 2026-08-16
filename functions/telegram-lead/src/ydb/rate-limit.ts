import { createHmac } from 'node:crypto';

import { parsePositiveInt, rateLimitsTableName } from './config';
import { getSql, observed, timed, ydbTimestamp, ydbUint32 } from './context';

import type { LoggerLike } from '../types';

const DEFAULT_MAX_REQUESTS = 5;
const DEFAULT_WINDOW_SECONDS = 10 * 60;
const MIN_SECRET_LENGTH = 32;
const MAX_CONFIGURED_REQUESTS = 1000;
const MAX_WINDOW_SECONDS = 24 * 60 * 60;
const COUNTER_RETENTION_MS = 24 * 60 * 60 * 1000;
const YDB_PRECONDITION_FAILED = 400120;

function settings(): { maxRequests: number; windowSeconds: number; secret: string } {
  const secret = (process.env.LEAD_RATE_LIMIT_SECRET || '').trim();
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error('lead_rate_limit_secret_missing');
  }

  return {
    maxRequests: Math.min(
      parsePositiveInt(process.env.LEAD_RATE_LIMIT_MAX, DEFAULT_MAX_REQUESTS),
      MAX_CONFIGURED_REQUESTS,
    ),
    windowSeconds: Math.min(
      parsePositiveInt(process.env.LEAD_RATE_LIMIT_WINDOW_SECONDS, DEFAULT_WINDOW_SECONDS),
      MAX_WINDOW_SECONDS,
    ),
    secret,
  };
}

function windowStart(now: Date, windowSeconds: number): number {
  const windowMs = windowSeconds * 1000;

  return Math.floor(now.getTime() / windowMs) * windowMs;
}

function rateKey(sourceIp: string, now: Date, windowSeconds: number, secret: string): string {
  const ipDigest = createHmac('sha256', secret).update(sourceIp.trim()).digest('hex');

  return `${ipDigest}:${windowStart(now, windowSeconds)}`;
}

function isOccupiedSlotError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === YDB_PRECONDITION_FAILED
  );
}

export async function consumeFormRateLimit({
  sourceIp,
  now,
  logger,
}: {
  sourceIp: string;
  now: Date;
  logger?: LoggerLike;
}): Promise<boolean> {
  return observed('submission_rate_limit', logger, async () => {
    const { maxRequests, windowSeconds, secret } = settings();
    const sql = await getSql();
    const rateLimitsTable = sql.identifier(rateLimitsTableName());
    const key = rateKey(sourceIp, now, windowSeconds, secret);
    const expiresAt = new Date(windowStart(now, windowSeconds) + COUNTER_RETENTION_MS);

    // Each allowed request occupies a unique primary-key slot. INSERT is the
    // atomic arbiter, so concurrent invocations cannot all observe the same
    // counter value and exceed the configured limit.
    for (let slot = 1; slot <= maxRequests; slot += 1) {
      try {
        await timed(sql`
          INSERT INTO ${rateLimitsTable} (rate_key, request_count, expires_at)
          VALUES (${`${key}:${slot}`}, ${ydbUint32(slot)}, ${ydbTimestamp(expiresAt)});
        `);

        return true;
      } catch (error) {
        if (!isOccupiedSlotError(error)) {
          throw error;
        }
      }
    }

    return false;
  });
}

export const _private = { isOccupiedSlotError, rateKey, settings, windowStart };
