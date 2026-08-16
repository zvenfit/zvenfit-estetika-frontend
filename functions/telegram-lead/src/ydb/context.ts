import { prepareAndObserveYdbOperation } from '../observability/ydb';
import { createYdbClient } from './client';
import { queryTimeoutMs } from './config';

import type {
  ClaimedSubmission,
  FormType,
  LoggerLike,
  SqlRow,
  TelegramStatus,
  YdbClient,
  YdbQuery,
  YdbValue,
} from '../types';

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

function dateValue(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

export function telegramStatus(value: unknown): TelegramStatus {
  return value === 'sending' || value === 'sent' || value === 'failed' ? value : 'pending';
}

export function rowToSubmission(row: SqlRow): ClaimedSubmission {
  let utm = {};
  let consentJson: Record<string, unknown> = {};
  try {
    utm = JSON.parse(stringValue(row.utm_json) || '{}') as Record<string, string>;
  } catch {
    utm = {};
  }
  try {
    consentJson = JSON.parse(stringValue(row.consent_json) || '{}') as Record<string, unknown>;
  } catch {
    consentJson = {};
  }

  return {
    submissionId: stringValue(row.submission_id),
    formType: (stringValue(row.form_type) || 'lead') as FormType,
    createdAt: dateValue(row.created_at),
    name: stringValue(row.name),
    phone: stringValue(row.phone),
    service: stringValue(row.service),
    telegramUsername: stringValue(row.telegram_username),
    utm,
    consents: {
      version: stringValue(consentJson.version),
      personalData: consentJson.personal_data === true,
      marketing: consentJson.marketing === true,
    },
    telegramAttempts: Number(row.telegram_attempts || 0),
  };
}

export function toEpoch(value: unknown): number {
  return dateValue(value).getTime();
}

export const _private = { firstResultSet };
