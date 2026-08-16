import { createHash } from 'node:crypto';

import type { IntakeResult, NewsletterRepository } from '../application/ports';
import {
  canApplyConsentEvent,
  normalizeSubscriberPhone,
  persistedSubscriptionStatus,
  type ConsentMutationResult,
  type NewsletterConsentEventType,
  type NewsletterOptInConfirmation,
  type NewsletterOptInRequest,
  type NewsletterSubscription,
  type NewsletterUnsubscribe,
} from '../domain/newsletter';
import type { NewsletterTelegramNotification } from '../domain/telegram-notification';
import type { Utm } from '../domain/shared';
import type { LoggerLike, SqlRow, TransactionSql } from '../types';
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

interface ConsentEventRecord {
  eventId: string;
  phoneNormalized: string;
  phone: string;
  eventType: NewsletterConsentEventType;
  occurredAt: Date;
  consentVersion: string;
  personalDataConsent: boolean;
  marketingConsent: boolean;
  utmJson: string;
  reason: string;
}

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

async function consentEventExists(
  transaction: TransactionSql,
  consentEventsTable: unknown,
  eventId: string,
): Promise<boolean> {
  const rows = firstResultSet(
    await transaction`
      SELECT event_id
      FROM ${consentEventsTable}
      WHERE event_id = ${eventId};
    `,
  );

  return rows.length > 0;
}

