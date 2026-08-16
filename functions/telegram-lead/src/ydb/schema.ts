import { createYdbClient } from './client';
import {
  dueIndexName,
  leadsTableName,
  newsletterConsentEventsTableName,
  newsletterSubscriptionsTableName,
  queryTimeoutMs,
  queueHealthIndexName,
  rateLimitsTableName,
  telegramOutboxTableName,
} from './config';

import type { YdbClient, YdbQuery } from '../types';

interface SchemaContext extends YdbClient {
  leadsTable: unknown;
  newsletterSubscriptionsTable: unknown;
  newsletterConsentEventsTable: unknown;
  telegramOutboxTable: unknown;
  rateLimitsTable: unknown;
  dueIndex: unknown;
  queueHealthIndex: unknown;
}

function timed<T>(query: YdbQuery<T>): YdbQuery<T> {
  return query.timeout(queryTimeoutMs());
}

async function createLeadsTable({ sql, leadsTable }: SchemaContext): Promise<void> {
  await timed(
    sql`
      CREATE TABLE IF NOT EXISTS ${leadsTable} (
        lead_id Utf8 NOT NULL,
        created_at Timestamp NOT NULL,
        name Utf8 NOT NULL,
        phone Utf8 NOT NULL,
        contact_method Utf8 NOT NULL,
        telegram_username Utf8 NOT NULL,
        utm_json Utf8 NOT NULL,
        consent_version Utf8 NOT NULL,
        personal_data_consent Bool NOT NULL,
        marketing_consent Bool NOT NULL,
        PRIMARY KEY (lead_id)
      );
    `.idempotent(true),
  );
}

async function createNewsletterSubscriptionsTable({
  sql,
  newsletterSubscriptionsTable,
}: SchemaContext): Promise<void> {
  await timed(
    sql`
      CREATE TABLE IF NOT EXISTS ${newsletterSubscriptionsTable} (
        phone_normalized Utf8 NOT NULL,
        phone Utf8 NOT NULL,
        status Utf8 NOT NULL,
        first_subscribed_at Timestamp NOT NULL,
        subscribed_at Timestamp NOT NULL,
        last_confirmed_at Timestamp NOT NULL,
        unsubscribed_at Timestamp,
        updated_at Timestamp NOT NULL,
        consent_version Utf8 NOT NULL,
        personal_data_consent Bool NOT NULL,
        marketing_consent Bool NOT NULL,
        last_consent_event_id Utf8 NOT NULL,
        utm_json Utf8 NOT NULL,
        unsubscribe_reason Utf8 NOT NULL,
        PRIMARY KEY (phone_normalized)
      );
    `.idempotent(true),
  );
}

async function createNewsletterConsentEventsTable({
  sql,
  newsletterConsentEventsTable,
}: SchemaContext): Promise<void> {
  await timed(
    sql`
      CREATE TABLE IF NOT EXISTS ${newsletterConsentEventsTable} (
        event_id Utf8 NOT NULL,
        phone_normalized Utf8 NOT NULL,
        phone Utf8 NOT NULL,
        event_type Utf8 NOT NULL,
        occurred_at Timestamp NOT NULL,
        consent_version Utf8 NOT NULL,
        personal_data_consent Bool NOT NULL,
        marketing_consent Bool NOT NULL,
        utm_json Utf8 NOT NULL,
        reason Utf8 NOT NULL,
        PRIMARY KEY (event_id)
      );
    `.idempotent(true),
  );
}

