import assert from 'node:assert/strict';
import test from 'node:test';

import { _private, normalizeSubscriberPhone } from '../subscriptions';

test('normalizes equivalent Russian subscriber phones to one key', () => {
  assert.equal(normalizeSubscriberPhone('+7 (999) 123-45-67'), '+79991234567');
  assert.equal(normalizeSubscriberPhone('8 999 123 45 67'), '+79991234567');
  assert.equal(normalizeSubscriberPhone('9991234567'), '+79991234567');
  assert.throws(() => normalizeSubscriberPhone('123'), /invalid_subscription_phone/);
});

test('unknown persisted status fails closed as unsubscribed', () => {
  assert.equal(_private.subscriptionStatus('active'), 'active');
  assert.equal(_private.subscriptionStatus('corrupt'), 'unsubscribed');
});

test('backfill keeps one current subscriber per phone and the latest consent evidence', () => {
  const first = new Date('2026-08-01T10:00:00Z');
  const latest = new Date('2026-08-02T10:00:00Z');
  const result = _private.collectBackfillCandidates([
    {
      submission_id: 'first',
      created_at: first,
      phone: '+7 (999) 123-45-67',
      utm_json: '{"utm_source":"first"}',
      consent_json: '{"version":"v1","personal_data":true,"marketing":true}',
    },
    {
      submission_id: 'latest',
      created_at: latest,
      phone: '8 999 123 45 67',
      utm_json: '{"utm_source":"latest"}',
      consent_json: '{"version":"v2","personal_data":true,"marketing":true}',
    },
    {
      submission_id: 'invalid-consent',
      created_at: latest,
      phone: '+7 999 000-00-00',
      utm_json: '{}',
      consent_json: '{"version":"v2","personal_data":true,"marketing":false}',
    },
  ]);
  const { candidates } = result;

  assert.equal(candidates.size, 1);
  assert.equal(result.deduplicated, 1);
  assert.equal(result.skippedInvalid, 1);
  assert.deepEqual(candidates.get('+79991234567'), {
    phoneNormalized: '+79991234567',
    phone: '8 999 123 45 67',
    firstSubscribedAt: first,
    lastConfirmedAt: latest,
    consentVersion: 'v2',
    lastSubmissionId: 'latest',
    utmJson: '{"utm_source":"latest"}',
  });
});
