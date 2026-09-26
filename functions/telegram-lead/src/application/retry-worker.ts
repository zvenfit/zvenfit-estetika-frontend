import { retryPendingNotifications, type RetrySummary } from './retry-notifications';
import { QueueReadUnavailableError } from './queue-read-unavailable';

import type { NotificationDeliveryDependencies } from './ports';
import type { ApplicationMetrics, LoggerLike } from '../types';

export type RetryWorkerResult = RetrySummary | { deferred: true; stage: 'delivery' | 'queue_health' };

export async function runRetryWorker(
  dependencies: NotificationDeliveryDependencies,
  logger: LoggerLike,
  metrics: ApplicationMetrics,
): Promise<RetryWorkerResult> {
  let stage: 'delivery' | 'queue_health' = 'delivery';
  try {
    const summary = await retryPendingNotifications(dependencies, logger);
    stage = 'queue_health';
    const health = await dependencies.outbox.getQueueHealth({ now: dependencies.now(), logger });
    // Retain the legacy series until the coordinated dashboard migration is verified.
    metrics.recordGauge('zvenfit_estetika_telegram_pending_submissions', health.pendingCount);
    metrics.recordGauge('zvenfit_estetika_telegram_pending_notifications', health.pendingCount);
    metrics.recordGauge('zvenfit_estetika_telegram_oldest_pending_age_seconds', health.oldestPendingAgeSeconds);
    metrics.recordGauge('zvenfit_estetika_retry_worker_heartbeat', 1);
    const event = 'retry_worker_completed';
    logger.info?.(
      {
        event,
        ...summary,
        outbox_pending: health.pendingCount,
        oldest_pending_age_seconds: health.oldestPendingAgeSeconds,
      },
      event,
    );

    return summary;
  } catch (error) {
    if (!(error instanceof QueueReadUnavailableError)) {
      throw error;
    }
    // The next scheduled pass resumes the durable outbox. Unknown health must
    // not produce zero gauges or a successful heartbeat, even after delivery.
    const event = 'retry_worker_deferred';
    logger.warn?.({ event, stage, reason: 'queue_read_unavailable' }, event);

    return { deferred: true, stage };
  }
}
