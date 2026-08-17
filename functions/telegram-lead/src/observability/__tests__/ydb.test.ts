import assert from 'node:assert/strict';
import { tracingChannel } from 'node:diagnostics_channel';
import test from 'node:test';

import { observeYdbOperation, prepareAndObserveYdbOperation } from '../ydb';

import type { JsonObject, LoggerLike } from '../../types';

type TestPhase = 'query.execute' | 'query.session.acquire' | 'query.session.create';

function recordingLogger(records: Array<{ level: string; fields: JsonObject }>): LoggerLike {
  return {
    error(fields) { records.push({ level: 'error', fields }); },
    info(fields) { records.push({ level: 'info', fields }); },
    warn(fields) { records.push({ level: 'warn', fields }); },
  };
}

function fieldsByEvent(
  records: Array<{ level: string; fields: JsonObject }>,
  event: string,
): JsonObject {
  const record = records.find(item => item.fields.event === event);
  assert.ok(record, `${event} was not logged`);

  return record.fields;
}

async function tracePhase<T>(phase: TestPhase, callback: () => Promise<T>): Promise<T> {
  let result: T | undefined;
  await Promise.resolve(
    tracingChannel(`tracing:ydb:${phase}`).tracePromise(async () => {
      result = await callback();
    }, {}),
  );

  return result as T;
}

async function withSlowThreshold<T>(value: string, callback: () => Promise<T>): Promise<T> {
  const original = process.env.YDB_SLOW_OPERATION_MS;
  process.env.YDB_SLOW_OPERATION_MS = value;

  try {
    return await callback();
  } finally {
    if (original === undefined) {
      delete process.env.YDB_SLOW_OPERATION_MS;
    } else {
      process.env.YDB_SLOW_OPERATION_MS = original;
    }
  }
}

test('records YDB latency without query text or data', async () => {
  const records: Array<{ level: string; fields: JsonObject }> = [];
  const result = await observeYdbOperation('record_lead', recordingLogger(records), async () => 42);

  assert.equal(result, 42);
  assert.equal(records[0]?.fields.event, 'ydb_operation_completed');
  assert.equal(records[0]?.fields.operation, 'record_lead');
  assert.equal(typeof records[0]?.fields.duration_ms, 'number');
  assert.equal('query' in (records[0]?.fields || {}), false);
});

test('excludes client preparation from the observed business operation', async () => {
  const records: Array<{ level: string; fields: JsonObject }> = [];
  let prepared = false;

  const result = await prepareAndObserveYdbOperation(
    'list_telegram_candidates',
    recordingLogger(records),
    async () => {
      prepared = true;
    },
    async () => {
      assert.equal(prepared, true);
      return 42;
    },
  );

  assert.equal(result, 42);
  assert.equal(records[0]?.fields.event, 'ydb_operation_completed');
  assert.equal(records[0]?.fields.operation, 'list_telegram_candidates');
});

test('logs client preparation failures without treating cold-start time as slow query latency', async () => {
  const records: Array<{ level: string; fields: JsonObject }> = [];
  const error = Object.assign(new Error('private initialization details'), {
    code: 'UNAVAILABLE',
  });

  await assert.rejects(
    prepareAndObserveYdbOperation(
      'record_lead',
      recordingLogger(records),
      async () => {
        throw error;
      },
      async () => 42,
    ),
  );

  assert.equal(records.length, 1);
  assert.equal(records[0]?.fields.event, 'ydb_operation_failed');
  assert.equal(records[0]?.fields.operation, 'record_lead');
  assert.equal(records[0]?.fields.phase, 'client_preparation');
  assert.equal(records[0]?.fields.error_code, 'UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(records), /private initialization details/);
});

test('logs a safe error code without the database error message', async () => {
  const records: Array<{ level: string; fields: JsonObject }> = [];
  const error = Object.assign(new Error('contains private row data'), { code: 'OVERLOADED' });

  await assert.rejects(
    observeYdbOperation('record_lead', recordingLogger(records), async () => { throw error; }),
  );

  assert.equal(records[0]?.fields.event, 'ydb_operation_failed');
  assert.equal(records[0]?.fields.error_code, 'OVERLOADED');
  assert.equal(records[0]?.fields.error_type, 'Error');
  assert.equal(records[0]?.fields.retriable, true);
  assert.match(String(records[0]?.fields.stack_fingerprint), /^[a-f0-9]{16}$/);
  assert.doesNotMatch(JSON.stringify(records), /private row data/);
});

test('records query execution duration without logging SQL text or unstable session phases', async () => {
  const records: Array<{ level: string; fields: JsonObject }> = [];
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;

  try {
    await observeYdbOperation('list_telegram_candidates', recordingLogger(records), async () => {
      await tracePhase('query.session.acquire', async () => {
        await tracePhase('query.session.create', async () => {
          now += 700;
        });
      });
      await tracePhase('query.execute', async () => {
        now += 80;
      });
    });

    const completed = fieldsByEvent(records, 'ydb_operation_completed');
    assert.equal(completed.duration_ms, 780);
    assert.equal(completed.query_execute_duration_ms, 80);
    assert.equal(completed.query_execute_max_duration_ms, 80);
    assert.equal('session_acquire_duration_ms' in completed, false);
    assert.equal('session_create_duration_ms' in completed, false);
    assert.equal(JSON.stringify(completed).includes('SELECT'), false);
  } finally {
    Date.now = originalNow;
  }
});

test('ignores unstable session phase timings and does not treat them as slow queries', async () => {
  const records: Array<{ level: string; fields: JsonObject }> = [];
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;

  try {
    await withSlowThreshold('1000', () =>
      observeYdbOperation('list_telegram_candidates', recordingLogger(records), async () => {
        await tracePhase('query.session.acquire', async () => {
          await tracePhase('query.session.create', async () => {
            now += 7_600;
          });
        });
        await tracePhase('query.execute', async () => {
          now += 40;
        });
      }),
    );

    const completed = fieldsByEvent(records, 'ydb_operation_completed');
    assert.equal(completed.query_execute_duration_ms, 40);
    assert.equal('session_acquire_duration_ms' in completed, false);
    assert.equal(records.some(record => record.fields.event === 'ydb_slow_session_phase'), false);
    assert.equal(records.some(record => record.fields.event === 'ydb_slow_operation'), false);
  } finally {
    Date.now = originalNow;
  }
});

test('slow ExecuteQuery triggers the paging event with query-only latency', async () => {
  const records: Array<{ level: string; fields: JsonObject }> = [];
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;

  try {
    await withSlowThreshold('1000', () =>
      observeYdbOperation('record_newsletter_opt_in_request', recordingLogger(records), async () => {
        await tracePhase('query.session.acquire', async () => {
          now += 60;
        });
        await tracePhase('query.execute', async () => {
          now += 1_500;
        });
      }),
    );

    const slowQuery = fieldsByEvent(records, 'ydb_slow_operation');
    assert.equal(slowQuery.phase, 'query_execute');
    assert.equal(slowQuery.duration_ms, 1_500);
    assert.equal(slowQuery.total_duration_ms, 1_560);
    assert.equal(records.some(record => record.fields.event === 'ydb_slow_session_phase'), false);
  } finally {
    Date.now = originalNow;
  }
});
