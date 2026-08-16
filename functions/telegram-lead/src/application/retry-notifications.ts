import type { NotificationDeliveryDependencies } from './ports';
import type { JsonObject, LoggerLike } from '../types';

const TELEGRAM_LEASE_MS = 2 * 60 * 1000;

export interface RetrySummary extends JsonObject {
  processed: number;
  sent: number;
  pending: number;
  failed: number;
  skipped: number;
}

function nextRetryAt(now: Date, attempts: number): Date {
  const delayMinutes = [1, 5, 15, 60, 6 * 60][Math.min(Math.max(attempts - 1, 0), 4)] ?? 1;

  return new Date(now.getTime() + delayMinutes * 60 * 1000);
}

export async function deliverNotification(
  notificationId: string,
  dependencies: NotificationDeliveryDependencies,
  logger: LoggerLike,
): Promise<'sent' | 'pending' | 'failed' | 'skipped'> {
  const now = dependencies.now();
  const deliveryToken = dependencies.uuid();
  const claimed = await dependencies.outbox.claim({
    notificationId,
    now,
    leaseUntil: new Date(now.getTime() + TELEGRAM_LEASE_MS),
    deliveryToken,
    logger,
  });
  if (!claimed) {
    return 'skipped';
  }

  try {
    await dependencies.telegramSender(claimed);
    await dependencies.outbox.markDelivered({
      notificationId,
      deliveryToken,
      deliveredAt: dependencies.now(),
      logger,
    });

    return 'sent';
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code.trim().slice(0, 64) || 'telegram_error'
        : 'telegram_error';
    const terminal = claimed.attempts >= dependencies.maxAttempts();
    await dependencies.outbox.markFailed({
      notificationId,
      deliveryToken,
      failedAt: terminal ? dependencies.now() : nextRetryAt(dependencies.now(), claimed.attempts),
      errorCode: code,
      terminal,
      logger,
    });
    dependencies.reportDeliveryFailure(
      logger,
      terminal ? 'telegram_delivery_failed_permanently' : 'telegram_delivery_retry_scheduled',
      notificationId,
      error,
      {
        attempts: claimed.attempts,
        fallbackCode: code,
        retriable: !terminal,
      },
    );

    return terminal ? 'failed' : 'pending';
  }
}

export async function retryPendingNotifications(
  dependencies: NotificationDeliveryDependencies,
  logger: LoggerLike,
): Promise<RetrySummary> {
  const notificationIds = await dependencies.outbox.listCandidates({
    now: dependencies.now(),
    limit: dependencies.retryBatchSize(),
    logger,
  });
  const summary: RetrySummary = {
    processed: notificationIds.length,
    sent: 0,
    pending: 0,
    failed: 0,
    skipped: 0,
  };

  for (const notificationId of notificationIds) {
    try {
      summary[await deliverNotification(notificationId, dependencies, logger)] += 1;
    } catch (error) {
      summary.pending += 1;
      dependencies.reportDeliveryFailure(
        logger,
        'telegram_delivery_retry_error',
        notificationId,
        error,
        { attempts: 0, fallbackCode: 'storage_error', retriable: true },
      );
    }
  }

  return summary;
}

export const _private = { nextRetryAt };
