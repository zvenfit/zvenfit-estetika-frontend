import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { Lead } from '../../../domain/lead';
import { normalizeSubscriberPhone, type NewsletterOptIn } from '../../../domain/newsletter';
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

function optIn(requestId: string, occurredAt: Date, phone = '+7 (999) 123-45-67'): NewsletterOptIn {
  return {
    requestId,
    occurredAt,
    phone,
    phoneNormalized: normalizeSubscriberPhone(phone),
    utm: { utm_source: 'integration' },
    consents: { version: '2026-08-14-v2', personalData: true, marketing: true },
  };
}

function newsletterNotification(value: NewsletterOptIn): NewsletterTelegramNotification {
  return {
    notificationId: value.requestId,
    kind: 'newsletter_opted_in',
    aggregateId: value.phoneNormalized,
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

      const firstOptIn = optIn(randomUUID(), new Date(now.getTime() + 60_000));
      const firstResults = await Promise.all([
        newsletterRepository.recordOptIn(firstOptIn, newsletterNotification(firstOptIn)),
        newsletterRepository.recordOptIn(firstOptIn, newsletterNotification(firstOptIn)),
      ]);
      assert.deepEqual(firstResults.map(result => result.created).sort(), [false, true]);
      const firstSubscription = await newsletterRepository.getSubscription({
        phone: '8 999 123 45 67',
      });
      assert.equal(firstSubscription?.status, 'active');
      assert.equal(firstSubscription?.lastConsentEventId, firstOptIn.requestId);
      assert.equal(await newsletterRepository.isSuppressed({ phone: firstOptIn.phone }), false);

      const reconfirmed = optIn(randomUUID(), new Date(now.getTime() + 120_000));
      await newsletterRepository.recordOptIn(reconfirmed, newsletterNotification(reconfirmed));
      const afterReconfirm = await newsletterRepository.getSubscription({ phone: reconfirmed.phone });
      assert.equal(afterReconfirm?.firstSubscribedAt.getTime(), firstOptIn.occurredAt.getTime());
      assert.equal(afterReconfirm?.subscribedAt.getTime(), firstOptIn.occurredAt.getTime());
      assert.equal(afterReconfirm?.lastConfirmedAt.getTime(), reconfirmed.occurredAt.getTime());

      const unsubscribeEventId = randomUUID();
      const unsubscribedAt = new Date(now.getTime() + 180_000);
      assert.deepEqual(
        await newsletterRepository.unsubscribe({
          eventId: unsubscribeEventId,
          phone: reconfirmed.phone,
          occurredAt: unsubscribedAt,
          reason: 'subscriber_request',
        }),
        { found: true, changed: true },
      );
      assert.equal(await newsletterRepository.isSuppressed({ phone: reconfirmed.phone }), true);
      assert.deepEqual(
        await newsletterRepository.unsubscribe({
          eventId: unsubscribeEventId,
          phone: reconfirmed.phone,
          occurredAt: unsubscribedAt,
          reason: 'subscriber_request',
        }),
        { found: true, changed: false },
      );

      const resubscribed = optIn(randomUUID(), new Date(now.getTime() + 240_000));
      await newsletterRepository.recordOptIn(resubscribed, newsletterNotification(resubscribed));
      const current = await newsletterRepository.getSubscription({ phone: resubscribed.phone });
      assert.equal(current?.status, 'active');
      assert.equal(current?.subscribedAt.getTime(), resubscribed.occurredAt.getTime());
      assert.equal(current?.unsubscribedAt, null);
      assert.equal(await newsletterRepository.isSuppressed({ phone: 'invalid' }), true);

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
        assert.equal(Number(leadRows[0]?.row_count), 1);
        assert.equal(Number(consentRows[0]?.row_count), 4);
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
