import { queryTimeoutMs, subscriptionsTableName, tableName } from './config';
import {
  firstResultSet,
  getSql,
  observed,
  stringValue,
  timed,
  transactionOptions,
  ydbTimestamp,
} from './context';

import type {
  LoggerLike,
  NewsletterSubscription,
  NewsletterSubscriptionStatus,
  SqlRow,
  Submission,
  SubscriptionMutationResult,
  TransactionSql,
  Utm,
  YdbClient,
} from '../types';

interface ActivationContext {
  transaction: TransactionSql;
  subscriptionsTable: unknown;
  submission: Submission;
}

interface BackfillCandidate {
  phoneNormalized: string;
  phone: string;
  firstSubscribedAt: Date;
  lastConfirmedAt: Date;
  consentVersion: string;
  lastSubmissionId: string;
  utmJson: string;
}

interface BackfillCollection {
  candidates: Map<string, BackfillCandidate>;
  deduplicated: number;
  skippedInvalid: number;
}

export interface SubscriptionBackfillResult {
  inserted: number;
  skippedExisting: number;
  skippedInvalid: number;
  deduplicated: number;
}

function dateValue(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function jsonObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(stringValue(value) || '{}');

    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function subscriptionStatus(value: unknown): NewsletterSubscriptionStatus {
  return value === 'active' ? 'active' : 'unsubscribed';
}

export function normalizeSubscriberPhone(phone: string): string {
  let digits = phone.replace(/\D/g, '');
  if (digits.length === 10) {
    digits = `7${digits}`;
  } else if (digits.length === 11 && digits.startsWith('8')) {
    digits = `7${digits.slice(1)}`;
  }
  if (digits.length < 11 || digits.length > 15) {
    throw new Error('invalid_subscription_phone');
  }

  return `+${digits}`;
}

function rowToNewsletterSubscription(row: SqlRow): NewsletterSubscription {
  const utm = jsonObject(row.utm_json) as Utm;

  return {
    phoneNormalized: stringValue(row.phone_normalized),
    phone: stringValue(row.phone),
    status: subscriptionStatus(row.status),
    firstSubscribedAt: dateValue(row.first_subscribed_at),
    subscribedAt: dateValue(row.subscribed_at),
    lastConfirmedAt: dateValue(row.last_confirmed_at),
    unsubscribedAt: row.unsubscribed_at == null ? null : dateValue(row.unsubscribed_at),
    updatedAt: dateValue(row.updated_at),
    consentVersion: stringValue(row.consent_version),
    personalDataConsent: row.personal_data_consent === true,
    marketingConsent: row.marketing_consent === true,
    lastSubmissionId: stringValue(row.last_submission_id),
    utm,
    unsubscribeReason: stringValue(row.unsubscribe_reason),
  };
}

export async function activateNewsletterSubscriptionInTransaction({
  transaction,
  subscriptionsTable,
  submission,
}: ActivationContext): Promise<void> {
  if (submission.formType !== 'newsletter') {
    throw new Error('newsletter_subscription_required');
  }

  const phoneNormalized = normalizeSubscriberPhone(submission.phone);
  const rows = firstResultSet(
    await transaction`
      SELECT status, first_subscribed_at, subscribed_at
      FROM ${subscriptionsTable}
      WHERE phone_normalized = ${phoneNormalized};
    `,
  );
  const current = rows[0];
  const firstSubscribedAt = current
    ? dateValue(current.first_subscribed_at)
    : submission.createdAt;
  const subscribedAt =
    current && subscriptionStatus(current.status) === 'active'
      ? dateValue(current.subscribed_at)
      : submission.createdAt;

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
      last_submission_id,
      utm_json,
      unsubscribe_reason
    )
    VALUES (
      ${phoneNormalized},
      ${submission.phone},
      ${'active'},
      ${ydbTimestamp(firstSubscribedAt)},
      ${ydbTimestamp(subscribedAt)},
      ${ydbTimestamp(submission.createdAt)},
      NULL,
      ${ydbTimestamp(submission.createdAt)},
      ${submission.consents.version},
      ${submission.consents.personalData},
      ${submission.consents.marketing},
      ${submission.submissionId},
      ${JSON.stringify(submission.utm)},
      ${''}
    );
  `;
}

export async function getNewsletterSubscription({
  phone,
  logger,
}: {
  phone: string;
  logger?: LoggerLike;
}): Promise<NewsletterSubscription | null> {
  return observed('get_newsletter_subscription', logger, async () => {
    const sql = await getSql();
    const subscriptionsTable = sql.identifier(subscriptionsTableName());
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
            last_submission_id,
            utm_json,
            unsubscribe_reason
          FROM ${subscriptionsTable}
          WHERE phone_normalized = ${normalizeSubscriberPhone(phone)};
        `
          .idempotent(true)
          .isolation('snapshotReadOnly'),
      ),
    );

    return rows[0] ? rowToNewsletterSubscription(rows[0]) : null;
  });
}

