import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';

import { slowOperationMs } from '../ydb/config';

import type { JsonObject, LoggerLike } from '../types';

interface OperationState {
  retries: number;
}

const operationStorage = new AsyncLocalStorage<OperationState>();
let subscribed = false;

function subscribeToRetries(): void {
  if (subscribed) {
    return;
  }

  channel('ydb:retry.attempt.completed').subscribe(message => {
    const operation = operationStorage.getStore();
    const outcome =
      typeof message === 'object' && message !== null && 'outcome' in message
        ? message.outcome
        : undefined;

    if (operation && outcome === 'retried') {
      operation.retries += 1;
    }
  });
  subscribed = true;
}

function errorCode(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'ydb_error';
  }

  const codedError = error as Error & { code?: unknown; cause?: { code?: unknown } };

  return String(codedError.code || codedError.cause?.code || error.name || 'ydb_error').slice(0, 64);
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
): Promise<T> {
  subscribeToRetries();
  const startedAt = Date.now();
  const operation = { retries: 0 };

  try {
    const result = await operationStorage.run(operation, callback);
    const durationMs = Date.now() - startedAt;
    writeLog(logger, 'info', {
      event: 'ydb_operation_completed',
      operation: operationName,
      duration_ms: durationMs,
      retry_attempts: operation.retries,
    });
    if (operation.retries > 0) {
      writeLog(logger, 'warn', {
        event: 'ydb_retry',
        operation: operationName,
        retry_attempts: operation.retries,
      });
    }
    if (durationMs >= slowOperationMs()) {
      writeLog(logger, 'warn', {
        event: 'ydb_slow_operation',
        operation: operationName,
        duration_ms: durationMs,
      });
    }

    return result;
  } catch (error) {
    writeLog(logger, 'error', {
      event: 'ydb_operation_failed',
      operation: operationName,
      duration_ms: Date.now() - startedAt,
      retry_attempts: operation.retries,
      error_code: errorCode(error),
    });
    throw error;
  }
}

export const _private = { errorCode, subscribeToRetries, writeLog };
