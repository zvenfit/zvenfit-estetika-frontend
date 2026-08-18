import { AsyncLocalStorage } from 'node:async_hooks';
import { channel, tracingChannel } from 'node:diagnostics_channel';

import { safeErrorFields } from './errors';
import { slowOperationMs } from '../ydb/config';

import type { JsonObject, LoggerLike } from '../types';

interface OperationState {
  retries: number;
  queryExecution: PhaseAggregate;
}

interface PhaseAggregate {
  attempts: number;
  maxDurationMs: number;
  totalDurationMs: number;
}

interface QueryTrace {
  operation: OperationState;
  startedAt: number;
}

interface ObserveYdbOperationOptions {
  retryAbortOnce?: boolean;
}

const operationStorage = new AsyncLocalStorage<OperationState>();
const queryTraces = new WeakMap<object, QueryTrace>();
let subscribed = false;

function emptyPhaseAggregate(): PhaseAggregate {
  return { attempts: 0, maxDurationMs: 0, totalDurationMs: 0 };
}

function createOperationState(): OperationState {
  return {
    retries: 0,
    queryExecution: emptyPhaseAggregate(),
  };
}

function isTraceContext(message: unknown): message is object {
  return typeof message === 'object' && message !== null;
}

function subscribeToQueryExecution(): void {
  tracingChannel('tracing:ydb:query.execute').subscribe({
    start(message) {
      const operation = operationStorage.getStore();
      if (operation && isTraceContext(message)) {
        queryTraces.set(message, { operation, startedAt: Date.now() });
      }
    },
    asyncStart(message) {
      if (!isTraceContext(message)) {
        return;
      }

      const trace = queryTraces.get(message);
      if (!trace) {
        return;
      }

      const durationMs = Math.max(0, Date.now() - trace.startedAt);
      const aggregate = trace.operation.queryExecution;
      aggregate.attempts += 1;
      aggregate.totalDurationMs += durationMs;
      aggregate.maxDurationMs = Math.max(aggregate.maxDurationMs, durationMs);
      queryTraces.delete(message);
    },
    end() {},
    asyncEnd() {},
    error() {},
  });
}

function subscribeToDiagnostics(): void {
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
  subscribeToQueryExecution();
  subscribed = true;
}

function queryFields(operation: OperationState): JsonObject {
  return {
    query_execute_attempts: operation.queryExecution.attempts,
    query_execute_duration_ms: operation.queryExecution.totalDurationMs,
    query_execute_max_duration_ms: operation.queryExecution.maxDurationMs,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
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
        if (!options.retryAbortOnce || !isAbortError(error)) {
          throw error;
        }

        operation.retries += 1;

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
      });
    }
    const queryDurationMs = operation.queryExecution.maxDurationMs;
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
    writeLog(logger, 'error', {
      event: 'ydb_operation_failed',
      operation: operationName,
      phase: 'client_preparation',
      duration_ms: Date.now() - startedAt,
      retry_attempts: 0,
      ...safeErrorFields(error, { fallbackCode: 'ydb_initialization_error' }),
    });
    throw error;
  }

  return observeYdbOperation(operationName, logger, callback, options);
}

export const _private = {
  createOperationState,
  isAbortError,
  queryFields,
  subscribeToDiagnostics,
  writeLog,
};
