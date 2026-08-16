import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { Lead } from '../../../domain/lead';
import {
  normalizeSubscriberPhone,
  type NewsletterOptInRequest,
} from '../../../domain/newsletter';
import type {
  LeadTelegramNotification,
  NewsletterTelegramNotification,
} from '../../../domain/telegram-notification';
import type { YdbSql } from '../../../types';
import { createYdbClient } from '../../client';
import {
  leadsTableName,
  newsletterConsentEventsTableName,
  newsletterSubscriptionsTableName,
  queryTimeoutMs,
  rateLimitsTableName,
  telegramOutboxTableName,
} from '../../config';
import { close, firstResultSet } from '../../context';
import { leadRepository } from '../../lead-repository';
import { newsletterRepository } from '../../newsletter-repository';
import { consumeFormRateLimit } from '../../rate-limit';
import { bootstrapSchema } from '../../schema';
import * as outbox from '../../telegram-outbox';

const TEST_CONNECTION_STRING = process.env.YDB_TEST_CONNECTION_STRING;

function lead(requestId: string, occurredAt: Date): Lead {
  return {
    requestId,
    occurredAt,
    name: 'Анна Смирнова',
    phone: '+7 (968) 844-00-88',
    contactMethod: 'WhatsApp',
    telegramUsername: '',
    utm: { utm_source: 'integration' },
    consents: { version: '2026-08-14-v2', personalData: true, marketing: false },
  };
}

function leadNotification(value: Lead): LeadTelegramNotification {
  return {
    notificationId: value.requestId,
    kind: 'lead_created',
    aggregateId: value.requestId,
    createdAt: value.occurredAt,
    name: value.name,
    phone: value.phone,
    contactMethod: value.contactMethod,
    telegramUsername: value.telegramUsername,
    utm: value.utm,
  };
}

function optInRequest(
  requestId: string,
  occurredAt: Date,
  phone = '+7 (999) 123-45-67',
): NewsletterOptInRequest {
  return {
    requestId,
    occurredAt,
    phone,
    phoneNormalized: normalizeSubscriberPhone(phone),
    utm: { utm_source: 'integration' },
    consents: { version: '2026-08-14-v2', personalData: true, marketing: true },
  };
}

function newsletterNotification(value: NewsletterOptInRequest): NewsletterTelegramNotification {
  return {
    notificationId: value.requestId,
    kind: 'newsletter_subscription_requested',
    aggregateId: value.requestId,
    createdAt: value.occurredAt,
    phone: value.phone,
    utm: value.utm,
  };
}

async function dropTable(sql: YdbSql, name: string): Promise<void> {
  try {
    await sql`DROP TABLE ${sql.identifier(name)};`.timeout(queryTimeoutMs());
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!message.includes('NOT_FOUND')) {
      throw error;
    }
  }
}

