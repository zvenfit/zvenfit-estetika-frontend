import { setTimeout as delay } from 'node:timers/promises';

import { isTransientReadError, readRetryDelayMs } from './read-retry-policy';

interface ReadRetryOptions {
  budgetMs: number;
  onRetry(error: unknown): void;
  onRetryScheduled?(error: unknown): void;
}

export async function retryRead<T>(
  callback: (signal: AbortSignal) => Promise<T>,
  { budgetMs, onRetry, onRetryScheduled }: ReadRetryOptions,
): Promise<T> {
  const controller = new AbortController();
  const deadline = performance.now() + budgetMs;
  let lastError: unknown;
  const expire = () => {
    if (!controller.signal.aborted) {
      controller.abort(
        Object.assign(new Error('YDB read budget exhausted', { cause: lastError }), {
          name: 'TimeoutError',
          code: 'ydb_read_budget_exhausted',
          retriable: true,
        }),
      );
    }
  };
  const timer = setTimeout(expire, budgetMs);
  let rejectDeadline!: (reason: unknown) => void;
  const deadlineReached = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  const onAbort = () => rejectDeadline(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });

  const run = async () => {
    for (let attempt = 0; ; attempt += 1) {
      if (performance.now() >= deadline) {
        expire();
      }
      controller.signal.throwIfAborted();
      try {
        lastError = undefined;
        // The same signal reaches every query and the SDK's internal retries.
        const result = await callback(controller.signal);
        // A stalled event loop can deliver a result before the overdue timer.
        if (performance.now() >= deadline) {
          expire();
        }
        controller.signal.throwIfAborted();

        return result;
      } catch (error) {
        controller.signal.throwIfAborted();
        lastError = error;
        if (!isTransientReadError(error)) {
          throw error;
        }

        const backoffMs = readRetryDelayMs(attempt, Math.random());
        if (deadline - performance.now() <= backoffMs) {
          throw error;
        }
        // Preserve the preceding failure even if cancellation interrupts the wait.
        onRetryScheduled?.(error);
        await delay(backoffMs, undefined, { signal: controller.signal });
        if (performance.now() >= deadline) {
          expire();
        }
        controller.signal.throwIfAborted();
        onRetry(error);
      }
    }
  };

  try {
    // Signal cancellation stops the SDK; the race also bounds a delayed unwind.
    return await Promise.race([run(), deadlineReached]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
