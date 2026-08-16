import { prepareAndObserveYdbOperation } from '../observability/ydb';
import type { ClaimedTelegramNotification } from '../domain/telegram-notification';
import type { Utm } from '../domain/shared';
import { createYdbClient } from './client';
import { queryTimeoutMs } from './config';

import type { LoggerLike, SqlRow, YdbClient, YdbQuery, YdbValue } from '../types';

let clientPromise: Promise<YdbClient> | null = null;
let ydbValueTypes: YdbClient['types'] | null = null;

async function getClient(): Promise<YdbClient> {
  if (!clientPromise) {
    clientPromise = createYdbClient()
      .then(client => {
        ydbValueTypes = client.types;

        return client;
      })
      .catch((error: unknown) => {
        clientPromise = null;
        ydbValueTypes = null;
        throw error;
      });
  }

  return clientPromise;
}

export async function getSql(): Promise<YdbClient['sql']> {
  return (await getClient()).sql;
}

export function transactionOptions(): { idempotent: boolean; signal: AbortSignal } {
  return { idempotent: true, signal: AbortSignal.timeout(queryTimeoutMs()) };
}

export function timed<T>(query: YdbQuery<T>): YdbQuery<T> {
  return query.timeout(queryTimeoutMs());
}

export async function observed<T>(
  operation: string,
  logger: LoggerLike | undefined,
  callback: () => Promise<T>,
): Promise<T> {
  // Driver startup can take a couple of seconds in a fresh serverless
  // container. It is infrastructure warm-up, not business-query latency, so
  // complete it before starting the operation timer used by slow-YDB alerts.
  return prepareAndObserveYdbOperation(operation, logger, getSql, callback);
}

export function firstResultSet(resultSets: unknown): SqlRow[] {
  return Array.isArray(resultSets) && Array.isArray(resultSets[0])
    ? (resultSets[0] as SqlRow[])
    : [];
}

export async function close(): Promise<void> {
  const client = await clientPromise?.catch(() => null);
  await client?.close();
  clientPromise = null;
  ydbValueTypes = null;
}

function valueTypes(): YdbClient['types'] {
  if (!ydbValueTypes) {
    throw new Error('ydb_client_not_initialized');
  }

  return ydbValueTypes;
}

export function ydbTimestamp(value: Date): YdbValue<Date> {
  return new (valueTypes().Timestamp)(value);
}

export function ydbUint32(value: number): YdbValue<number> {
  return new (valueTypes().Uint32)(value);
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function dateValue(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

export function jsonObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(stringValue(value) || '{}');

    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function rowToClaimedNotification(row: SqlRow): ClaimedTelegramNotification {
  const payload = jsonObject(row.payload_json);
  const kind = stringValue(row.kind);
  const common = {
    notificationId: stringValue(row.notification_id),
    aggregateId: stringValue(row.aggregate_id),
    createdAt: dateValue(row.created_at),
    phone: stringValue(payload.phone),
    utm: jsonObject(payload.utm) as Utm,
    attempts: Number(row.attempts || 0),
  };
  if (kind === 'lead_created') {
    return {
      ...common,
      kind,
      name: stringValue(payload.name),
      contactMethod: stringValue(payload.contact_method),
      telegramUsername: stringValue(payload.telegram_username),
    };
  }
  if (kind === 'newsletter_opted_in') {
    return { ...common, kind };
  }

  throw new Error('invalid_telegram_notification_kind');
}

export function toEpoch(value: unknown): number {
  return dateValue(value).getTime();
}

export const _private = { firstResultSet, rowToClaimedNotification };
