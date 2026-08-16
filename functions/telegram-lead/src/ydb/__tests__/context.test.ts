import assert from 'node:assert/strict';
import test from 'node:test';

import { _private } from '../context';

test('unwraps the first YDB result set', () => {
  assert.deepEqual(_private.firstResultSet([[{ id: 'one' }], [{ id: 'two' }]]), [{ id: 'one' }]);
  assert.deepEqual(_private.firstResultSet(undefined), []);
});

test('maps legacy pending newsletter outbox rows to the safe request notification kind', () => {
  const notification = _private.rowToClaimedNotification({
    notification_id: 'request-id',
    aggregate_id: '+79991234567',
    created_at: new Date('2026-08-17T10:00:00.000Z'),
    kind: 'newsletter_opted_in',
    payload_json: JSON.stringify({ phone: '+79991234567', utm: {} }),
    attempts: 1,
  });

  assert.equal(notification.kind, 'newsletter_subscription_requested');
  assert.equal(notification.notificationId, 'request-id');
});
