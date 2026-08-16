import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeSubscriberPhone,
  persistedSubscriptionStatus,
} from '../../domain/newsletter';

test('normalizes equivalent Russian subscriber phones to one domain identity', () => {
  assert.equal(normalizeSubscriberPhone('+7 (999) 123-45-67'), '+79991234567');
  assert.equal(normalizeSubscriberPhone('8 999 123 45 67'), '+79991234567');
  assert.equal(normalizeSubscriberPhone('9991234567'), '+79991234567');
  assert.throws(() => normalizeSubscriberPhone('123'), /invalid_subscription_phone/);
});

test('unknown persisted subscription status fails closed', () => {
  assert.equal(persistedSubscriptionStatus('active'), 'active');
  assert.equal(persistedSubscriptionStatus('corrupt'), 'unsubscribed');
});
