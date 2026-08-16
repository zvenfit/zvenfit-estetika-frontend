import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canApplyConsentEvent,
  normalizeSubscriberPhone,
  persistedSubscriptionStatus,
} from '../../domain/newsletter';

test('normalizes equivalent Russian subscriber phones to one domain identity', () => {
  assert.equal(normalizeSubscriberPhone('+7 (999) 123-45-67'), '+79991234567');
  assert.equal(normalizeSubscriberPhone('8 999 123 45 67'), '+79991234567');
  assert.equal(normalizeSubscriberPhone('9991234567'), '+79991234567');
  assert.throws(() => normalizeSubscriberPhone('123'), /invalid_subscription_phone/);
});

test('consent state is monotonic and unsubscribe wins equal timestamps', () => {
  const current = new Date('2026-08-17T10:00:00.000Z');

  assert.equal(
    canApplyConsentEvent(new Date('2026-08-17T10:00:01.000Z'), current, 'opt_in_confirmed'),
    true,
  );
  assert.equal(
    canApplyConsentEvent(new Date('2026-08-17T09:59:59.000Z'), current, 'unsubscribe'),
    false,
  );
  assert.equal(canApplyConsentEvent(current, current, 'opt_in_confirmed'), false);
  assert.equal(canApplyConsentEvent(current, current, 'unsubscribe'), true);
});

test('unknown persisted subscription status fails closed', () => {
  assert.equal(persistedSubscriptionStatus('active'), 'active');
  assert.equal(persistedSubscriptionStatus('corrupt'), 'unsubscribed');
});