async function createTelegramOutboxTable({
  sql,
  telegramOutboxTable,
}: SchemaContext): Promise<void> {
  await timed(
    sql`
      CREATE TABLE IF NOT EXISTS ${telegramOutboxTable} (
        notification_id Utf8 NOT NULL,
        kind Utf8 NOT NULL,
        aggregate_id Utf8 NOT NULL,
        created_at Timestamp NOT NULL,
        payload_json Utf8 NOT NULL,
        status Utf8 NOT NULL,
        attempts Uint32 NOT NULL,
        due_at Timestamp,
        delivery_token Utf8,
        last_error Utf8,
        delivered_at Timestamp,
        INDEX idx_telegram_outbox_due GLOBAL SYNC
          ON (due_at, created_at)
          COVER (status),
        INDEX idx_telegram_outbox_status_created GLOBAL SYNC
          ON (status, created_at),
        PRIMARY KEY (notification_id)
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

async function verifyLeadsSchema({ sql, leadsTable }: SchemaContext): Promise<void> {
  await timed(
    sql`
      SELECT
        lead_id,
        created_at,
        name,
        phone,
        contact_method,
        telegram_username,
        utm_json,
        consent_version,
        personal_data_consent,
        marketing_consent
      FROM ${leadsTable}
      LIMIT ${0};
    `
      .idempotent(true)
      .isolation('snapshotReadOnly'),
  );
}

async function verifyNewsletterSubscriptionsSchema({
  sql,
  newsletterSubscriptionsTable,
}: SchemaContext): Promise<void> {
  await timed(
    sql`
      SELECT
        phone_normalized,
        phone,
        status,
        first_subscribed_at,
        subscribed_at,
        last_confirmed_at,
        unsubscribed_at,
        updated_at,
        consent_version,
        personal_data_consent,
        marketing_consent,
        last_consent_event_id,
        utm_json,
        unsubscribe_reason
      FROM ${newsletterSubscriptionsTable}
      LIMIT ${0};
    `
      .idempotent(true)
      .isolation('snapshotReadOnly'),
  );
}

async function verifyNewsletterConsentEventsSchema({
  sql,
  newsletterConsentEventsTable,
}: SchemaContext): Promise<void> {
  await timed(
    sql`
      SELECT
        event_id,
        phone_normalized,
        phone,
        event_type,
        occurred_at,
        consent_version,
        personal_data_consent,
        marketing_consent,
        utm_json,
        reason
      FROM ${newsletterConsentEventsTable}
      LIMIT ${0};
    `
      .idempotent(true)
      .isolation('snapshotReadOnly'),
  );
}

async function verifyTelegramOutboxSchema({
  sql,
  telegramOutboxTable,
}: SchemaContext): Promise<void> {
  await timed(
    sql`
      SELECT
        notification_id,
        kind,
        aggregate_id,
        created_at,
        payload_json,
        status,
        attempts,
        due_at,
        delivery_token,
        last_error,
        delivered_at
      FROM ${telegramOutboxTable}
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

async function verifyDueIndex({
  sql,
  telegramOutboxTable,
  dueIndex,
  types,
}: SchemaContext): Promise<void> {
  await timed(
    sql`
      SELECT notification_id
      FROM ${telegramOutboxTable} VIEW ${dueIndex}
      WHERE
        due_at <= ${new types.Timestamp(new Date())}
        AND (status = ${'pending'} OR status = ${'sending'})
      ORDER BY due_at, created_at, notification_id
      LIMIT ${1};
    `
      .idempotent(true)
      .isolation('snapshotReadOnly'),
  );
}

async function verifyQueueHealthIndex({
  sql,
  telegramOutboxTable,
  queueHealthIndex,
}: SchemaContext): Promise<void> {
  await timed(
    sql`
      SELECT created_at
      FROM ${telegramOutboxTable} VIEW ${queueHealthIndex}
      WHERE status = ${'pending'} OR status = ${'sending'}
      ORDER BY status, created_at
      LIMIT ${1};
    `
      .idempotent(true)
      .isolation('snapshotReadOnly'),
  );
}

async function verifySchemaContext(context: SchemaContext): Promise<void> {
  await verifyLeadsSchema(context);
  await verifyNewsletterSubscriptionsSchema(context);
  await verifyNewsletterConsentEventsSchema(context);
  await verifyTelegramOutboxSchema(context);
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
    leadsTable: client.sql.identifier(leadsTableName()),
    newsletterSubscriptionsTable: client.sql.identifier(newsletterSubscriptionsTableName()),
    newsletterConsentEventsTable: client.sql.identifier(newsletterConsentEventsTableName()),
    telegramOutboxTable: client.sql.identifier(telegramOutboxTableName()),
    rateLimitsTable: client.sql.identifier(rateLimitsTableName()),
    dueIndex: client.sql.identifier(dueIndexName()),
    queueHealthIndex: client.sql.identifier(queueHealthIndexName()),
  };
}

export async function bootstrapSchema(): Promise<void> {
  const client = await createYdbClient();

  try {
    const context = schemaContext(client);
    await createLeadsTable(context);
    await createNewsletterSubscriptionsTable(context);
    await createNewsletterConsentEventsTable(context);
    await createTelegramOutboxTable(context);
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

export const _private = {
  createLeadsTable,
  createNewsletterConsentEventsTable,
  createNewsletterSubscriptionsTable,
  createRateLimitsTable,
  createTelegramOutboxTable,
  schemaContext,
  timed,
  verifyDueIndex,
  verifyLeadsSchema,
  verifyNewsletterConsentEventsSchema,
  verifyNewsletterSubscriptionsSchema,
  verifyQueueHealthIndex,
  verifyRateLimitsSchema,
  verifySchemaContext,
  verifySchemaWithRetry,
  verifyTelegramOutboxSchema,
};
