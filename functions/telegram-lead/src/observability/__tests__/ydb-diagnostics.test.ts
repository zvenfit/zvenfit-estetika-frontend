import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { memoryLogger, namedError, recordByEvent, tracePhase, type TestPhase } from './ydb-test-helpers';
import { observeYdbOperation } from '../ydb';
import { sdkTestDriver } from '../../ydb/__tests__/sdk-test-driver';

test('recovers real SDK CreateSession deadlines and keeps their exact failing trace', async context => {
  context.mock.method(Math, 'random', () => 0);
  const logger = memoryLogger();
  let creates = 0;
  const fixture = await sdkTestDriver(async () => {}, 1, async () => {
    creates += 1;
    if (creates <= 2) throw namedError('ClientError', 4);
  });
  try {
    await observeYdbOperation('list_telegram_candidates', logger,
      async signal => fixture.sql`SELECT 1;`.idempotent(true).signal(signal).timeout(1_000),
      { readRetry: { budgetMs: 2_000 } },
    );
    const recovered = recordByEvent(logger.records, 'ydb_retry');
    assert.equal(creates, 3);
    assert.equal(recovered.retry_attempts, 2);
    assert.equal(recovered.error_code, 'DEADLINE_EXCEEDED');
    assert.equal(recovered.phase, 'session_create');
    assert.equal(recovered.phase_source, 'error_trace');
    assert.equal(recovered.query_execute_attempts, 1);
    assert.equal('session_create_duration_ms' in recovered, false);
    assert.doesNotMatch(JSON.stringify(logger.records), /details must not be logged/);
  } finally {
    await fixture.close();
  }
});

test('final real SDK CreateSession deadlines retain the failure phase without a recovered event', async context => {
  context.mock.method(Math, 'random', () => 0);
  const logger = memoryLogger();
  let creates = 0;
  const fixture = await sdkTestDriver(async () => assert.fail('SQL must not execute'), 1, async () => {
    creates += 1;
    throw namedError('ClientError', 4);
  });
  try {
    await assert.rejects(observeYdbOperation('list_telegram_candidates', logger,
      async signal => fixture.sql`SELECT 1;`.idempotent(true).signal(signal).timeout(1_000),
      { readRetry: { budgetMs: 2_000 } },
    ), { code: 4 });
    const failure = recordByEvent(logger.records, 'ydb_operation_failed');
    assert.equal(creates, 3);
    assert.equal(failure.retry_attempts, 2);
    assert.equal(failure.error_code, 'DEADLINE_EXCEEDED');
    assert.equal(failure.phase, 'session_create');
    assert.equal(failure.phase_source, 'error_trace');
    assert.equal(failure.query_execute_attempts, 0);
    assert.equal(logger.records.some(record => record.event === 'ydb_retry'), false);
  } finally {
    await fixture.close();
  }
});

test('keeps the prior error when a deadline interrupts the next read', async context => {
  context.mock.method(Math, 'random', () => 0);
  const logger = memoryLogger();
  const prior = namedError('ClientError', 'UNAVAILABLE');
  let attempts = 0;
  await assert.rejects(observeYdbOperation('list_telegram_candidates', logger, async signal => {
    attempts += 1;
    if (attempts === 1) throw prior;
    return new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }, { readRetry: { budgetMs: 350 } }), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.cause, undefined);
    return true;
  });
  const failure = recordByEvent(logger.records, 'ydb_operation_failed');
  assert.equal(attempts, 2);
  assert.equal(failure.error_code, 'ydb_read_budget_exhausted');
  assert.equal(failure.retriable, true);
  assert.equal(failure.retry_attempts, 1);
  assert.equal((failure.prior_error as { error_code: string }).error_code, 'UNAVAILABLE');
  assert.equal(logger.records.some(record => record.event === 'ydb_retry'), false);
  assert.doesNotMatch(JSON.stringify(logger.records), /details must not be logged/);
});