test(
  'greenfield domain repositories and transactional outbox work together',
  { skip: !TEST_CONNECTION_STRING },
  async () => {
    if (!TEST_CONNECTION_STRING) {
      return;
    }

    const previous = {
      connectionString: process.env.YDB_CONNECTION_STRING,
      leads: process.env.YDB_LEADS_TABLE,
      subscriptions: process.env.YDB_NEWSLETTER_SUBSCRIPTIONS_TABLE,
      consentEvents: process.env.YDB_NEWSLETTER_CONSENT_EVENTS_TABLE,
      outbox: process.env.YDB_TELEGRAM_OUTBOX_TABLE,
      rateLimits: process.env.YDB_RATE_LIMITS_TABLE,
      rateLimitSecret: process.env.LEAD_RATE_LIMIT_SECRET,
    };
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    process.env.YDB_CONNECTION_STRING = TEST_CONNECTION_STRING;
    process.env.YDB_LEADS_TABLE = `leads_it_${suffix}`;
    process.env.YDB_NEWSLETTER_SUBSCRIPTIONS_TABLE = `newsletter_state_it_${suffix}`;
    process.env.YDB_NEWSLETTER_CONSENT_EVENTS_TABLE = `newsletter_events_it_${suffix}`;
    process.env.YDB_TELEGRAM_OUTBOX_TABLE = `outbox_it_${suffix}`;
    process.env.YDB_RATE_LIMITS_TABLE = `limits_it_${suffix}`;
    process.env.LEAD_RATE_LIMIT_SECRET = 'integration-test-secret-not-production-32';

    try {
      await bootstrapSchema();
      await bootstrapSchema();

      const rateLimitResults = await Promise.all(
        Array.from({ length: 10 }, () =>
          consumeFormRateLimit({ sourceIp: '203.0.113.10', now: new Date() }),
        ),
      );
      assert.equal(rateLimitResults.filter(Boolean).length, 5);

      const now = new Date();
      const newLead = lead(randomUUID(), now);
      const savedLeads = await Promise.all([
        leadRepository.recordLead(newLead, leadNotification(newLead)),
        leadRepository.recordLead(newLead, leadNotification(newLead)),
      ]);
      assert.deepEqual(savedLeads.map(result => result.created).sort(), [false, true]);
      assert.deepEqual(await outbox.listCandidates({ now, limit: 10 }), [newLead.requestId]);

      const deliveryToken = randomUUID();
      const claimed = await outbox.claim({
        notificationId: newLead.requestId,
        now,
        leaseUntil: new Date(now.getTime() + 60_000),
        deliveryToken,
      });
      assert.equal(claimed?.kind, 'lead_created');
      assert.equal(claimed?.attempts, 1);
      await outbox.markDelivered({
        notificationId: newLead.requestId,
        deliveryToken,
        deliveredAt: now,
      });
      assert.deepEqual(await leadRepository.recordLead(newLead, leadNotification(newLead)), {
        created: false,
        notificationStatus: 'sent',
      });

      const firstRequest = optInRequest(randomUUID(), new Date(now.getTime() + 60_000));
      const firstResults = await Promise.all([
        newsletterRepository.recordOptInRequest(
          firstRequest,
          newsletterNotification(firstRequest),
        ),
        newsletterRepository.recordOptInRequest(
          firstRequest,
          newsletterNotification(firstRequest),
        ),
      ]);
      assert.deepEqual(firstResults.map(result => result.created).sort(), [false, true]);
      assert.equal(
        await newsletterRepository.getSubscription({ phone: '8 999 123 45 67' }),
        null,
      );
      assert.equal(await newsletterRepository.isSuppressed({ phone: firstRequest.phone }), true);

      const firstConfirmationId = randomUUID();
      const firstConfirmedAt = new Date(now.getTime() + 90_000);
      assert.deepEqual(
        await newsletterRepository.confirmOptIn({
          eventId: firstConfirmationId,
          requestEventId: firstRequest.requestId,
          occurredAt: firstConfirmedAt,
          proofReference: 'provider-proof-first',
        }),
        { eventCreated: true, stateChanged: true },
      );
      assert.deepEqual(
        await newsletterRepository.confirmOptIn({
          eventId: firstConfirmationId,
          requestEventId: firstRequest.requestId,
          occurredAt: firstConfirmedAt,
          proofReference: 'provider-proof-first',
        }),
        { eventCreated: false, stateChanged: false },
      );
      const firstSubscription = await newsletterRepository.getSubscription({
        phone: firstRequest.phone,
      });
      assert.equal(firstSubscription?.status, 'active');
      assert.equal(firstSubscription?.firstSubscribedAt.getTime(), firstRequest.occurredAt.getTime());
      assert.equal(firstSubscription?.subscribedAt.getTime(), firstConfirmedAt.getTime());
      assert.equal(firstSubscription?.lastConsentEventId, firstConfirmationId);
      assert.equal(await newsletterRepository.isSuppressed({ phone: firstRequest.phone }), false);

      const secondRequest = optInRequest(randomUUID(), new Date(now.getTime() + 120_000));
      await newsletterRepository.recordOptInRequest(
        secondRequest,
        newsletterNotification(secondRequest),
      );
      const afterPublicRequest = await newsletterRepository.getSubscription({
        phone: secondRequest.phone,
      });
      assert.equal(afterPublicRequest?.lastConfirmedAt.getTime(), firstConfirmedAt.getTime());

      const secondConfirmationId = randomUUID();
      const secondConfirmedAt = new Date(now.getTime() + 150_000);
      await assert.rejects(
        newsletterRepository.confirmOptIn({
          eventId: secondConfirmationId,
          requestEventId: secondRequest.requestId,
          occurredAt: secondConfirmedAt,
          proofReference: '   ',
        }),
        /newsletter_confirmation_proof_missing/,
      );
      await newsletterRepository.confirmOptIn({
        eventId: secondConfirmationId,
        requestEventId: secondRequest.requestId,
        occurredAt: secondConfirmedAt,
        proofReference: 'provider-proof-second',
      });
      const afterReconfirm = await newsletterRepository.getSubscription({
        phone: secondRequest.phone,
      });
      assert.equal(afterReconfirm?.firstSubscribedAt.getTime(), firstRequest.occurredAt.getTime());
      assert.equal(afterReconfirm?.subscribedAt.getTime(), firstConfirmedAt.getTime());
      assert.equal(afterReconfirm?.lastConfirmedAt.getTime(), secondConfirmedAt.getTime());

      const unsubscribeEventId = randomUUID();
      const unsubscribedAt = new Date(now.getTime() + 180_000);
      assert.deepEqual(
        await newsletterRepository.unsubscribe({
          eventId: unsubscribeEventId,
          phone: secondRequest.phone,
          occurredAt: unsubscribedAt,
          reason: 'subscriber_request',
        }),
        { eventCreated: true, stateChanged: true },
      );
      assert.equal(await newsletterRepository.isSuppressed({ phone: secondRequest.phone }), true);
      assert.deepEqual(
        await newsletterRepository.unsubscribe({
          eventId: unsubscribeEventId,
          phone: secondRequest.phone,
          occurredAt: unsubscribedAt,
          reason: 'subscriber_request',
        }),
        { eventCreated: false, stateChanged: false },
      );

      const resubscribeRequest = optInRequest(randomUUID(), new Date(now.getTime() + 240_000));
      await newsletterRepository.recordOptInRequest(
        resubscribeRequest,
        newsletterNotification(resubscribeRequest),
      );
      const stillUnsubscribed = await newsletterRepository.getSubscription({
        phone: resubscribeRequest.phone,
      });
      assert.equal(stillUnsubscribed?.status, 'unsubscribed');
      assert.equal(stillUnsubscribed?.lastConsentEventId, unsubscribeEventId);
      assert.equal(await newsletterRepository.isSuppressed({ phone: resubscribeRequest.phone }), true);

      const delayedUnsubscribeId = randomUUID();
      assert.deepEqual(
        await newsletterRepository.unsubscribe({
          eventId: delayedUnsubscribeId,
          phone: resubscribeRequest.phone,
          occurredAt: new Date(now.getTime() + 170_000),
          reason: 'delayed_provider_event',
        }),
        { eventCreated: true, stateChanged: false },
      );

      const resubscribeConfirmationId = randomUUID();
      const resubscribedAt = new Date(now.getTime() + 300_000);
      await newsletterRepository.confirmOptIn({
        eventId: resubscribeConfirmationId,
        requestEventId: resubscribeRequest.requestId,
        occurredAt: resubscribedAt,
        proofReference: 'provider-proof-resubscribe',
      });
      const resubscribed = await newsletterRepository.getSubscription({
        phone: resubscribeRequest.phone,
      });
      assert.equal(resubscribed?.status, 'active');
      assert.equal(resubscribed?.subscribedAt.getTime(), resubscribedAt.getTime());
      assert.equal(resubscribed?.unsubscribedAt, null);

      assert.deepEqual(
        await newsletterRepository.unsubscribe({
          eventId: randomUUID(),
          phone: resubscribeRequest.phone,
          occurredAt: new Date(now.getTime() + 250_000),
          reason: 'late_old_unsubscribe',
        }),
        { eventCreated: true, stateChanged: false },
      );
      assert.equal(
        (await newsletterRepository.getSubscription({ phone: resubscribeRequest.phone }))?.status,
        'active',
      );

      const tombstonePhone = '+7 (999) 765-43-21';
      const tombstoneEventId = randomUUID();
      assert.deepEqual(
        await newsletterRepository.unsubscribe({
          eventId: tombstoneEventId,
          phone: tombstonePhone,
          occurredAt: new Date(now.getTime() + 400_000),
          reason: 'provider_suppression',
        }),
        { eventCreated: true, stateChanged: true },
      );
      const tombstoneRequest = optInRequest(
        randomUUID(),
        new Date(now.getTime() + 410_000),
        tombstonePhone,
      );
      await newsletterRepository.recordOptInRequest(
        tombstoneRequest,
        newsletterNotification(tombstoneRequest),
      );
      assert.equal(
        (await newsletterRepository.getSubscription({ phone: tombstonePhone }))?.status,
        'unsubscribed',
      );
      const tombstoneConfirmationId = randomUUID();
      await newsletterRepository.confirmOptIn({
        eventId: tombstoneConfirmationId,
        requestEventId: tombstoneRequest.requestId,
        occurredAt: new Date(now.getTime() + 420_000),
        proofReference: 'provider-proof-tombstone',
      });
      assert.deepEqual(
        await newsletterRepository.unsubscribe({
          eventId: tombstoneEventId,
          phone: tombstonePhone,
          occurredAt: new Date(now.getTime() + 400_000),
          reason: 'provider_suppression',
        }),
        { eventCreated: false, stateChanged: false },
      );
      assert.equal(
        (await newsletterRepository.getSubscription({ phone: tombstonePhone }))?.status,
        'active',
      );
      assert.equal(await newsletterRepository.isSuppressed({ phone: 'invalid' }), true);

      const terminalDeliveryToken = randomUUID();
      const terminalClaimedAt = new Date(now.getTime() + 500_000);
      const terminalNotification = await outbox.claim({
        notificationId: tombstoneRequest.requestId,
        now: terminalClaimedAt,
        leaseUntil: new Date(terminalClaimedAt.getTime() + 60_000),
        deliveryToken: terminalDeliveryToken,
      });
      assert.equal(terminalNotification?.kind, 'newsletter_subscription_requested');
      await outbox.markFailed({
        notificationId: tombstoneRequest.requestId,
        deliveryToken: terminalDeliveryToken,
        failedAt: terminalClaimedAt,
        errorCode: 'terminal_test_failure',
        terminal: true,
      });

      const client = await createYdbClient();
      try {
        const leadRows = firstResultSet(
          await client.sql`SELECT COUNT(*) AS row_count FROM ${client.sql.identifier(leadsTableName())};`
            .timeout(queryTimeoutMs())
            .idempotent(true)
            .isolation('snapshotReadOnly'),
        );
        const consentRows = firstResultSet(
          await client.sql`SELECT COUNT(*) AS row_count FROM ${client.sql.identifier(newsletterConsentEventsTableName())};`
            .timeout(queryTimeoutMs())
            .idempotent(true)
            .isolation('snapshotReadOnly'),
        );
        const deliveredOutboxRows = firstResultSet(
          await client.sql`
            SELECT aggregate_id, payload_json, status
            FROM ${client.sql.identifier(telegramOutboxTableName())}
            WHERE notification_id = ${newLead.requestId};
          `
            .timeout(queryTimeoutMs())
            .idempotent(true)
            .isolation('snapshotReadOnly'),
        );
        const failedOutboxRows = firstResultSet(
          await client.sql`
            SELECT aggregate_id, payload_json, status
            FROM ${client.sql.identifier(telegramOutboxTableName())}
            WHERE notification_id = ${tombstoneRequest.requestId};
          `
            .timeout(queryTimeoutMs())
            .idempotent(true)
            .isolation('snapshotReadOnly'),
        );
        const confirmationRows = firstResultSet(
          await client.sql`
            SELECT reason
            FROM ${client.sql.identifier(newsletterConsentEventsTableName())}
            WHERE event_id = ${firstConfirmationId};
          `
            .timeout(queryTimeoutMs())
            .idempotent(true)
            .isolation('snapshotReadOnly'),
        );
        assert.equal(Number(leadRows[0]?.row_count), 1);
        assert.equal(Number(consentRows[0]?.row_count), 12);
        assert.deepEqual(deliveredOutboxRows[0], {
          aggregate_id: newLead.requestId,
          payload_json: '{}',
          status: 'sent',
        });
        assert.deepEqual(failedOutboxRows[0], {
          aggregate_id: tombstoneRequest.requestId,
          payload_json: '{}',
          status: 'failed',
        });
        assert.match(
          String(confirmationRows[0]?.reason),
          new RegExp(`^confirmed:${firstRequest.requestId}:[a-f0-9]{64}$`),
        );
        assert.doesNotMatch(String(confirmationRows[0]?.reason), /provider-proof-first/);
      } finally {
        await client.close();
      }
    } finally {
      await close();
      const client = await createYdbClient();
      await dropTable(client.sql, telegramOutboxTableName());
      await dropTable(client.sql, newsletterConsentEventsTableName());
      await dropTable(client.sql, newsletterSubscriptionsTableName());
      await dropTable(client.sql, leadsTableName());
      await dropTable(client.sql, rateLimitsTableName());
      await client.close();

      for (const [name, value] of Object.entries({
        YDB_CONNECTION_STRING: previous.connectionString,
        YDB_LEADS_TABLE: previous.leads,
        YDB_NEWSLETTER_SUBSCRIPTIONS_TABLE: previous.subscriptions,
        YDB_NEWSLETTER_CONSENT_EVENTS_TABLE: previous.consentEvents,
        YDB_TELEGRAM_OUTBOX_TABLE: previous.outbox,
        YDB_RATE_LIMITS_TABLE: previous.rateLimits,
        LEAD_RATE_LIMIT_SECRET: previous.rateLimitSecret,
      })) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  },
);
