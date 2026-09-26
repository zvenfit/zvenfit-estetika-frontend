import { errorChain } from '../error-chain';

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

// Deferring a timer is stricter than trying a read again: unclassified ClientError,
// generic names and message text must still reach the runtime-error alert.
export function isKnownTransientReadError(error: unknown): boolean {
  const chain = errorChain(error) as Record<string, unknown>[];
  const coded = chain.find(
    item =>
      item.code !== undefined &&
      item.code !== 'ydb_read_budget_exhausted' &&
      !(item instanceof DOMException) &&
      !(item.name === 'AbortError' && item.code === 'ABORT_ERR'),
  );
  if (coded) {
    return typeof coded.code === 'number'
      ? RETRYABLE_GRPC_CODES.has(coded.code) || RETRYABLE_YDB_CODES.has(coded.code)
      : typeof coded.code === 'string' && RETRYABLE_CODES.has(coded.code.toUpperCase());
  }

  return chain.some(
    item =>
      (item instanceof DOMException && item.name === 'TimeoutError') ||
      (item.code === 'ydb_read_budget_exhausted' && item.cause === undefined),
  );
}

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

// Space out short session failures while leaving the shared deadline in charge.
// Jitter avoids synchronizing recovery across function containers.
export function readRetryDelayMs(retryIndex: number, jitter: number): number {
  const baseMs = 500 * 2 ** Math.min(retryIndex, 2);

  return Math.floor(baseMs * (1 + jitter * 0.5));
}
