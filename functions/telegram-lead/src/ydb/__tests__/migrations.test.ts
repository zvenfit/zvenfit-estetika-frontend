import assert from 'node:assert/strict';
import test from 'node:test';

import { MIGRATIONS, _private } from '../migrations';

test('submission schema migrations are ordered, unique and append-only', () => {
  assert.deepEqual(
    MIGRATIONS.map(migration => [migration.version, migration.name]),
    [
      [1, 'create_submission_storage'],
      [2, 'add_telegram_queue_health_index'],
    ],
  );
  assert.equal(new Set(MIGRATIONS.map(migration => migration.version)).size, MIGRATIONS.length);
});

test('submissions never expire while technical rate-limit counters do', () => {
  const submissionsSchema = _private.createSubmissionsTable.toString();
  const rateLimitsSchema = _private.createRateLimitsTable.toString();

  assert.doesNotMatch(submissionsSchema, /\bexpires_at\b/);
  assert.doesNotMatch(submissionsSchema, /\bTTL\b/);
  assert.match(submissionsSchema, /GLOBAL SYNC/);
  assert.match(submissionsSchema, /idx_telegram_status_created/);
  assert.match(rateLimitsSchema, /\bexpires_at\b/);
  assert.match(rateLimitsSchema, /\bTTL\b/);
});

test('queue-health migration creates and verifies an indexed status/created-at query', () => {
  assert.match(_private.createQueueHealthIndex.toString(), /ADD INDEX/);
  assert.match(_private.createQueueHealthIndex.toString(), /telegram_status, created_at/);
  assert.match(_private.verifyQueueHealthIndex.toString(), /VIEW/);
});
