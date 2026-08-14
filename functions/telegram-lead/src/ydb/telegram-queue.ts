import { dueIndexName, queueHealthIndexName, tableName } from './config';
import {
  firstResultSet,
  getSql,
  observed,
  rowToSubmission,
  stringValue,
  timed,
  toEpoch,
  transactionOptions,
  ydbTimestamp,
  ydbUint32,
} from './context';

import type { ClaimedSubmission, LoggerLike, TelegramQueueHealth } from '../types';

export async function claimForTelegram({
  submissionId,
  now,
  leaseUntil,
  deliveryToken,
  logger,
}: {
  submissionId: string;
  now: Date;
  leaseUntil: Date;
  deliveryToken: string;
  logger?: LoggerLike;
}): Promise<ClaimedSubmission | null> {
  return observed('claim_for_telegram', logger, async () => {
    const sql = await getSql();
    const submissionsTable = sql.identifier(tableName());

    return sql.begin(transactionOptions(), async transaction => {
      const rows = firstResultSet(
        await transaction`
          SELECT
            submission_id,
            form_type,
            created_at,
            name,
            phone,
            service,
            telegram_username,
            utm_json,
            consent_json,
            telegram_status,
            telegram_attempts,
            telegram_due_at
          FROM ${submissionsTable}
          WHERE submission_id = ${submissionId};
        `,
      );
      const row = rows[0];
      if (!row) {
        return null;
      }

      const due = toEpoch(row.telegram_due_at) <= now.getTime();
      const readyStatus = row.telegram_status === 'pending' || row.telegram_status === 'sending';
      if (!readyStatus || !due) {
        return null;
      }

      const attempts = Number(row.telegram_attempts || 0) + 1;
      await transaction`
        UPDATE ${submissionsTable}
        SET
          telegram_status = ${'sending'},
          telegram_attempts = ${ydbUint32(attempts)},
          telegram_due_at = ${ydbTimestamp(leaseUntil)},
          telegram_delivery_token = ${deliveryToken}
        WHERE submission_id = ${submissionId};
      `;

      return { ...rowToSubmission(row), telegramAttempts: attempts };
    });
  });
}

export async function markTelegramDelivered({
  submissionId,
  deliveryToken,
  notifiedAt,
  logger,
}: {
  submissionId: string;
  deliveryToken: string;
  notifiedAt: Date;
  logger?: LoggerLike;
}): Promise<void> {
  return observed('mark_telegram_delivered', logger, async () => {
    const sql = await getSql();
    const submissionsTable = sql.identifier(tableName());
    await timed(
      sql`
        UPDATE ${submissionsTable}
        SET
          telegram_status = ${'sent'},
          telegram_due_at = NULL,
          telegram_delivery_token = NULL,
          telegram_last_error = NULL,
          telegram_notified_at = ${ydbTimestamp(notifiedAt)}
        WHERE
          submission_id = ${submissionId}
          AND telegram_status = ${'sending'}
          AND telegram_delivery_token = ${deliveryToken};
      `.idempotent(true),
    );
  });
}

export async function markTelegramFailed({
  submissionId,
  deliveryToken,
  failedAt,
  errorCode,
  terminal,
  logger,
}: {
  submissionId: string;
  deliveryToken: string;
  failedAt: Date;
  errorCode: string;
  terminal: boolean;
  logger?: LoggerLike;
}): Promise<void> {
  return observed('mark_telegram_failed', logger, async () => {
    const sql = await getSql();
    const submissionsTable = sql.identifier(tableName());
    const status = terminal ? 'failed' : 'pending';
    const dueAt = terminal ? sql.fragment`NULL` : sql.fragment`${ydbTimestamp(failedAt)}`;

    await timed(
      sql`
        UPDATE ${submissionsTable}
        SET
          telegram_status = ${status},
          telegram_due_at = ${dueAt},
          telegram_delivery_token = NULL,
          telegram_last_error = ${errorCode}
        WHERE
          submission_id = ${submissionId}
          AND telegram_status = ${'sending'}
          AND telegram_delivery_token = ${deliveryToken};
      `.idempotent(true),
    );
  });
}

export async function listTelegramCandidates({
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
    const submissionsTable = sql.identifier(tableName());
    const dueIndex = sql.identifier(dueIndexName());
    const safeLimit = Math.min(Math.max(Number(limit) || 1, 1), 100);

    const rows = firstResultSet(
      await timed(
        sql`
          SELECT submission_id
          FROM ${submissionsTable} VIEW ${dueIndex}
          WHERE
            telegram_due_at <= ${ydbTimestamp(now)}
            AND (telegram_status = ${'pending'} OR telegram_status = ${'sending'})
          ORDER BY telegram_due_at, created_at, submission_id
          LIMIT ${safeLimit};
        `
          .idempotent(true)
          .isolation('snapshotReadOnly'),
      ),
    );

    return rows.map(row => stringValue(row.submission_id));
  });
}

export async function getTelegramQueueHealth({
  now,
  logger,
}: {
  now: Date;
  logger?: LoggerLike;
}): Promise<TelegramQueueHealth> {
  return observed('get_telegram_queue_health', logger, async () => {
    const sql = await getSql();
    const submissionsTable = sql.identifier(tableName());
    const queueHealthIndex = sql.identifier(queueHealthIndexName());
    const rows = firstResultSet(
      await timed(
        sql`
          SELECT
            COUNT(*) AS pending_count,
            MIN(created_at) AS oldest_created_at
          FROM ${submissionsTable} VIEW ${queueHealthIndex}
          WHERE telegram_status = ${'pending'} OR telegram_status = ${'sending'};
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
