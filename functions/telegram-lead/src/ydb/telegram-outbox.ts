import { persistedTelegramStatus } from '../domain/telegram-notification';
import { dueIndexName, queueHealthIndexName, telegramOutboxTableName } from './config';
import {
  firstResultSet,
  getSql,
  observed,
  rowToClaimedNotification,
  stringValue,
  timed,
  toEpoch,
  transactionOptions,
  ydbTimestamp,
  ydbUint32,
} from './context';

import type {
  ClaimedTelegramNotification,
  TelegramNotification,
  TelegramNotificationStatus,
  TelegramQueueHealth,
} from '../domain/telegram-notification';
import type { LoggerLike, TransactionSql } from '../types';

function notificationPayload(notification: TelegramNotification): string {
  return JSON.stringify(
    notification.kind === 'lead_created'
      ? {
          name: notification.name,
          phone: notification.phone,
          contact_method: notification.contactMethod,
          telegram_username: notification.telegramUsername,
          utm: notification.utm,
        }
      : { phone: notification.phone, utm: notification.utm },
  );
}

export async function enqueueNotificationInTransaction({
  transaction,
  outboxTable,
  notification,
}: {
  transaction: TransactionSql;
  outboxTable: unknown;
  notification: TelegramNotification;
}): Promise<void> {
  await transaction`
    INSERT INTO ${outboxTable} (
      notification_id,
      kind,
      aggregate_id,
      created_at,
      payload_json,
      status,
      attempts,
      due_at
    ) VALUES (
      ${notification.notificationId},
      ${notification.kind},
      ${notification.aggregateId},
      ${ydbTimestamp(notification.createdAt)},
      ${notificationPayload(notification)},
      ${'pending'},
      ${ydbUint32(0)},
      ${ydbTimestamp(notification.createdAt)}
    );
  `;
}

export async function notificationStatusInTransaction({
  transaction,
  outboxTable,
  notificationId,
}: {
  transaction: TransactionSql;
  outboxTable: unknown;
  notificationId: string;
}): Promise<TelegramNotificationStatus> {
  const rows = firstResultSet(
    await transaction`
      SELECT status
      FROM ${outboxTable}
      WHERE notification_id = ${notificationId};
    `,
  );
  if (!rows[0]) {
    throw new Error('telegram_outbox_invariant_broken');
  }

  return persistedTelegramStatus(rows[0].status);
}

export async function claim({
  notificationId,
  now,
  leaseUntil,
  deliveryToken,
  logger,
}: {
  notificationId: string;
  now: Date;
  leaseUntil: Date;
  deliveryToken: string;
  logger?: LoggerLike;
}): Promise<ClaimedTelegramNotification | null> {
  return observed('claim_for_telegram', logger, async () => {
    const sql = await getSql();
    const outboxTable = sql.identifier(telegramOutboxTableName());

    return sql.begin(transactionOptions(), async transaction => {
      const rows = firstResultSet(
        await transaction`
          SELECT
            notification_id,
            kind,
            aggregate_id,
            created_at,
            payload_json,
            status,
            attempts,
            due_at
          FROM ${outboxTable}
          WHERE notification_id = ${notificationId};
        `,
      );
      const row = rows[0];
      if (!row) {
        return null;
      }

      const due = toEpoch(row.due_at) <= now.getTime();
      const status = persistedTelegramStatus(row.status);
      if ((status !== 'pending' && status !== 'sending') || !due) {
        return null;
      }

      const attempts = Number(row.attempts || 0) + 1;
      await transaction`
        UPDATE ${outboxTable}
        SET
          status = ${'sending'},
          aggregate_id = notification_id,
          attempts = ${ydbUint32(attempts)},
          due_at = ${ydbTimestamp(leaseUntil)},
          delivery_token = ${deliveryToken}
        WHERE notification_id = ${notificationId};
      `;

      return { ...rowToClaimedNotification(row), attempts };
    });
  });
}

