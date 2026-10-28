import assert from 'node:assert/strict';
import test from 'node:test';

import type { YdbClient } from '../../types';
import { queryTimeoutMs, schemaTimeoutMs } from '../config';
import { _private } from '../schema';

test('table creation has its own timeout while schema verification keeps the query budget', async () => {
  const { Timestamp, Uint32 } = await import('@ydbjs/value/primitive');
  const calls: Array<{ operation: string; timeout: number }> = [];
  const sql = Object.assign((strings: TemplateStringsArray) => {
    const operation = strings.join('').trim().split(/\s+/)[0];
    assert.ok(operation);
    return Object.assign(Promise.resolve([]), {
      idempotent() { return this; },
      isolation() { return this; },
      timeout(milliseconds: number) {
        calls.push({ operation, timeout: milliseconds });
        return this;
      },
    });
  }, { identifier: (name: string) => name });
  const context = _private.schemaContext({ sql, types: { Timestamp, Uint32 } } as unknown as YdbClient);

  for (const create of [
    _private.createLeadsTable,
    _private.createNewsletterSubscriptionsTable,
    _private.createNewsletterConsentEventsTable,
    _private.createTelegramOutboxTable,
    _private.createRateLimitsTable,
  ]) {
    await create(context);
  }
  await _private.verifySchemaContext(context);

  assert.deepEqual(calls, [
    ...Array.from({ length: 5 }, () => ({ operation: 'CREATE', timeout: schemaTimeoutMs() })),
    ...Array.from({ length: 7 }, () => ({ operation: 'SELECT', timeout: queryTimeoutMs() })),
  ]);
});

test('greenfield schema separates business domains, consent history and delivery', () => {
  const leads = _private.createLeadsTable.toString();
  const subscriptions = _private.createNewsletterSubscriptionsTable.toString();
  const consentEvents = _private.createNewsletterConsentEventsTable.toString();
  const outbox = _private.createTelegramOutboxTable.toString();
  const rateLimits = _private.createRateLimitsTable.toString();

  assert.match(leads, /PRIMARY KEY \(lead_id\)/);
  assert.match(leads, /contact_method Utf8 NOT NULL/);
  assert.doesNotMatch(leads, /telegram_status|due_at|\bTTL\b/);

  assert.match(subscriptions, /PRIMARY KEY \(phone_normalized\)/);
  assert.match(subscriptions, /status Utf8 NOT NULL/);
  assert.match(subscriptions, /unsubscribed_at Timestamp/);
  assert.match(subscriptions, /last_consent_event_id Utf8 NOT NULL/);
  assert.doesNotMatch(subscriptions, /telegram_|\bTTL\b/);

  assert.match(consentEvents, /PRIMARY KEY \(event_id\)/);
  assert.match(consentEvents, /event_type Utf8 NOT NULL/);
  assert.match(consentEvents, /marketing_consent Bool NOT NULL/);
  assert.doesNotMatch(consentEvents, /telegram_|\bTTL\b/);

  assert.match(outbox, /PRIMARY KEY \(notification_id\)/);
  assert.match(outbox, /payload_json Utf8 NOT NULL/);
  assert.match(outbox, /idx_telegram_outbox_due/);
  assert.match(outbox, /idx_telegram_outbox_status_created/);
  assert.match(outbox, /GLOBAL SYNC/);

  assert.match(rateLimits, /\bexpires_at\b/);
  assert.match(rateLimits, /\bTTL\b/);
});

test('production verification is read-only and checks both outbox indexes', () => {
  assert.match(_private.verifyDueIndex.toString(), /VIEW/);
  assert.match(_private.verifyQueueHealthIndex.toString(), /VIEW/);
  assert.match(_private.verifyLeadsSchema.toString(), /lead_id/);
  assert.match(_private.verifyNewsletterSubscriptionsSchema.toString(), /phone_normalized/);
  assert.match(_private.verifyNewsletterConsentEventsSchema.toString(), /event_type/);
  assert.match(_private.verifyTelegramOutboxSchema.toString(), /notification_id/);
  assert.doesNotMatch(_private.verifySchemaContext.toString(), /CREATE|ALTER|DROP/);
});

test('schema module contains no legacy migration or polymorphic submissions table', () => {
  const source = Object.values(_private)
    .map(value => value.toString())
    .join('\n');

  assert.doesNotMatch(source, /ALTER TABLE|migrate|form_type|submission_id/);
});
