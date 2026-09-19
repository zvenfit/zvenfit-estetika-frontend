import assert from 'node:assert/strict';
import test from 'node:test';

import { memoryLogger, namedError, recordByEvent, tracePhase, type TestPhase } from './ydb-test-helpers';
import { observeYdbOperation } from '../ydb';

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

test('marks an unobserved session failure as unknown instead of inventing a query phase', async () => {
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
    { retryTransientOnce: true },
  );

  const recovered = recordByEvent(logger.records, 'ydb_retry');
  assert.equal(recovered.retry_source, 'read_fallback');
  assert.equal(recovered.error_type, 'TimeoutError');
  assert.equal(recovered.error_code, 'TimeoutError');
  assert.equal(recovered.phase, 'unknown');
  assert.equal('failed_phase_duration_ms' in recovered, false);
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
  assert.equal(session.phase, 'unknown');
  assert.equal('failed_phase_duration_ms' in session, false);
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
  }, { retryTransientOnce: true });

  const recovered = recordByEvent(logger.records, 'ydb_retry');
  assert.equal(attempts, 2);
  assert.equal(recovered.retry_source, 'read_fallback');
  assert.equal(recovered.phase, 'query_execute');
  assert.equal(typeof recovered.failed_phase_duration_ms, 'number');
  assert.equal(recovered.query_execute_attempts, 2);
  assert.equal(logger.records.filter(record => record.event === 'ydb_retry').length, 1);
  assert.doesNotMatch(JSON.stringify(logger.records), /private wrapper|details must not be logged/);
});
