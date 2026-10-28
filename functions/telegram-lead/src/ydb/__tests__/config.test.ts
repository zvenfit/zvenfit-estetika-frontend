import assert from 'node:assert/strict';
import test from 'node:test';

import {
  leadsTableName,
  newsletterConsentEventsTableName,
  newsletterSubscriptionsTableName,
  normalizeConnectionString,
  queryTimeoutMs,
  rateLimitsTableName,
  schemaTimeoutMs,
  sessionPoolSize,
  telegramOutboxTableName,
} from '../config';

test('validates every bounded-context table identifier', () => {
  process.env.YDB_LEADS_TABLE = 'leads_2026';
  process.env.YDB_NEWSLETTER_SUBSCRIPTIONS_TABLE = 'newsletter_state';
  process.env.YDB_NEWSLETTER_CONSENT_EVENTS_TABLE = 'newsletter_events';
  process.env.YDB_TELEGRAM_OUTBOX_TABLE = 'notifications';
  process.env.YDB_RATE_LIMITS_TABLE = 'form_limits';

  assert.equal(leadsTableName(), 'leads_2026');
  assert.equal(newsletterSubscriptionsTableName(), 'newsletter_state');
  assert.equal(newsletterConsentEventsTableName(), 'newsletter_events');
  assert.equal(telegramOutboxTableName(), 'notifications');
  assert.equal(rateLimitsTableName(), 'form_limits');
  process.env.YDB_LEADS_TABLE = 'bad/table';
  assert.throws(() => leadsTableName(), /invalid_ydb_leads_table_name/);

  delete process.env.YDB_LEADS_TABLE;
  delete process.env.YDB_NEWSLETTER_SUBSCRIPTIONS_TABLE;
  delete process.env.YDB_NEWSLETTER_CONSENT_EVENTS_TABLE;
  delete process.env.YDB_TELEGRAM_OUTBOX_TABLE;
  delete process.env.YDB_RATE_LIMITS_TABLE;
});

test('normalizes Cloud API connection strings and bounds YDB settings', () => {
  assert.equal(
    normalizeConnectionString(
      'grpcs://ydb.serverless.yandexcloud.net:2135/?database=/ru-central1/folder/database',
    ),
    'grpcs://ydb.serverless.yandexcloud.net:2135/ru-central1/folder/database',
  );
  process.env.YDB_QUERY_TIMEOUT_MS = '7000';
  process.env.YDB_SESSION_POOL_SIZE = '1000';
  assert.equal(queryTimeoutMs(), 7000);
  const previousSchemaTimeout = process.env.YDB_SCHEMA_TIMEOUT_MS;
  try {
    delete process.env.YDB_SCHEMA_TIMEOUT_MS;
    assert.equal(schemaTimeoutMs(), 21000);
    process.env.YDB_SCHEMA_TIMEOUT_MS = '45000';
    assert.equal(schemaTimeoutMs(), 45000);
    process.env.YDB_SCHEMA_TIMEOUT_MS = 'invalid';
    assert.equal(schemaTimeoutMs(), 21000);
    assert.equal(queryTimeoutMs(), 7000);
  } finally {
    if (previousSchemaTimeout === undefined) {
      delete process.env.YDB_SCHEMA_TIMEOUT_MS;
    } else {
      process.env.YDB_SCHEMA_TIMEOUT_MS = previousSchemaTimeout;
    }
  }
  assert.equal(sessionPoolSize(), 50);
  delete process.env.YDB_QUERY_TIMEOUT_MS;
  delete process.env.YDB_SESSION_POOL_SIZE;
});
