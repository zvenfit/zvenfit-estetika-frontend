import assert from 'node:assert/strict';
import test from 'node:test';

import {
  leadsTableName,
  newsletterConsentEventsTableName,
  newsletterSubscriptionsTableName,
  normalizeConnectionString,
  queryTimeoutMs,
  rateLimitsTableName,
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
  assert.equal(sessionPoolSize(), 50);
  delete process.env.YDB_QUERY_TIMEOUT_MS;
  delete process.env.YDB_SESSION_POOL_SIZE;
});
