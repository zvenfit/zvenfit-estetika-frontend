import { AsyncLocalStorage } from 'node:async_hooks';
import { channel, tracingChannel } from 'node:diagnostics_channel';

import { errorChain, safeErrorFields } from './errors';

import type { JsonObject } from '../types';

export interface OperationState {
  retries: number;
  phases: Record<'query_execute', PhaseAggregate>;
  phaseFailures: WeakMap<object, PhaseFailure>;
  activePhases: Set<PhaseTrace>;
  priorReadFailure?: JsonObject;
  pendingSdkFailure?: JsonObject;
  retryFailure?: JsonObject;
}

// Session traces locate failures only; latency aggregates and alerts remain query-only.
export type YdbPhase = 'query_execute' | 'session_acquire' | 'session_create';

interface PhaseAggregate {
  attempts: number;
  maxDurationMs: number;
  totalDurationMs: number;
}

interface PhaseTrace {
  operation: OperationState;
  phase: YdbPhase;
  startedAt: number;
  attempt?: RetryAttempt;
}

interface RetryAttempt {
  active: boolean;
  parent?: RetryAttempt;
}

interface PhaseFailure {
  phase: YdbPhase;
  durationMs: number;
  source: 'error_trace' | 'active_trace';
}

export const operationStorage = new AsyncLocalStorage<OperationState>();
const retryAttemptStorage = new AsyncLocalStorage<RetryAttempt>();
const retryAttempts = new WeakMap<object, RetryAttempt>();
const phaseTraces = new WeakMap<object, PhaseTrace>();
let subscribed = false;

function emptyPhaseAggregate(): PhaseAggregate {
  return { attempts: 0, maxDurationMs: 0, totalDurationMs: 0 };
}

export function createOperationState(): OperationState {
  return {
    retries: 0,
    phaseFailures: new WeakMap(),
    activePhases: new Set(),
    phases: {
      query_execute: emptyPhaseAggregate(),
    },
  };
}

function isTraceContext(message: unknown): message is object {
  return typeof message === 'object' && message !== null;
}

function isAttemptActive(attempt: RetryAttempt | undefined): boolean {
  for (let current = attempt; current; current = current.parent) {
    if (!current.active) {
      return false;
    }
  }

  return true;
}

function subscribeToPhase(channelName: string, phase: YdbPhase): void {
  tracingChannel(channelName).subscribe({
    start(message) {
      const operation = operationStorage.getStore();
      if (operation && isTraceContext(message)) {
        const trace = { operation, phase, startedAt: Date.now(), attempt: retryAttemptStorage.getStore() };
        phaseTraces.set(message, trace);
        if (isAttemptActive(trace.attempt)) {
          operation.activePhases.add(trace);
        }
      }
    },
    asyncStart(message) {
      if (!isTraceContext(message)) {
        return;
      }

      const trace = phaseTraces.get(message);
      if (!trace) {
        return;
      }

      const durationMs = Math.max(0, Date.now() - trace.startedAt);
      trace.operation.activePhases.delete(trace);
      if (trace.phase === 'query_execute') {
        const aggregate = trace.operation.phases.query_execute;
        aggregate.attempts += 1;
        aggregate.totalDurationMs += durationMs;
        aggregate.maxDurationMs = Math.max(aggregate.maxDurationMs, durationMs);
      }
    },
    end() {},
    asyncEnd(message) {
      if (isTraceContext(message)) {
        phaseTraces.delete(message);
      }
    },
    error(message) {
      if (!isTraceContext(message) || !('error' in message) || !isTraceContext(message.error)) {
        return;
      }

      const trace = phaseTraces.get(message);
      // Nested acquisition/creation traces can report the same error. Keep
      // the innermost failing phase, without retaining SQL or SDK context.
      if (trace && !trace.operation.phaseFailures.has(message.error)) {
        trace.operation.phaseFailures.set(message.error, {
          phase: trace.phase,
          durationMs: Math.max(0, Date.now() - trace.startedAt),
          source: 'error_trace',
        });
      }
    },
  });
}