test('keeps the prior error without counting an interrupted backoff as a retry', async context => {
  const logger = memoryLogger();
  let now = 0;
  context.mock.method(performance, 'now', () => now);
  context.mock.method(Math, 'random', () => 0);
  let attempts = 0;
  await assert.rejects(observeYdbOperation('get_telegram_queue_health', logger, async () => {
    attempts += 1;
    // Simulate the event loop resuming after the shared deadline during backoff.
    setImmediate(() => { now = 2_001; });
    throw namedError('ClientError', 'UNAVAILABLE');
  }, { readRetry: { budgetMs: 2_000 } }), { code: 'ydb_read_budget_exhausted' });
  const failure = recordByEvent(logger.records, 'ydb_operation_failed');
  assert.equal(attempts, 1);
  assert.equal(failure.retry_attempts, 0);
  assert.equal((failure.prior_error as { error_code: string }).error_code, 'UNAVAILABLE');
});

test('a prior transient failure cannot change the next permanent error', async context => {
  context.mock.method(Math, 'random', () => 0);
  const logger = memoryLogger();
  let attempts = 0;
  await assert.rejects(observeYdbOperation('list_telegram_candidates', logger, async () => {
    attempts += 1;
    throw namedError('ClientError', attempts === 1 ? 'UNAVAILABLE' : 'PERMISSION_DENIED');
  }, { readRetry: { budgetMs: 2_000 } }), { code: 'PERMISSION_DENIED' });
  const failure = recordByEvent(logger.records, 'ydb_operation_failed');
  assert.equal(attempts, 2);
  assert.equal(failure.error_code, 'PERMISSION_DENIED');
  assert.equal(failure.retriable, false);
  assert.equal((failure.prior_error as { error_code: string }).error_code, 'UNAVAILABLE');
});

test('captures the active query when SDK timeout wins the race against its trace', async () => {
  const { retry } = await import('@ydbjs/retry');
  const logger = memoryLogger();
  const deadline = new AbortController();
  const timeout = new DOMException('private timeout reason', 'TimeoutError');
  let unwind: () => void = () => {};
  let attempts = 0;
  try {
    await observeYdbOperation(
      'list_telegram_candidates',
      logger,
      async () => {
        attempts += 1;
        if (attempts > 1) {
          return 'ok';
        }

        return retry({ signal: deadline.signal }, () =>
          tracePhase(
            'query.execute',
            () =>
              new Promise<never>((_, reject) => {
                unwind = () => reject(new DOMException('private late unwind', 'AbortError'));
                queueMicrotask(() => deadline.abort(timeout));
              }),
          ),
        );
      },
      { readRetry: { budgetMs: 2_000 } },
    );

    const recovered = recordByEvent(logger.records, 'ydb_retry');
    assert.equal(recovered.error_code, 'TimeoutError');
    assert.equal(recovered.phase, 'query_execute');
    assert.equal(recovered.phase_source, 'active_trace');
    assert.equal(typeof recovered.failed_phase_duration_ms, 'number');
    assert.equal(recovered.retry_source, 'read_fallback');
    assert.doesNotMatch(JSON.stringify(logger.records), /private/);
  } finally {
    unwind();
    await new Promise(resolve => setImmediate(resolve));
  }
});

