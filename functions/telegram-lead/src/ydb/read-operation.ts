import { retryRead } from './read-retry';
import { prepareAndObserveYdbOperation } from '../observability/ydb';

import type { LoggerLike } from '../types';

// Persistence owns recovery; observers receive events without executing retries.
export function runReadOnlyYdbOperation<T>(
  operation: string,
  logger: LoggerLike | undefined,
  prepare: () => Promise<unknown>,
  execute: (signal: AbortSignal) => Promise<T>,
  budgetMs: number,
): Promise<T> {
  return prepareAndObserveYdbOperation(operation, logger, prepare, observer =>
    retryRead(execute, {
      budgetMs,
      onRetryScheduled: observer.onReadRetryScheduled,
      onRetry: observer.onReadRetry,
    }),
  );
}
