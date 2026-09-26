import assert from 'node:assert/strict';
import test from 'node:test';

import { QueueReadUnavailableError } from '../../application/queue-read-unavailable';
import { readQueue } from '../queue-read';
import { runReadOnlyYdbOperation } from '../read-operation';
import { memoryLogger, recordByEvent, tracePhase } from '../../observability/__tests__/ydb-test-helpers';

test('translates only positively identified temporary read failures to the storage port', async () => {
  const errors = [
    Object.assign(new Error('private'), { code: 4 }),
    Object.assign(new Error('private'), { code: 'UNAVAILABLE' }),
    Object.assign(new Error('private'), { code: 400060 }),
    new DOMException('private', 'TimeoutError'),
    Object.assign(new Error('budget'), { code: 'ydb_read_budget_exhausted' }),
  ];
  for (const error of errors) {
    await assert.rejects(
      readQueue(async () => {
        throw error;
      }),
      candidate => candidate instanceof QueueReadUnavailableError && candidate.cause === error,
    );
  }
  assert.equal(await readQueue(async () => 'healthy'), 'healthy');
});

test('deadline during backoff preserves an unknown cause and does not hide it as a deferred pass', async context => {
  const logger = memoryLogger();
  let now = 0;
  let attempts = 0;
  context.mock.method(performance, 'now', () => now);
  context.mock.method(Math, 'random', () => 0);
  const unknown = Object.assign(new Error('private DEADLINE_EXCEEDED text'), { name: 'ClientError' });
  await assert.rejects(readQueue(() => runReadOnlyYdbOperation(
    'list_telegram_candidates', logger, async () => {}, async () => {
      attempts += 1;
      setImmediate(() => { now = 2_001; });
      return tracePhase('query.session.create', async () => { throw unknown; });
    }, 2_000,
  )), error => {
    assert.ok(error instanceof Error);
    assert.equal(error instanceof QueueReadUnavailableError, false);
    assert.equal((error as NodeJS.ErrnoException).code, 'ydb_read_budget_exhausted');
    assert.equal(error.cause, unknown);
    return true;
  });
  assert.equal(attempts, 1);
  const failure = recordByEvent(logger.records, 'ydb_operation_failed');
  assert.equal(failure.retry_attempts, 0);
  assert.equal((failure.prior_error as { error_type: string }).error_type, 'ClientError');
  assert.equal((failure.prior_error as { phase: string }).phase, 'session_create');
  assert.equal(failure.phase, 'unknown');
  assert.doesNotMatch(JSON.stringify(logger.records), /private/);
});

test('known preparation failures are translated only at the queue read boundary', async () => {
  for (const error of [Object.assign(new Error('private'), { code: 14 }), new TypeError('bad configuration')]) {
    const logger = memoryLogger();
    await assert.rejects(readQueue(() => runReadOnlyYdbOperation(
      'get_telegram_queue_health', logger, async () => { throw error; },
      async () => assert.fail('Query must not run after preparation failure'), 2_000,
    )), candidate => error instanceof TypeError
      ? candidate === error
      : candidate instanceof QueueReadUnavailableError && candidate.cause === error);
    assert.equal(recordByEvent(logger.records, 'ydb_operation_failed').phase, 'client_preparation');
  }
});

test('unknown, permanent, and ambiguous errors remain visible as runtime failures', async () => {
  const permanent = Object.assign(new Error('DEADLINE_EXCEEDED'), { code: 'PERMISSION_DENIED' });
  const unknown = Object.assign(new Error('DEADLINE_EXCEEDED'), { name: 'ClientError' });
  for (const error of [
    permanent,
    unknown,
    new TypeError('bug'),
    Object.assign(new Error('wrapper', { cause: permanent }), { name: 'TimeoutError' }),
    Object.assign(new Error('budget', { cause: unknown }), { code: 'ydb_read_budget_exhausted' }),
  ]) {
    await assert.rejects(
      readQueue(async () => {
        throw error;
      }),
      candidate => candidate === error,
    );
  }
});
