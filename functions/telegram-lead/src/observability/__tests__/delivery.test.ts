import assert from 'node:assert/strict';
import test from 'node:test';

import { logDeliveryFailure } from '../delivery';

import type { JsonObject, LoggerLike } from '../../types';

test('logs outbox notification kind without exposing the notification payload', () => {
  const records: JsonObject[] = [];
  const logger: LoggerLike = {
    error(fields) {
      records.push(fields);
    },
  };

  logDeliveryFailure(
    logger,
    'telegram_delivery_retry_scheduled',
    'notification-id',
    Object.assign(new Error('private phone +79990000000'), { code: 'telegram_timeout' }),
    {
      attempts: 2,
      fallbackCode: 'telegram_timeout',
      notificationKind: 'newsletter_subscription_requested',
      retriable: true,
    },
  );

  assert.equal(records[0]?.notification_id, 'notification-id');
  assert.equal(records[0]?.notification_kind, 'newsletter_subscription_requested');
  assert.equal(records[0]?.attempts, 2);
  assert.equal(records[0]?.error_code, 'telegram_timeout');
  assert.doesNotMatch(JSON.stringify(records), /private phone|79990000000/);
});
