import type { IntakeResult, NewsletterRepository } from '../application/ports';
import {
  normalizeSubscriberPhone,
  persistedSubscriptionStatus,
  type NewsletterOptIn,
  type NewsletterSubscription,
  type NewsletterUnsubscribe,
  type SubscriptionMutationResult,
} from '../domain/newsletter';
import type { NewsletterTelegramNotification } from '../domain/telegram-notification';
import type { Utm } from '../domain/shared';
import type { LoggerLike, SqlRow } from '../types';
import {
  newsletterConsentEventsTableName,
  newsletterSubscriptionsTableName,
  telegramOutboxTableName,
} from './config';
import {
  dateValue,
  firstResultSet,
  getSql,
  jsonObject,
  observed,
  stringValue,
  timed,
  transactionOptions,
  ydbTimestamp,
} from './context';
import {
  enqueueNotificationInTransaction,
  notificationStatusInTransaction,
} from './telegram-outbox';

function rowToSubscription(row: SqlRow): NewsletterSubscription {
  return {
    phoneNormalized: stringValue(row.phone_normalized),
    phone: stringValue(row.phone),
    status: persistedSubscriptionStatus(row.status),
    firstSubscribedAt: dateValue(row.first_subscribed_at),
    subscribedAt: dateValue(row.subscribed_at),
    lastConfirmedAt: dateValue(row.last_confirmed_at),
    unsubscribedAt: row.unsubscribed_at == null ? null : dateValue(row.unsubscribed_at),
    updatedAt: dateValue(row.updated_at),
    consentVersion: stringValue(row.consent_version),
    personalDataConsent: row.personal_data_consent === true,
    marketingConsent: row.marketing_consent === true,
    lastConsentEventId: stringValue(row.last_consent_event_id),
    utm: jsonObject(row.utm_json) as Utm,
    unsubscribeReason: stringValue(row.unsubscribe_reason),
  };
}

async function recordOptIn(
  optIn: NewsletterOptIn,
  notification: NewsletterTelegramNotification,
  { logger }: { logger?: LoggerLike } = {},
): Promise<IntakeResult> {
  return observed('record_newsletter_opt_in', logger, async () => {
    const sql = await getSql();
    const subscriptionsTable = sql.identifier(newsletterSubscriptionsTableName());
    const consentEventsTable = sql.identifier(newsletterConsentEventsTableName());
    const outboxTable = sql.identifier(telegramOutboxTableName());

    return sql.begin(transactionOptions(), async transaction => {
      const existingEvent = firstResultSet(
        await transaction`
          SELECT event_id
          FROM ${consentEventsTable}
          WHERE event_id = ${optIn.requestId};
        `,
      );
      if (existingEvent.length > 0) {
        return {
          created: false,
          notificationStatus: await notificationStatusInTransaction({
            transaction,
            outboxTable,
            notificationId: notification.notificationId,
          }),
        };
      }

      const currentRows = firstResultSet(
        await transaction`
          SELECT status, first_subscribed_at, subscribed_at
          FROM ${subscriptionsTable}
          WHERE phone_normalized = ${optIn.phoneNormalized};
        `,
      );
      const current = currentRows[0];
      const firstSubscribedAt = current
        ? dateValue(current.first_subscribed_at)
        : optIn.occurredAt;
      const subscribedAt =
        current && persistedSubscriptionStatus(current.status) === 'active'
          ? dateValue(current.subscribed_at)
          : optIn.occurredAt;

      await transaction`
        INSERT INTO ${consentEventsTable} (
          event_id,
          phone_normalized,
          phone,
          event_type,
          occurred_at,
          consent_version,
          personal_data_consent,
          marketing_consent,
          utm_json,
          reason
        ) VALUES (
          ${optIn.requestId},
          ${optIn.phoneNormalized},
          ${optIn.phone},
          ${'opt_in'},
          ${ydbTimestamp(optIn.occurredAt)},
          ${optIn.consents.version},
          ${optIn.consents.personalData},
          ${optIn.consents.marketing},
          ${JSON.stringify(optIn.utm)},
          ${''}
        );
      `;
      await transaction`
        UPSERT INTO ${subscriptionsTable} (
          phone_normalized,
          phone,
          status,
          first_subscribed_at,
          subscribed_at,
          last_confirmed_at,
          unsubscribed_at,
          updated_at,
          consent_version,
          personal_data_consent,
          marketing_consent,
          last_consent_event_id,
          utm_json,
          unsubscribe_reason
        ) VALUES (
          ${optIn.phoneNormalized},
          ${optIn.phone},
          ${'active'},
          ${ydbTimestamp(firstSubscribedAt)},
          ${ydbTimestamp(subscribedAt)},
          ${ydbTimestamp(optIn.occurredAt)},
          NULL,
          ${ydbTimestamp(optIn.occurredAt)},
          ${optIn.consents.version},
          ${optIn.consents.personalData},
          ${optIn.consents.marketing},
          ${optIn.requestId},
          ${JSON.stringify(optIn.utm)},
          ${''}
        );
      `;
      await enqueueNotificationInTransaction({ transaction, outboxTable, notification });

      return { created: true, notificationStatus: 'pending' };
    });
  });
}

