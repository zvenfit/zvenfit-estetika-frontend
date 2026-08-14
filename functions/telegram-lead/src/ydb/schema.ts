import { createYdbClient } from './client';
import {
  dueIndexName,
  queryTimeoutMs,
  queueHealthIndexName,
  rateLimitsTableName,
  tableName,
} from './config';

import type { YdbClient, YdbQuery } from '../types';

interface SchemaContext extends YdbClient {
  submissionsTable: unknown;
  rateLimitsTable: unknown;
  dueIndex: unknown;
  queueHealthIndex: unknown;
}

function timed<T>(query: YdbQuery<T>): YdbQuery<T> {
  return query.timeout(queryTimeoutMs());
}

async function createSubmissionsTable({ sql, submissionsTable }: SchemaContext): Promise<void> {
  await timed(
    sql`
      CREATE TABLE IF NOT EXISTS ${submissionsTable} (
        submission_id Utf8 NOT NULL,
        form_type Utf8 NOT NULL,
        created_at Timestamp NOT NULL,
        name Utf8 NOT NULL,
        phone Utf8 NOT NULL,
        service Utf8 NOT NULL,
        telegram_username Utf8 NOT NULL,
        utm_json Utf8 NOT NULL,
        consent_json Utf8 NOT NULL,
        telegram_status Utf8 NOT NULL,
        telegram_attempts Uint32 NOT NULL,
        telegram_due_at Timestamp,
        telegram_delivery_token Utf8,
        telegram_last_error Utf8,
        telegram_notified_at Timestamp,
        INDEX idx_telegram_due GLOBAL SYNC
          ON (telegram_due_at, created_at)
          COVER (telegram_status),
        INDEX idx_telegram_status_created GLOBAL SYNC
          ON (telegram_status, created_at),
        PRIMARY KEY (submission_id)
      );
    `.idempotent(true),
  );
}

async function createRateLimitsTable({ sql, rateLimitsTable }: SchemaContext): Promise<void> {
  await timed(
    sql`
      CREATE TABLE IF NOT EXISTS ${rateLimitsTable} (
        rate_key Utf8 NOT NULL,
        request_count Uint32 NOT NULL,
        expires_at Timestamp NOT NULL,
        PRIMARY KEY (rate_key)
      ) WITH (
        TTL = Interval("PT0S") ON expires_at
      );
    `.idempotent(true),
  );
}

async function verifySubmissionColumns({ sql, submissionsTable }: SchemaContext): Promise<void> {
  await timed(
    sql`
      SELECT
        submission_id,
        form_type,
        created_at,
        name,
        phone,
        service,
        telegram_username,
        utm_json,
        consent_json,
        telegram_status,
        telegram_attempts,
        telegram_due_at,
        telegram_delivery_token,
        telegram_last_error,
        telegram_notified_at
      FROM ${submissionsTable}
      LIMIT ${0};
    `
      .idempotent(true)
      .isolation('snapshotReadOnly'),
  );
}

async function verifyRateLimitsSchema({ sql, rateLimitsTable }: SchemaContext): Promise<void> {
  await timed(
    sql`
      SELECT rate_key, request_count, expires_at
      FROM ${rateLimitsTable}
      LIMIT ${0};
    `
      .idempotent(true)
      .isolation('snapshotReadOnly'),
  );
}

async function verifyDueIndex({ sql, submissionsTable, dueIndex, types }: SchemaContext): Promise<void> {
  await timed(
    sql`
      SELECT submission_id
      FROM ${submissionsTable} VIEW ${dueIndex}
      WHERE
        telegram_due_at <= ${new types.Timestamp(new Date())}
        AND (telegram_status = ${'pending'} OR telegram_status = ${'sending'})
      ORDER BY telegram_due_at, created_at, submission_id
      LIMIT ${1};
    `
      .idempotent(true)
      .isolation('snapshotReadOnly'),
  );
}

async function verifyQueueHealthIndex({
  sql,
  submissionsTable,
  queueHealthIndex,
}: SchemaContext): Promise<void> {
  await timed(
    sql`
      SELECT created_at
      FROM ${submissionsTable} VIEW ${queueHealthIndex}
      WHERE telegram_status = ${'pending'} OR telegram_status = ${'sending'}
      ORDER BY telegram_status, created_at
      LIMIT ${1};
    `
      .idempotent(true)
      .isolation('snapshotReadOnly'),
  );
}

async function verifySchemaContext(context: SchemaContext): Promise<void> {
  await verifySubmissionColumns(context);
  await verifyDueIndex(context);
  await verifyQueueHealthIndex(context);
  await verifyRateLimitsSchema(context);
}

async function verifySchemaWithRetry(context: SchemaContext): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await verifySchemaContext(context);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, attempt * 2000));
      }
    }
  }
  throw lastError;
}

function schemaContext(client: YdbClient): SchemaContext {
  return {
    ...client,
    submissionsTable: client.sql.identifier(tableName()),
    rateLimitsTable: client.sql.identifier(rateLimitsTableName()),
    dueIndex: client.sql.identifier(dueIndexName()),
    queueHealthIndex: client.sql.identifier(queueHealthIndexName()),
  };
}

export async function bootstrapSchema(): Promise<void> {
  const client = await createYdbClient();

  try {
    const context = schemaContext(client);
    await createSubmissionsTable(context);
    await createRateLimitsTable(context);
    await verifySchemaContext(context);
  } finally {
    await client.close();
  }
}

export async function verifySchema(): Promise<void> {
  const client = await createYdbClient();

  try {
    await verifySchemaWithRetry(schemaContext(client));
  } finally {
    await client.close();
  }
}

export async function migrateConsentEvidenceSchema(): Promise<void> {
  const client = await createYdbClient();

  try {
    await timed(
      client.sql`
        ALTER TABLE ${client.sql.identifier(tableName())}
        ADD COLUMN consent_json Utf8;
      `.idempotent(true),
    );
    await verifySchemaWithRetry(schemaContext(client));
  } finally {
    await client.close();
  }
}

export const _private = {
  createRateLimitsTable,
  createSubmissionsTable,
  migrateConsentEvidenceSchema,
  schemaContext,
  timed,
  verifyDueIndex,
  verifyQueueHealthIndex,
  verifyRateLimitsSchema,
  verifySchemaContext,
  verifySchemaWithRetry,
  verifySubmissionColumns,
};