export async function markDelivered({
  notificationId,
  deliveryToken,
  deliveredAt,
  logger,
}: {
  notificationId: string;
  deliveryToken: string;
  deliveredAt: Date;
  logger?: LoggerLike;
}): Promise<void> {
  return observed('mark_telegram_delivered', logger, async () => {
    const sql = await getSql();
    const outboxTable = sql.identifier(telegramOutboxTableName());
    await timed(
      sql`
        UPDATE ${outboxTable}
        SET
          status = ${'sent'},
          aggregate_id = notification_id,
          payload_json = ${'{}'},
          due_at = NULL,
          delivery_token = NULL,
          last_error = NULL,
          delivered_at = ${ydbTimestamp(deliveredAt)}
        WHERE
          notification_id = ${notificationId}
          AND status = ${'sending'}
          AND delivery_token = ${deliveryToken};
      `.idempotent(true),
    );
  });
}

export async function markFailed({
  notificationId,
  deliveryToken,
  failedAt,
  errorCode,
  terminal,
  logger,
}: {
  notificationId: string;
  deliveryToken: string;
  failedAt: Date;
  errorCode: string;
  terminal: boolean;
  logger?: LoggerLike;
}): Promise<void> {
  return observed('mark_telegram_failed', logger, async () => {
    const sql = await getSql();
    const outboxTable = sql.identifier(telegramOutboxTableName());
    const status = terminal ? 'failed' : 'pending';
    const dueAt = terminal ? sql.fragment`NULL` : sql.fragment`${ydbTimestamp(failedAt)}`;
    const payloadJson = terminal ? sql.fragment`${'{}'}` : sql.fragment`payload_json`;

    await timed(
      sql`
        UPDATE ${outboxTable}
        SET
          status = ${status},
          aggregate_id = notification_id,
          payload_json = ${payloadJson},
          due_at = ${dueAt},
          delivery_token = NULL,
          last_error = ${errorCode}
        WHERE
          notification_id = ${notificationId}
          AND status = ${'sending'}
          AND delivery_token = ${deliveryToken};
      `.idempotent(true),
    );
  });
}

export async function listCandidates({
  now,
  limit,
  logger,
}: {
  now: Date;
  limit: number;
  logger?: LoggerLike;
}): Promise<string[]> {
  return observed('list_telegram_candidates', logger, async () => {
    const sql = await getSql();
    const outboxTable = sql.identifier(telegramOutboxTableName());
    const dueIndex = sql.identifier(dueIndexName());
    const safeLimit = Math.min(Math.max(Number(limit) || 1, 1), 100);
    const rows = firstResultSet(
      await timed(
        sql`
          SELECT notification_id
          FROM ${outboxTable} VIEW ${dueIndex}
          WHERE
            due_at <= ${ydbTimestamp(now)}
            AND (status = ${'pending'} OR status = ${'sending'})
          ORDER BY due_at, created_at, notification_id
          LIMIT ${safeLimit};
        `
          .idempotent(true)
          .isolation('snapshotReadOnly'),
      ),
    );

    return rows.map(row => stringValue(row.notification_id));
  });
}

export async function getQueueHealth({
  now,
  logger,
}: {
  now: Date;
  logger?: LoggerLike;
}): Promise<TelegramQueueHealth> {
  return observed('get_telegram_queue_health', logger, async () => {
    const sql = await getSql();
    const outboxTable = sql.identifier(telegramOutboxTableName());
    const queueHealthIndex = sql.identifier(queueHealthIndexName());
    const rows = firstResultSet(
      await timed(
        sql`
          SELECT COUNT(*) AS pending_count, MIN(created_at) AS oldest_created_at
          FROM ${outboxTable} VIEW ${queueHealthIndex}
          WHERE status = ${'pending'} OR status = ${'sending'};
        `
          .idempotent(true)
          .isolation('snapshotReadOnly'),
      ),
    );
    const row = rows[0];
    const pendingCount = Math.max(0, Number(row?.pending_count || 0));
    const oldestCreatedAt = row?.oldest_created_at;
    const oldestPendingAgeSeconds = oldestCreatedAt
      ? Math.max(0, Math.floor((now.getTime() - toEpoch(oldestCreatedAt)) / 1000))
      : 0;

    return { pendingCount, oldestPendingAgeSeconds };
  });
}

export const _private = { notificationPayload };