async function getSubscription({
  phone,
  logger,
}: {
  phone: string;
  logger?: LoggerLike;
}): Promise<NewsletterSubscription | null> {
  return observed('get_newsletter_subscription', logger, async () => {
    const sql = await getSql();
    const subscriptionsTable = sql.identifier(newsletterSubscriptionsTableName());
    const rows = firstResultSet(
      await timed(
        sql`
          SELECT
            phone_normalized,
            phone,
            status,
            first_subscribed_at,
            subscribed_at,
            last_confirmed_at,
            unsubscribed_at,
            updated_at,
            consent_version,
            personal_data_consent,
            marketing_consent,
            last_consent_event_id,
            utm_json,
            unsubscribe_reason
          FROM ${subscriptionsTable}
          WHERE phone_normalized = ${normalizeSubscriberPhone(phone)};
        `
          .idempotent(true)
          .isolation('snapshotReadOnly'),
      ),
    );

    return rows[0] ? rowToSubscription(rows[0]) : null;
  });
}

async function unsubscribe({
  eventId,
  phone,
  occurredAt,
  reason,
  logger,
}: NewsletterUnsubscribe & { logger?: LoggerLike }): Promise<SubscriptionMutationResult> {
  return observed('unsubscribe_newsletter', logger, async () => {
    const phoneNormalized = normalizeSubscriberPhone(phone);
    const sql = await getSql();
    const subscriptionsTable = sql.identifier(newsletterSubscriptionsTableName());
    const consentEventsTable = sql.identifier(newsletterConsentEventsTableName());

    return sql.begin(transactionOptions(), async transaction => {
      const existingEvent = firstResultSet(
        await transaction`
          SELECT event_id
          FROM ${consentEventsTable}
          WHERE event_id = ${eventId};
        `,
      );
      if (existingEvent.length > 0) {
        return { found: true, changed: false };
      }

      const rows = firstResultSet(
        await transaction`
          SELECT status, consent_version, personal_data_consent, utm_json
          FROM ${subscriptionsTable}
          WHERE phone_normalized = ${phoneNormalized};
        `,
      );
      const current = rows[0];
      if (!current) {
        return { found: false, changed: false };
      }
      if (persistedSubscriptionStatus(current.status) !== 'active') {
        return { found: true, changed: false };
      }

      const safeReason = reason.trim().slice(0, 128) || 'subscriber_request';
      await transaction`
        INSERT INTO ${consentEventsTable} (
          event_id,
          phone_normalized,
          phone,
          event_type,
          occurred_at,
          consent_version,
          personal_data_consent,
          marketing_consent,
          utm_json,
          reason
        ) VALUES (
          ${eventId},
          ${phoneNormalized},
          ${phone},
          ${'unsubscribe'},
          ${ydbTimestamp(occurredAt)},
          ${stringValue(current.consent_version)},
          ${current.personal_data_consent === true},
          ${false},
          ${stringValue(current.utm_json) || '{}'},
          ${safeReason}
        );
      `;
      await transaction`
        UPDATE ${subscriptionsTable}
        SET
          status = ${'unsubscribed'},
          marketing_consent = ${false},
          unsubscribed_at = ${ydbTimestamp(occurredAt)},
          updated_at = ${ydbTimestamp(occurredAt)},
          last_consent_event_id = ${eventId},
          unsubscribe_reason = ${safeReason}
        WHERE phone_normalized = ${phoneNormalized};
      `;

      return { found: true, changed: true };
    });
  });
}

async function isSuppressed({
  phone,
  logger,
}: {
  phone: string;
  logger?: LoggerLike;
}): Promise<boolean> {
  try {
    const subscription = await getSubscription({ phone, logger });

    return (
      !subscription ||
      subscription.status !== 'active' ||
      !subscription.personalDataConsent ||
      !subscription.marketingConsent
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'invalid_subscription_phone') {
      return true;
    }
    throw error;
  }
}

export const newsletterRepository: NewsletterRepository = {
  getSubscription,
  isSuppressed,
  recordOptIn,
  unsubscribe,
};

export const _private = { rowToSubscription };
