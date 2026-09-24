import { errorChain, safeErrorFields } from './errors';
import {
  createOperationState,
  operationStorage,
  phaseFields as queryFields,
  failurePhaseFields,
  retryErrorFields,
  subscribeToDiagnostics,
} from './ydb-diagnostics';
import { initializationAttempts } from '../ydb/initialization-attempts';
import { slowOperationMs } from '../ydb/config';
import { isTransientReadError, retryRead } from '../ydb/read-retry';

import type { JsonObject, LoggerLike } from '../types';

interface ObserveYdbOperationOptions {
  readRetry?: { budgetMs: number };
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
  callback: (signal: AbortSignal) => Promise<T>,
  options: ObserveYdbOperationOptions = {},
): Promise<T> {
  subscribeToDiagnostics();
  const startedAt = Date.now();
  const operation = createOperationState();

  try {
    const result = await operationStorage.run(operation, async () => {
      if (options.readRetry) {
        return retryRead(callback, {
          budgetMs: options.readRetry.budgetMs,
          onRetryScheduled(error) {
            operation.priorReadFailure = retryErrorFields(operation, error, 'read_fallback');
          },
          onRetry() {
            operation.retries += 1;
            operation.retryFailure = operation.priorReadFailure;
          },
        });
      }

      return callback(new AbortController().signal);
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
    const priorError = operation.priorReadFailure ?? operation.retryFailure;
    writeLog(logger, 'error', {
      event: 'ydb_operation_failed',
      operation: operationName,
      duration_ms: Date.now() - startedAt,
      retry_attempts: operation.retries,
      ...queryFields(operation),
      ...safeErrorFields(error, { fallbackCode: 'ydb_error' }),
      ...failurePhaseFields(operation, error),
      ...(priorError ? { prior_error: priorError } : {}),
    });
    throw error;
  }
}

export async function prepareAndObserveYdbOperation<TPrepared, TResult>(
  operationName: string,
  logger: LoggerLike | undefined,
  prepare: () => Promise<TPrepared>,
  callback: (signal: AbortSignal) => Promise<TResult>,
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