export function subscribeToDiagnostics(): void {
  if (subscribed) {
    return;
  }

  channel('ydb:retry.attempt.completed').subscribe(message => {
    const operation = operationStorage.getStore();
    const outcome =
      typeof message === 'object' && message !== null && 'outcome' in message ? message.outcome : undefined;

    if (operation && outcome === 'retried') {
      operation.retries += 1;
      operation.retryFailure = operation.pendingSdkFailure ?? retryErrorFields(operation, undefined, 'sdk');
    }
    if (operation) {
      operation.pendingSdkFailure = undefined;
    }
  });
  // The completed channel has only an outcome/count. Its matching tracing
  // error channel carries the cause, including retries with no backoff.
  const retryChannel = tracingChannel<RetryAttempt>('tracing:ydb:retry.attempt');
  retryChannel.start.bindStore(retryAttemptStorage, message => {
    const attempt = { active: true, parent: retryAttemptStorage.getStore() };
    retryAttempts.set(message, attempt);

    return attempt;
  });
  retryChannel.subscribe({
    start() {},
    end() {},
    asyncStart(message) {
      const attempt = isTraceContext(message) ? retryAttempts.get(message) : undefined;
      if (attempt) {
        attempt.active = false;
      }
      // Retire only this attempt and its descendants, after its error snapshot.
      // Nested credentials retries must preserve their outer SQL/session phase;
      // cancelled RPCs must not contaminate a later attempt while unwinding.
      const operation = operationStorage.getStore();
      for (const trace of operation?.activePhases ?? []) {
        if (!isAttemptActive(trace.attempt)) {
          operation?.activePhases.delete(trace);
        }
      }
    },
    asyncEnd(message) {
      if (isTraceContext(message)) {
        retryAttempts.delete(message);
      }
    },
    error(message) {
      const operation = operationStorage.getStore();
      if (operation && isTraceContext(message) && 'error' in message) {
        operation.pendingSdkFailure = retryErrorFields(operation, message.error, 'sdk');
      }
    },
  });
  subscribeToPhase('tracing:ydb:query.execute', 'query_execute');
  subscribeToPhase('tracing:ydb:query.session.acquire', 'session_acquire');
  subscribeToPhase('tracing:ydb:query.session.create', 'session_create');
  subscribed = true;
}

export function phaseFields(operation: OperationState): JsonObject {
  return {
    query_execute_attempts: operation.phases.query_execute.attempts,
    query_execute_duration_ms: operation.phases.query_execute.totalDurationMs,
    query_execute_max_duration_ms: operation.phases.query_execute.maxDurationMs,
  };
}

export function retryErrorFields(
  operation: OperationState,
  error: unknown,
  source: 'sdk' | 'read_fallback',
): JsonObject {
  return {
    ...safeErrorFields(error, { fallbackCode: 'ydb_retry_cause_unavailable', retriable: true }),
    retry_source: source,
    ...failurePhaseFields(operation, error),
  };
}

export function failurePhaseFields(operation: OperationState, error: unknown): JsonObject {
  let failure = errorChain(error)
    .map(item => operation.phaseFailures.get(item as object))
    .find(item => item !== undefined);
  const cancellation = errorChain(error).some(
    item => item instanceof Error && (item.name === 'TimeoutError' || item.name === 'AbortError'),
  );

  if (!failure && cancellation && isTraceContext(error)) {
    // SDK abortable() can reject before ExecuteQuery/Session.open unwinds.
    // Snapshot the innermost active trace at cancellation, rather than guessing
    // from completed durations (which may belong to an earlier attempt).
    const rank: Record<YdbPhase, number> = { session_acquire: 0, session_create: 1, query_execute: 2 };
    const active = [...operation.activePhases]
      .filter(trace => isAttemptActive(trace.attempt))
      .sort((a, b) => rank[b.phase] - rank[a.phase])[0];
    if (active) {
      failure = { phase: active.phase, durationMs: Math.max(0, Date.now() - active.startedAt), source: 'active_trace' };
      operation.phaseFailures.set(error, failure);
    }
  }

  return {
    phase: failure?.phase ?? 'unknown',
    ...(failure ? { phase_source: failure.source, failed_phase_duration_ms: failure.durationMs } : {}),
  };
}
