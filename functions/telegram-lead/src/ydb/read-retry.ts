import { setTimeout as delay } from 'node:timers/promises';

import { errorChain } from '../observability/errors';

const MAX_ATTEMPTS = 3;
const RETRYABLE_NAMES = new Set(['AbortError', 'TimeoutError']);
const RETRYABLE_GRPC_CODES = new Set([4, 8, 10, 13, 14]);
const RETRYABLE_CODES = new Set([
  'ABORTED',
  'DEADLINE_EXCEEDED',
  'UNAVAILABLE',
  'INTERNAL',
  'RESOURCE_EXHAUSTED',
  'OVERLOADED',
  'TIMEOUT',
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
]);
const RETRYABLE_YDB_CODES = new Set([400030, 400040, 400050, 400060, 400090, 400100, 400150]);

export function isTransientReadError(error: unknown): boolean {
  const chain = errorChain(error) as Record<string, unknown>[];
  // Explicit protocol codes take precedence over a generic wrapper name or
  // message. Never retry PERMISSION_DENIED merely because its text says timeout.
  // timers/promises wraps cancellation in ABORT_ERR. This is not a protocol
  // status; keep looking through its cause for an explicit permanent failure.
  const coded = chain.find(
    item =>
      item.code !== undefined &&
      !(item instanceof DOMException) &&
      !(item.name === 'AbortError' && item.code === 'ABORT_ERR'),
  );
  if (coded) {
    return typeof coded.code === 'number'
      ? RETRYABLE_GRPC_CODES.has(coded.code) || RETRYABLE_YDB_CODES.has(coded.code)
      : typeof coded.code === 'string' && RETRYABLE_CODES.has(coded.code.toUpperCase());
  }

  return chain.some(item => {
    if (typeof item.name === 'string' && RETRYABLE_NAMES.has(item.name)) {
      return true;
    }
    const description = [item.details, item.message].filter(value => typeof value === 'string').join(' ');

    // nice-grpc can omit code on a bare ClientError. Retain that narrow fallback.
    return (
      item.name === 'ClientError' ||
      [...RETRYABLE_CODES].some(code => new RegExp(`(?:^|[^A-Z0-9_])${code}(?:$|[^A-Z0-9_])`, 'i').test(description))
    );
  });
}

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
  const expire = () => {
    if (!controller.signal.aborted) {
      controller.abort(
        Object.assign(new Error('YDB read budget exhausted'), {
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
        if (attempt + 1 >= MAX_ATTEMPTS || !isTransientReadError(error)) {
          throw error;
        }

        const backoffMs = Math.floor(250 * 2 ** attempt * (1 + Math.random() * 0.5));
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