export async function unsubscribeNewsletter({
  phone,
  unsubscribedAt,
  reason = 'subscriber_request',
  logger,
}: {
  phone: string;
  unsubscribedAt: Date;
  reason?: string;
  logger?: LoggerLike;
}): Promise<SubscriptionMutationResult> {
  return observed('unsubscribe_newsletter', logger, async () => {
    const sql = await getSql();
    const subscriptionsTable = sql.identifier(subscriptionsTableName());
    const phoneNormalized = normalizeSubscriberPhone(phone);

    return sql.begin(transactionOptions(), async transaction => {
      const rows = firstResultSet(
        await transaction`
          SELECT status
          FROM ${subscriptionsTable}
          WHERE phone_normalized = ${phoneNormalized};
        `,
      );
      if (!rows[0]) {
        return { found: false, changed: false };
      }
      if (subscriptionStatus(rows[0].status) === 'unsubscribed') {
        return { found: true, changed: false };
      }

      await transaction`
        UPDATE ${subscriptionsTable}
        SET
          status = ${'unsubscribed'},
          marketing_consent = ${false},
          unsubscribed_at = ${ydbTimestamp(unsubscribedAt)},
          updated_at = ${ydbTimestamp(unsubscribedAt)},
          unsubscribe_reason = ${reason.trim().slice(0, 128) || 'subscriber_request'}
        WHERE phone_normalized = ${phoneNormalized};
      `;

      return { found: true, changed: true };
    });
  });
}

export async function isNewsletterSuppressed({
  phone,
  logger,
}: {
  phone: string;
  logger?: LoggerLike;
}): Promise<boolean> {
  const subscription = await getNewsletterSubscription({ phone, logger });

  return (
    !subscription ||
    subscription.status !== 'active' ||
    !subscription.personalDataConsent ||
    !subscription.marketingConsent
  );
}

function collectBackfillCandidates(rows: SqlRow[]): BackfillCollection {
  const candidates = new Map<string, BackfillCandidate>();
  let skippedInvalid = 0;
  let deduplicated = 0;

  for (const row of rows) {
    const consent = jsonObject(row.consent_json);
    const consentVersion = stringValue(consent.version);
    if (!consentVersion || consent.personal_data !== true || consent.marketing !== true) {
      skippedInvalid += 1;
      continue;
    }

    let phoneNormalized: string;
    try {
      phoneNormalized = normalizeSubscriberPhone(stringValue(row.phone));
    } catch {
      skippedInvalid += 1;
      continue;
    }

    const createdAt = dateValue(row.created_at);
    if (Number.isNaN(createdAt.getTime())) {
      skippedInvalid += 1;
      continue;
    }
    const current = candidates.get(phoneNormalized);
    if (current) {
      deduplicated += 1;
    }
    const candidate: BackfillCandidate = {
      phoneNormalized,
      phone: stringValue(row.phone),
      firstSubscribedAt:
        current && current.firstSubscribedAt < createdAt ? current.firstSubscribedAt : createdAt,
      lastConfirmedAt:
        current && current.lastConfirmedAt > createdAt ? current.lastConfirmedAt : createdAt,
      consentVersion,
      lastSubmissionId: stringValue(row.submission_id),
      utmJson: stringValue(row.utm_json) || '{}',
    };

    if (current && current.lastConfirmedAt > createdAt) {
      candidate.phone = current.phone;
      candidate.consentVersion = current.consentVersion;
      candidate.lastSubmissionId = current.lastSubmissionId;
      candidate.utmJson = current.utmJson;
    }
    candidates.set(phoneNormalized, candidate);
  }

  return { candidates, deduplicated, skippedInvalid };
}

export async function backfillNewsletterSubscriptions(
  client: YdbClient,
): Promise<SubscriptionBackfillResult> {
  const submissionsTable = client.sql.identifier(tableName());
  const subscriptionsTable = client.sql.identifier(subscriptionsTableName());
  const sourceRows = firstResultSet(
    await client.sql`
      SELECT submission_id, created_at, phone, utm_json, consent_json
      FROM ${submissionsTable}
      WHERE form_type = ${'newsletter'};
    `
      .timeout(queryTimeoutMs())
      .idempotent(true)
      .isolation('snapshotReadOnly'),
  );
  const { candidates, deduplicated, skippedInvalid } = collectBackfillCandidates(sourceRows);
  let inserted = 0;
  let skippedExisting = 0;

  for (const candidate of candidates.values()) {
    const didInsert = await client.sql.begin(transactionOptions(), async transaction => {
      const existingRows = firstResultSet(
        await transaction`
          SELECT phone_normalized
          FROM ${subscriptionsTable}
          WHERE phone_normalized = ${candidate.phoneNormalized};
        `,
      );
      if (existingRows.length > 0) {
        return false;
      }

      await transaction`
        INSERT INTO ${subscriptionsTable} (
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
          last_submission_id,
          utm_json,
          unsubscribe_reason
        )
        VALUES (
          ${candidate.phoneNormalized},
          ${candidate.phone},
          ${'active'},
          ${new client.types.Timestamp(candidate.firstSubscribedAt)},
          ${new client.types.Timestamp(candidate.firstSubscribedAt)},
          ${new client.types.Timestamp(candidate.lastConfirmedAt)},
          NULL,
          ${new client.types.Timestamp(candidate.lastConfirmedAt)},
          ${candidate.consentVersion},
          ${true},
          ${true},
          ${candidate.lastSubmissionId},
          ${candidate.utmJson},
          ${''}
        );
      `;

      return true;
    });

    if (!didInsert) {
      skippedExisting += 1;
      continue;
    }
    inserted += 1;
  }

  return {
    inserted,
    skippedExisting,
    skippedInvalid,
    deduplicated,
  };
}

export const _private = {
  collectBackfillCandidates,
  dateValue,
  jsonObject,
  rowToNewsletterSubscription,
  subscriptionStatus,
};