async function insertConsentEvent(
  transaction: TransactionSql,
  consentEventsTable: unknown,
  event: ConsentEventRecord,
): Promise<void> {
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
      ${event.eventId},
      ${event.phoneNormalized},
      ${event.phone},
      ${event.eventType},
      ${ydbTimestamp(event.occurredAt)},
      ${event.consentVersion},
      ${event.personalDataConsent},
      ${event.marketingConsent},
      ${event.utmJson},
      ${event.reason}
    );
  `;
}

function confirmationAuditReason(proofReference: string, requestEventId: string): string {
  const reference = proofReference.trim();
  if (!reference) {
    throw new Error('newsletter_confirmation_proof_missing');
  }

  return `confirmed:${requestEventId}:${createHash('sha256').update(reference).digest('hex')}`;
}

async function recordOptInRequest(
  request: NewsletterOptInRequest,
  notification: NewsletterTelegramNotification,
  { logger }: { logger?: LoggerLike } = {},
): Promise<IntakeResult> {
  return observed('record_newsletter_opt_in_request', logger, async () => {
    const sql = await getSql();
    const consentEventsTable = sql.identifier(newsletterConsentEventsTableName());
    const outboxTable = sql.identifier(telegramOutboxTableName());

    return sql.begin(transactionOptions(), async transaction => {
      if (await consentEventExists(transaction, consentEventsTable, request.requestId)) {
        return {
          created: false,
          notificationStatus: await notificationStatusInTransaction({
            transaction,
            outboxTable,
            notificationId: notification.notificationId,
          }),
        };
      }

      await insertConsentEvent(transaction, consentEventsTable, {
        eventId: request.requestId,
        phoneNormalized: request.phoneNormalized,
        phone: request.phone,
        eventType: 'opt_in_requested',
        occurredAt: request.occurredAt,
        consentVersion: request.consents.version,
        personalDataConsent: request.consents.personalData,
        marketingConsent: request.consents.marketing,
        utmJson: JSON.stringify(request.utm),
        reason: '',
      });
      await enqueueNotificationInTransaction({ transaction, outboxTable, notification });

      return { created: true, notificationStatus: 'pending' };
    });
  });
}

async function confirmOptIn({
  eventId,
  requestEventId,
  occurredAt,
  proofReference,
  logger,
}: NewsletterOptInConfirmation & { logger?: LoggerLike }): Promise<ConsentMutationResult> {
  return observed('confirm_newsletter_opt_in', logger, async () => {
    const proofReason = confirmationAuditReason(proofReference, requestEventId);
    const sql = await getSql();
    const subscriptionsTable = sql.identifier(newsletterSubscriptionsTableName());
    const consentEventsTable = sql.identifier(newsletterConsentEventsTableName());

    return sql.begin(transactionOptions(), async transaction => {
      if (await consentEventExists(transaction, consentEventsTable, eventId)) {
        return { eventCreated: false, stateChanged: false };
      }

      const requestRows = firstResultSet(
        await transaction`
          SELECT
            phone_normalized,
            phone,
            event_type,
            occurred_at,
            consent_version,
            personal_data_consent,
            marketing_consent,
            utm_json
          FROM ${consentEventsTable}
          WHERE event_id = ${requestEventId};
        `,
      );
      const request = requestRows[0];
      if (
        !request ||
        stringValue(request.event_type) !== 'opt_in_requested' ||
        request.personal_data_consent !== true ||
        request.marketing_consent !== true
      ) {
        throw new Error('newsletter_opt_in_request_not_found');
      }
      const requestedAt = dateValue(request.occurred_at);
      if (occurredAt.getTime() < requestedAt.getTime()) {
        throw new Error('newsletter_confirmation_precedes_request');
      }
      const phoneNormalized = stringValue(request.phone_normalized);
      const phone = stringValue(request.phone);
      const currentRows = firstResultSet(
        await transaction`
          SELECT status, first_subscribed_at, subscribed_at, updated_at
          FROM ${subscriptionsTable}
          WHERE phone_normalized = ${phoneNormalized};
        `,
      );
      const current = currentRows[0];
      const shouldApply =
        !current ||
        canApplyConsentEvent(occurredAt, dateValue(current.updated_at), 'opt_in_confirmed');

      await insertConsentEvent(transaction, consentEventsTable, {
        eventId,
        phoneNormalized,
        phone,
        eventType: 'opt_in_confirmed',
        occurredAt,
        consentVersion: stringValue(request.consent_version),
        personalDataConsent: true,
        marketingConsent: true,
        utmJson: stringValue(request.utm_json) || '{}',
        reason: proofReason,
      });

      if (!shouldApply) {
        return { eventCreated: true, stateChanged: false };
      }

      const currentStatus = current ? persistedSubscriptionStatus(current.status) : null;
      const firstSubscribedAt = current
        ? dateValue(current.first_subscribed_at)
        : requestedAt;
      const subscribedAt =
        current && currentStatus === 'active' ? dateValue(current.subscribed_at) : occurredAt;
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
          ${phoneNormalized},
          ${phone},
          ${'active'},
          ${ydbTimestamp(firstSubscribedAt)},
          ${ydbTimestamp(subscribedAt)},
          ${ydbTimestamp(occurredAt)},
          NULL,
          ${ydbTimestamp(occurredAt)},
          ${stringValue(request.consent_version)},
          ${true},
          ${true},
          ${eventId},
          ${stringValue(request.utm_json) || '{}'},
          ${''}
        );
      `;

      return { eventCreated: true, stateChanged: true };
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
}: NewsletterUnsubscribe & { logger?: LoggerLike }): Promise<ConsentMutationResult> {
  return observed('unsubscribe_newsletter', logger, async () => {
    const phoneNormalized = normalizeSubscriberPhone(phone);
    const safeReason = reason.trim().slice(0, 128) || 'subscriber_request';
    const sql = await getSql();
    const subscriptionsTable = sql.identifier(newsletterSubscriptionsTableName());
    const consentEventsTable = sql.identifier(newsletterConsentEventsTableName());

    return sql.begin(transactionOptions(), async transaction => {
      if (await consentEventExists(transaction, consentEventsTable, eventId)) {
        return { eventCreated: false, stateChanged: false };
      }

      const rows = firstResultSet(
        await transaction`
          SELECT
            first_subscribed_at,
            subscribed_at,
            last_confirmed_at,
            updated_at,
            consent_version,
            personal_data_consent,
            utm_json
          FROM ${subscriptionsTable}
          WHERE phone_normalized = ${phoneNormalized};
        `,
      );
      const current = rows[0];
      await insertConsentEvent(transaction, consentEventsTable, {
        eventId,
        phoneNormalized,
        phone,
        eventType: 'unsubscribe',
        occurredAt,
        consentVersion: stringValue(current?.consent_version),
        personalDataConsent: current?.personal_data_consent === true,
        marketingConsent: false,
        utmJson: stringValue(current?.utm_json) || '{}',
        reason: safeReason,
      });

      const shouldApply =
        !current || canApplyConsentEvent(occurredAt, dateValue(current.updated_at), 'unsubscribe');
      if (!shouldApply) {
        return { eventCreated: true, stateChanged: false };
      }

      const firstSubscribedAt = current ? dateValue(current.first_subscribed_at) : occurredAt;
      const subscribedAt = current ? dateValue(current.subscribed_at) : occurredAt;
      const lastConfirmedAt = current ? dateValue(current.last_confirmed_at) : occurredAt;
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
          ${phoneNormalized},
          ${phone},
          ${'unsubscribed'},
          ${ydbTimestamp(firstSubscribedAt)},
          ${ydbTimestamp(subscribedAt)},
          ${ydbTimestamp(lastConfirmedAt)},
          ${ydbTimestamp(occurredAt)},
          ${ydbTimestamp(occurredAt)},
          ${stringValue(current?.consent_version)},
          ${current?.personal_data_consent === true},
          ${false},
          ${eventId},
          ${stringValue(current?.utm_json) || '{}'},
          ${safeReason}
        );
      `;

      return { eventCreated: true, stateChanged: true };
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
  confirmOptIn,
  getSubscription,
  isSuppressed,
  recordOptInRequest,
  unsubscribe,
};

export const _private = {
  confirmationAuditReason,
  consentEventExists,
  insertConsentEvent,
  rowToSubscription,
};
