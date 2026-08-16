import assert from 'node:assert/strict';
import test from 'node:test';

import { observeYdbOperation, prepareAndObserveYdbOperation } from '../ydb';

import type { JsonObject, LoggerLike } from '../../types';

function recordingLogger(records: Array<{ level: string; fields: JsonObject }>): LoggerLike {
  return {
    error(fields) { records.push({ level: 'error', fields }); },
    info(fields) { records.push({ level: 'info', fields }); },
    warn(fields) { records.push({ level: 'warn', fields }); },
  };
}

test('records YDB latency without query text or data', async () => {
  const records: Array<{ level: string; fields: JsonObject }> = [];
  const result = await observeYdbOperation('save_submission', recordingLogger(records), async () => 42);

  assert.equal(result, 42);
  assert.equal(records[0]?.fields.event, 'ydb_operation_completed');
  assert.equal(records[0]?.fields.operation, 'save_submission');
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
    observeYdbOperation('save_submission', recordingLogger(records), async () => { throw error; }),
  );

  assert.equal(records[0]?.fields.event, 'ydb_operation_failed');
  assert.equal(records[0]?.fields.error_code, 'OVERLOADED');
  assert.equal(records[0]?.fields.error_type, 'Error');
  assert.equal(records[0]?.fields.retriable, true);
  assert.match(String(records[0]?.fields.stack_fingerprint), /^[a-f0-9]{16}$/);
  assert.doesNotMatch(JSON.stringify(records), /private row data/);
});