test('does not attribute a later session timeout to a cancelled query still unwinding', async () => {
  const { retry } = await import('@ydbjs/retry');
  const logger = memoryLogger();
  const unwinds: (() => void)[] = [];
  let attempts = 0;
  try {
    await observeYdbOperation(
      'list_telegram_candidates',
      logger,
      async () => {
        attempts += 1;
        if (attempts === 3) {
          return 'ok';
        }
        const deadline = new AbortController();
        const phase = attempts === 1 ? 'query.execute' : 'query.session.create';

        return retry({ signal: deadline.signal }, () =>
          tracePhase(
            phase,
            () =>
              new Promise<never>((_, reject) => {
                unwinds.push(() => reject(new DOMException('private unwind', 'AbortError')));
                queueMicrotask(() => deadline.abort(new DOMException('private reason', 'TimeoutError')));
              }),
          ),
        );
      },
      { readRetry: { budgetMs: 2_000 } },
    );
    const recovered = recordByEvent(logger.records, 'ydb_retry');
    assert.equal(recovered.retry_attempts, 2);
    assert.equal(recovered.phase, 'session_create');
    assert.equal(recovered.phase_source, 'active_trace');
  } finally {
    unwinds.forEach(unwind => unwind());
    await new Promise(resolve => setImmediate(resolve));
  }
});

