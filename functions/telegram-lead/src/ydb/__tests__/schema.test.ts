import assert from 'node:assert/strict';
import test from 'node:test';

import { _private } from '../schema';

test('pilot bootstrap creates the complete submissions and rate-limit schema', () => {
  const submissionsSchema = _private.createSubmissionsTable.toString();
  const rateLimitsSchema = _private.createRateLimitsTable.toString();

  assert.doesNotMatch(submissionsSchema, /\bexpires_at\b/);
  assert.doesNotMatch(submissionsSchema, /\bTTL\b/);
  assert.match(submissionsSchema, /idx_telegram_due/);
  assert.match(submissionsSchema, /idx_telegram_status_created/);
  assert.match(submissionsSchema, /GLOBAL SYNC/);
  assert.match(rateLimitsSchema, /\bexpires_at\b/);
  assert.match(rateLimitsSchema, /\bTTL\b/);
});

test('production verification checks both queue indexes without changing schema', () => {
  assert.match(_private.verifyDueIndex.toString(), /VIEW/);
  assert.match(_private.verifyQueueHealthIndex.toString(), /VIEW/);
  assert.doesNotMatch(_private.verifySchemaContext.toString(), /CREATE|ALTER|DROP/);
});
