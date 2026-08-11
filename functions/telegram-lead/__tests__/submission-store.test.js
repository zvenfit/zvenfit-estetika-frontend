'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { _private } = require('../submission-store');

test('normalizes YDB connection strings returned by the Cloud API', () => {
  assert.equal(
    _private.normalizeConnectionString(
      'grpcs://ydb.serverless.yandexcloud.net:2135/?database=/ru-central1/folder/database',
    ),
    'grpcs://ydb.serverless.yandexcloud.net:2135/ru-central1/folder/database',
  );
});

test('validates the submissions table name', () => {
  const previous = process.env.YDB_SUBMISSIONS_TABLE;

  try {
    process.env.YDB_SUBMISSIONS_TABLE = 'submissions_2026';
    assert.equal(_private.tableName(), 'submissions_2026');
    process.env.YDB_SUBMISSIONS_TABLE = 'bad/table';
    assert.throws(() => _private.tableName(), /invalid_ydb_table_name/);
  } finally {
    if (previous === undefined) {
      delete process.env.YDB_SUBMISSIONS_TABLE;
    } else {
      process.env.YDB_SUBMISSIONS_TABLE = previous;
    }
  }
});

test('maps YDB rows without exposing delivery state in Telegram payloads', () => {
  assert.deepEqual(
    _private.rowToSubmission({
      submission_id: 'submission-1',
      form_type: 'newsletter',
      created_at: new Date('2026-08-09T00:00:00.000Z'),
      name: '',
      phone: '+79688440088',
      service: 'Рассылка',
      telegram_username: '',
      utm_json: '{"utm_source":"test"}',
      telegram_attempts: 2,
      telegram_last_error: 'must-not-leak',
    }),
    {
      submissionId: 'submission-1',
      formType: 'newsletter',
      createdAt: new Date('2026-08-09T00:00:00.000Z'),
      name: '',
      phone: '+79688440088',
      service: 'Рассылка',
      telegramUsername: '',
      utm: { utm_source: 'test' },
      telegramAttempts: 2,
    },
  );
});
