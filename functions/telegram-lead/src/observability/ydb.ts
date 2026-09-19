import { errorChain, safeErrorFields } from './errors';
import {
  createOperationState,
  operationStorage,
  phaseFields as queryFields,
  retryErrorFields,
  subscribeToDiagnostics,
} from './ydb-diagnostics';
import { initializationAttempts } from '../ydb/initialization-attempts';
import { slowOperationMs } from '../ydb/config';

import type { JsonObject, LoggerLike } from '../types';

interface ObserveYdbOperationOptions {
  retryTransientOnce?: boolean;
}

const RETRYABLE_READ_ERROR_NAMES = new Set(['AbortError', 'TimeoutError']);
const RETRYABLE_GRPC_CODES = new Set([4, 8, 10, 13, 14]);
const RETRYABLE_ERROR_PATTERN =
  /ABORTED|DEADLINE_EXCEEDED|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|INTERNAL|RESOURCE_EXHAUSTED|TIMEOUT|UNAVAILABLE/i;

function isTransientReadError(error: unknown): boolean {
  return errorChain(error).some(item => {
    const record = item as Record<string, unknown>;
    const errorName = item instanceof Error ? item.name : record.name;

    if (typeof errorName === 'string' && RETRYABLE_READ_ERROR_NAMES.has(errorName)) {
      return true;
    }

    // The YDB SDK uses a bare ClientError for some session-pool transport
    // failures. Retry an unclassified ClientError once, but let an explicit
    // permanent code such as PERMISSION_DENIED fall through the checks below.
    if (errorName === 'ClientError' && record.code === undefined) {
      return true;
    }

    if (typeof record.code === 'number' && RETRYABLE_GRPC_CODES.has(record.code)) {
      return true;
    }

    const description = [record.code, record.details, record.message]
      .filter(value => typeof value === 'string')
      .join(' ');

    return RETRYABLE_ERROR_PATTERN.test(description);
  });
}

function writeLog(
  logger: LoggerLike | undefined,
  level: 'info' | 'warn' | 'error',
  fields: JsonObject,
): void {
  const write = logger?.[level];
  if (write) {
    write.call(logger, fields, String(fields.event));
  }
}

export async function observeYdbOperation<T>(
  operationName: string,
  logger: LoggerLike | undefined,
  callback: () => Promise<T>,
  options: ObserveYdbOperationOptions = {},
): Promise<T> {
  subscribeToDiagnostics();
  const startedAt = Date.now();
  const operation = createOperationState();

  try {
    const result = await operationStorage.run(operation, async () => {
      try {
        return await callback();
      } catch (error) {
        if (!options.retryTransientOnce || !isTransientReadError(error)) {
          throw error;
        }

        operation.retries += 1;
        operation.retryFailure = retryErrorFields(operation, error, 'read_fallback');

        return callback();
      }
    });
    const durationMs = Date.now() - startedAt;
    writeLog(logger, 'info', {
      event: 'ydb_operation_completed',
      operation: operationName,
      duration_ms: durationMs,
      retry_attempts: operation.retries,
      ...queryFields(operation),
    });
    if (operation.retries > 0) {
      writeLog(logger, 'warn', {
        event: 'ydb_retry',
        operation: operationName,
        retry_attempts: operation.retries,
        duration_ms: durationMs,
        ...queryFields(operation),
        ...operation.retryFailure,
      });
    }
    const queryDurationMs = operation.phases.query_execute.maxDurationMs;
    if (queryDurationMs >= slowOperationMs()) {
      writeLog(logger, 'warn', {
        event: 'ydb_slow_operation',
        operation: operationName,
        phase: 'query_execute',
        duration_ms: queryDurationMs,
        total_duration_ms: durationMs,
      });
    }

    return result;
  } catch (error) {
    writeLog(logger, 'error', {
      event: 'ydb_operation_failed',
      operation: operationName,
      duration_ms: Date.now() - startedAt,
      retry_attempts: operation.retries,
      ...queryFields(operation),
      ...safeErrorFields(error, { fallbackCode: 'ydb_error' }),
    });
    throw error;
  }
}

export async function prepareAndObserveYdbOperation<TPrepared, TResult>(
  operationName: string,
  logger: LoggerLike | undefined,
  prepare: () => Promise<TPrepared>,
  callback: () => Promise<TResult>,
  options: ObserveYdbOperationOptions = {},
): Promise<TResult> {
  const startedAt = Date.now();
  try {
    await prepare();
  } catch (error) {
    const attempts = initializationAttempts(error);
    writeLog(logger, 'error', {
      event: 'ydb_operation_failed',
      operation: operationName,
      phase: 'client_preparation',
      duration_ms: Date.now() - startedAt,
      retry_attempts: 0,
      ...(attempts === undefined ? {} : { initialization_attempts: attempts }),
      ...safeErrorFields(error, { fallbackCode: 'ydb_initialization_error' }),
    });
    throw error;
  }

  return observeYdbOperation(operationName, logger, callback, options);
}

export const _private = {
  createOperationState,
  errorChain,
  isTransientReadError,
  queryFields,
  subscribeToDiagnostics,
  writeLog,
};
