import { safeErrorFields } from './errors';

import type { LoggerLike } from '../types';

export function logDeliveryFailure(
  logger: LoggerLike,
  event: string,
  notificationId: string,
  error: unknown,
  options: { attempts: number; fallbackCode: string; retriable: boolean },
): void {
  logger.error(
    {
      event,
      notification_id: notificationId,
      attempts: options.attempts,
      ...safeErrorFields(error, {
        fallbackCode: options.fallbackCode,
        retriable: options.retriable,
      }),
    },
    event,
  );
}