test('the shared deadline reaches a real SDK query while CreateSession is in flight', async () => {
  const { query } = await import('@ydbjs/query');
  const logger = memoryLogger();
  let rpcSignal: AbortSignal | undefined;
  const driver = {
    identity: {},
    async ready() {},
    createClient() {
      return {
        createSession(_request: unknown, { signal }: { signal: AbortSignal }) {
          rpcSignal = signal;

          return new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      };
    },
  };
  const sql = query(driver as unknown as Parameters<typeof query>[0]);
  try {
    await assert.rejects(
      observeYdbOperation(
        'list_telegram_candidates',
        logger,
        async signal => sql`SELECT 1;`.idempotent(true).signal(signal).timeout(1_000),
        { readRetry: { budgetMs: 30 } },
      ),
      { code: 'ydb_read_budget_exhausted' },
    );
    assert.equal(rpcSignal?.aborted, true);
    const failure = recordByEvent(logger.records, 'ydb_operation_failed');
    assert.equal(failure.phase, 'session_create');
    assert.equal(failure.error_code, 'ydb_read_budget_exhausted');
    assert.equal(failure.retriable, true);
    assert.equal(failure.retry_attempts, 0);
    assert.equal(
      logger.records.some(record => record.event === 'ydb_operation_completed'),
      false,
    );
  } finally {
    await sql[Symbol.asyncDispose]();
  }
});

for (const metadataCompletes of [false, true]) {
  test(`a ${metadataCompletes ? 'completed' : 'stalled'} metadata-token retry preserves CreateSession`, async context => {
    const { query } = await import('@ydbjs/query');
    const { MetadataCredentialsProvider } = await import('@ydbjs/auth/metadata');
    const logger = memoryLogger();
    let metadataSignal: AbortSignal | undefined;
    let tokenFetched = false;
    context.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
      const signal = options.signal;
      assert.ok(signal);
      metadataSignal = signal;
      if (metadataCompletes) {
        return new Response(JSON.stringify({ access_token: 'synthetic-token', expires_in: 3_600 }));
      }

      return new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const credentials = new MetadataCredentialsProvider({ endpoint: 'http://synthetic.invalid/token' });
    const driver = {
      identity: {},
      async ready() {},
      createClient() {
        return {
          async createSession(_request: unknown, { signal }: { signal: AbortSignal }) {
            await credentials.getToken(false, signal);
            tokenFetched = true;

            return new Promise<never>((_, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
          },
        };
      },
    };
    const sql = query(driver as unknown as Parameters<typeof query>[0]);
    try {
      await assert.rejects(
        observeYdbOperation(
          'list_telegram_candidates',
          logger,
          async signal => sql`SELECT 1;`.idempotent(true).signal(signal).timeout(1_000),
          { readRetry: { budgetMs: 30 } },
        ),
        { code: 'ydb_read_budget_exhausted' },
      );
      assert.equal(metadataSignal?.aborted, true);
      assert.equal(tokenFetched, metadataCompletes);
      const failure = recordByEvent(logger.records, 'ydb_operation_failed');
      assert.equal(failure.phase, 'session_create');
      assert.equal(typeof failure.failed_phase_duration_ms, 'number');
      assert.equal(failure.retriable, true);
    } finally {
      await sql[Symbol.asyncDispose]();
    }
  });
}

test('final failures retain the innermost phase and never become a recovered event', async () => {
  const logger = memoryLogger();
  await assert.rejects(
    observeYdbOperation(
      'list_telegram_candidates',
      logger,
      () =>
        tracePhase('query.session.acquire', () =>
          tracePhase('query.session.create', async () => {
            throw namedError('ClientError', 4);
          }),
        ),
      { readRetry: { budgetMs: 2_000 } },
    ),
  );
  const failure = recordByEvent(logger.records, 'ydb_operation_failed');
  assert.equal(failure.retry_attempts, 2);
  assert.equal(failure.phase, 'session_create');
  assert.equal(failure.phase_source, 'error_trace');
  assert.equal(failure.error_code, 'DEADLINE_EXCEEDED');
  assert.equal(
    logger.records.some(record => record.event === 'ydb_retry'),
    false,
  );
});

test('correlates an SDK deadline with its active trace despite a distinct transport error', async () => {
  const { retry } = await import('@ydbjs/retry');
  const { throwIfAborted } = await import('abort-controller-x');
  const logger = memoryLogger();
  const deadline = AbortSignal.timeout(10);
  let attempts = 0;
  let sdkError: unknown;
  let transportError: unknown;
  let transportFinished: Promise<void> | undefined;

  await observeYdbOperation('list_telegram_candidates', logger, async () => {
    attempts += 1;
    if (attempts > 1) return;

    try {
      await retry({ signal: deadline, retry: true, budget: 2, strategy: 0 }, signal => {
        const query = tracePhase('query.execute', async () => {
          try {
            await setTimeout(60_000, undefined, { signal });
          } finally {
            // nice-grpc replaces cancellation with a fresh AbortError, without cause.
            throwIfAborted(signal);
          }
        });
        transportFinished = query.then(() => {}, error => { transportError = error; });
        return query;
      });
    } catch (error) {
      sdkError = error;
      throw error;
    }
  }, { readRetry: { budgetMs: 2_000 } });
  await transportFinished;

  assert.equal(attempts, 2);
  assert.equal(sdkError, deadline.reason);
  assert.ok(transportError instanceof Error);
  assert.equal(transportError.name, 'AbortError');
  assert.notEqual(transportError, sdkError);
  assert.equal(transportError.cause, undefined);
  const recovered = recordByEvent(logger.records, 'ydb_retry');
  assert.equal(recovered.error_code, 'TimeoutError');
  assert.equal(recovered.retriable, true);
  assert.equal(recovered.retry_source, 'read_fallback');
  assert.equal(recovered.phase, 'query_execute');
  assert.equal(recovered.phase_source, 'active_trace');
  assert.equal(typeof recovered.failed_phase_duration_ms, 'number');
});

test('captures the real SDK retry cause and failed query phase even with zero backoff', async () => {
  const { retry } = await import('@ydbjs/retry');
  const logger = memoryLogger();
  const originalNow = Date.now;
  let now = 1_000;
  let attempts = 0;
  Date.now = () => now;

  try {
    const result = await observeYdbOperation('list_telegram_candidates', logger, () =>
      retry({ retry: true, budget: 2, strategy: 0, idempotent: true }, () =>
        tracePhase('query.execute', async () => {
          attempts += 1;
          now += attempts === 1 ? 1_100 : 50;
          if (attempts === 1) {
            throw Object.assign(new Error('SELECT private payload and secret'), { code: 14 });
          }

          return 'ok';
        }),
      ),
    );

    assert.equal(result, 'ok');
    const recovered = recordByEvent(logger.records, 'ydb_retry');
    assert.equal(recovered.retry_attempts, 1);
    assert.equal(recovered.retry_source, 'sdk');
    assert.equal(recovered.error_code, 'UNAVAILABLE');
    assert.equal(recovered.retriable, true);
    assert.equal(recovered.phase, 'query_execute');
    assert.equal(recovered.failed_phase_duration_ms, 1_100);
    assert.equal(recovered.duration_ms, 1_150);
    assert.equal(recovered.query_execute_attempts, 2);
    assert.equal(logger.records.filter(record => record.event === 'ydb_retry').length, 1);
    assert.doesNotMatch(JSON.stringify(logger.records), /SELECT|private payload|secret/);
  } finally {
    Date.now = originalNow;
  }
});

test('locates a session failure without adding session latency aggregates', async () => {
  const logger = memoryLogger();
  let attempts = 0;

  await observeYdbOperation(
    'list_telegram_candidates',
    logger,
    async () => {
      attempts += 1;
      await tracePhase('query.session.acquire', () =>
        tracePhase('query.session.create', async () => {
          if (attempts === 1) {
            throw namedError('TimeoutError');
          }
        }),
      );
    },
    { readRetry: { budgetMs: 2_000 } },
  );

  const recovered = recordByEvent(logger.records, 'ydb_retry');
  assert.equal(recovered.retry_source, 'read_fallback');
  assert.equal(recovered.error_type, 'TimeoutError');
  assert.equal(recovered.error_code, 'TimeoutError');
  assert.equal(recovered.phase, 'session_create');
  assert.equal(recovered.phase_source, 'error_trace');
  assert.equal(typeof recovered.failed_phase_duration_ms, 'number');
  assert.equal('session_create_duration_ms' in recovered, false);
  assert.doesNotMatch(JSON.stringify(logger.records), /details must not be logged/);
});

test('keeps retry causes isolated between concurrent operations', async () => {
  const { retry } = await import('@ydbjs/retry');
  const run = async (operation: string, code: number, phase: TestPhase) => {
    const logger = memoryLogger();
    let attempts = 0;
    await observeYdbOperation(operation, logger, () =>
      retry({ retry: true, budget: 2, strategy: 0 }, () =>
        tracePhase(phase, async () => {
          await Promise.resolve();
          attempts += 1;
          if (attempts === 1) {
            throw Object.assign(new Error('private details'), { code });
          }
        }),
      ),
    );

    return recordByEvent(logger.records, 'ydb_retry');
  };

  const [query, session] = await Promise.all([
    run('list_telegram_candidates', 14, 'query.execute'),
    run('get_telegram_queue_health', 8, 'query.session.acquire'),
  ]);
  assert.equal(query.error_code, 'UNAVAILABLE');
  assert.equal(query.phase, 'query_execute');
  assert.equal(session.error_code, 'RESOURCE_EXHAUSTED');
  assert.equal(session.phase, 'session_acquire');
  assert.equal(session.phase_source, 'error_trace');
});

test('preserves the query phase of a wrapped error recovered by the read fallback', async () => {
  const logger = memoryLogger();
  let attempts = 0;

  await observeYdbOperation('list_telegram_candidates', logger, async () => {
    attempts += 1;
    try {
      await tracePhase('query.execute', async () => {
        if (attempts === 1) throw namedError('TimeoutError');
      });
    } catch (cause) {
      throw Object.assign(new Error('private wrapper'), { cause });
    }
  }, { readRetry: { budgetMs: 2_000 } });

  const recovered = recordByEvent(logger.records, 'ydb_retry');
  assert.equal(attempts, 2);
  assert.equal(recovered.retry_source, 'read_fallback');
  assert.equal(recovered.phase, 'query_execute');
  assert.equal(typeof recovered.failed_phase_duration_ms, 'number');
  assert.equal(recovered.query_execute_attempts, 2);
  assert.equal(logger.records.filter(record => record.event === 'ydb_retry').length, 1);
  assert.doesNotMatch(JSON.stringify(logger.records), /private wrapper|details must not be logged/);
});
