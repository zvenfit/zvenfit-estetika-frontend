import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeConnectionString,
  queryTimeoutMs,
  rateLimitsTableName,
  sessionPoolSize,
  tableName,
} from '../config';

test('validates data and rate-limit table identifiers', () => {
  process.env.YDB_SUBMISSIONS_TABLE = 'submissions_2026';
  process.env.YDB_RATE_LIMITS_TABLE = 'submission_limits';
  assert.equal(tableName(), 'submissions_2026');
  assert.equal(rateLimitsTableName(), 'submission_limits');
  process.env.YDB_SUBMISSIONS_TABLE = 'bad/table';
  assert.throws(() => tableName(), /invalid_ydb_table_name/);
  delete process.env.YDB_SUBMISSIONS_TABLE;
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
