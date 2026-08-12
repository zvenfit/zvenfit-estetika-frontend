import { createYdbClient } from './client';
import {
  dueIndexName,
  migrationTableName,
  queryTimeoutMs,
  queueHealthIndexName,
  rateLimitsTableName,
  tableName,
} from './config';

import type { YdbClient, YdbQuery } from '../types';

interface MigrationContext extends YdbClient {
  submissionsTable: unknown;
  migrationsTable: unknown;
  rateLimitsTable: unknown;
  dueIndex: unknown;
  queueHealthIndex: unknown;
}

interface Migration {
  version: number;
  name: string;
  apply(context: MigrationContext): Promise<void>;
  verify?(context: MigrationContext): Promise<void>;
}

interface MigrationLogger {
  info?(message: string): void;
}

function timed<T>(query: YdbQuery<T>): YdbQuery<T> {
  return query.timeout(queryTimeoutMs());
}

async function createSubmissionsTable({ sql, submissionsTable }: MigrationContext): Promise<void> {
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

async function createQueueHealthIndex({
  sql,
  submissionsTable,
  queueHealthIndex,
}: MigrationContext): Promise<void> {
  await timed(
    sql`
      ALTER TABLE ${submissionsTable}
      ADD INDEX ${queueHealthIndex} GLOBAL SYNC
        ON (telegram_status, created_at);
    `.idempotent(true),
  );
}

async function createRateLimitsTable({ sql, rateLimitsTable }: MigrationContext): Promise<void> {
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

async function createSubmissionStorage(context: MigrationContext): Promise<void> {
  await createSubmissionsTable(context);
  await createRateLimitsTable(context);
}

async function verifySubmissionColumns({ sql, submissionsTable }: MigrationContext): Promise<void> {
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

async function verifyRateLimitsSchema({ sql, rateLimitsTable }: MigrationContext): Promise<void> {
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

async function validateSubmissionSchema({
  sql,
  submissionsTable,
  dueIndex,
  types,
}: MigrationContext): Promise<void> {
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
}: MigrationContext): Promise<void> {
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

async function verifySubmissionStorage(context: MigrationContext): Promise<void> {
  await verifySubmissionColumns(context);
  await validateSubmissionSchema(context);
  await verifyRateLimitsSchema(context);
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'create_submission_storage',
    apply: createSubmissionStorage,
    verify: verifySubmissionStorage,
  },
  {
    version: 2,
    name: 'add_telegram_queue_health_index',
    apply: createQueueHealthIndex,
    verify: verifyQueueHealthIndex,
  },
];

async function ensureMigrationTable(sql: YdbClient['sql'], migrationsTable: unknown): Promise<void> {
  await timed(
    sql`
      CREATE TABLE IF NOT EXISTS ${migrationsTable} (
        version Uint32 NOT NULL,
        name Utf8 NOT NULL,
        applied_at Timestamp NOT NULL,
        PRIMARY KEY (version)
      );
    `.idempotent(true),
  );
}

async function appliedVersions(sql: YdbClient['sql'], migrationsTable: unknown): Promise<Set<number>> {
  const resultSets = await timed(
    sql`
      SELECT version
      FROM ${migrationsTable}
      ORDER BY version;
    `
      .idempotent(true)
      .isolation('snapshotReadOnly'),
  );

  return new Set((resultSets[0] || []).map(row => Number(row.version)));
}

async function recordMigration({
  sql,
  migrationsTable,
  migration,
  types,
}: MigrationContext & { migration: Migration }): Promise<void> {
  await timed(
    sql`
      UPSERT INTO ${migrationsTable} (version, name, applied_at)
      VALUES (
        ${new types.Uint32(migration.version)},
        ${migration.name},
        ${new types.Timestamp(new Date())}
      );
    `.idempotent(true),
  );
}

async function applyMigration(context: MigrationContext, migration: Migration): Promise<void> {
  try {
    await migration.apply(context);
  } catch (applyError) {
    if (!migration.verify) {
      throw applyError;
    }
    try {
      await migration.verify(context);
    } catch {
      throw applyError;
    }

    return;
  }

  await migration.verify?.(context);
}

function migrationContext(client: YdbClient): MigrationContext {
  return {
    ...client,
    submissionsTable: client.sql.identifier(tableName()),
    migrationsTable: client.sql.identifier(migrationTableName()),
    rateLimitsTable: client.sql.identifier(rateLimitsTableName()),
    dueIndex: client.sql.identifier(dueIndexName()),
    queueHealthIndex: client.sql.identifier(queueHealthIndexName()),
  };
}

export async function runMigrations({ log = console }: { log?: MigrationLogger } = {}): Promise<number[]> {
  const client = await createYdbClient();

  try {
    const context = migrationContext(client);
    await ensureMigrationTable(context.sql, context.migrationsTable);
    const applied = await appliedVersions(context.sql, context.migrationsTable);
    const completed: number[] = [];

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) {
        continue;
      }

      log.info?.(`YDB migration ${migration.version}: ${migration.name}`);
      await applyMigration(context, migration);
      await recordMigration({ ...context, migration });
      completed.push(migration.version);
    }

    await verifySubmissionStorage(context);
    await verifyQueueHealthIndex(context);

    return completed;
  } finally {
    await client.close();
  }
}

export const _private = {
  applyMigration,
  appliedVersions,
  createRateLimitsTable,
  createQueueHealthIndex,
  createSubmissionStorage,
  createSubmissionsTable,
  ensureMigrationTable,
  migrationContext,
  recordMigration,
  timed,
  validateSubmissionSchema,
  verifyRateLimitsSchema,
  verifyQueueHealthIndex,
  verifySubmissionColumns,
  verifySubmissionStorage,
};
