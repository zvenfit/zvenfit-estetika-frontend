import assert from 'node:assert/strict';
import test from 'node:test';

import { safeErrorFields } from '../errors';

test('extracts bounded operational fields without logging the error message', () => {
  const error = Object.assign(new Error('private payload: +79990000000'), {
    code: 'UPSTREAM TIMEOUT!',
    status: 503,
  });

  const fields = safeErrorFields(error, { fallbackCode: 'upstream_error' });

  assert.deepEqual(
    {
      error_type: fields.error_type,
      error_code: fields.error_code,
      retriable: fields.retriable,
      upstream_status: fields.upstream_status,
    },
    {
      error_type: 'Error',
      error_code: 'UPSTREAM_TIMEOUT_',
      retriable: true,
      upstream_status: 503,
    },
  );
  assert.match(String(fields.stack_fingerprint), /^[a-f0-9]{16}$/);
  assert.doesNotMatch(JSON.stringify(fields), /79990000000|private payload/);
});

test('uses stable fallbacks and allows an explicit retry decision', () => {
  assert.deepEqual(safeErrorFields('not-an-error', { fallbackCode: 'storage_error', retriable: false }), {
    error_type: 'UnknownError',
    error_code: 'storage_error',
    retriable: false,
    upstream_status: null,
    stack_fingerprint: null,
  });
});

test('derives only an allowlisted transient code from an error message', () => {
  const error = new Error(
    '/Ydb.Discovery.V1.DiscoveryService/ListEndpoints DEADLINE_EXCEEDED: private details',
  );
  error.name = 'ClientError';

  const fields = safeErrorFields(error, { fallbackCode: 'ydb_initialization_error' });

  assert.equal(fields.error_code, 'DEADLINE_EXCEEDED');
  assert.equal(fields.retriable, true);
  assert.doesNotMatch(JSON.stringify(fields), /private details|ListEndpoints/);
});

test('does not promote an arbitrary message into the safe error code', () => {
  const fields = safeErrorFields(new Error('private_token_123'), {
    fallbackCode: 'storage_error',
  });

  assert.equal(fields.error_code, 'storage_error');
  assert.doesNotMatch(JSON.stringify(fields), /private_token_123/);
});

test('preserves numeric YDB status codes without exposing issues', async () => {
  const { YDBError } = await import('@ydbjs/error');
  const error = new YDBError(400060, []);
  error.message = 'private query and parameters';

  const fields = safeErrorFields(error, { fallbackCode: 'ydb_error' });

  assert.equal(fields.error_code, 'OVERLOADED');
  assert.equal(fields.retriable, true);
  assert.doesNotMatch(JSON.stringify(fields), /private query|parameters|issues/);

  const aborted = safeErrorFields(new YDBError(400040, []), { fallbackCode: 'ydb_error' });
  assert.equal(aborted.error_code, 'ABORTED');
  assert.equal(aborted.retriable, true);
  const permanent = safeErrorFields(new YDBError(400020, []), { fallbackCode: 'ydb_error' });
  assert.equal(permanent.error_code, 'UNAUTHORIZED');
  assert.equal(permanent.retriable, false);
});

test('logs only known Telegram failure phases', () => {
  for (const phase of ['route_probe', 'send_message', 'private route details']) {
    const error = Object.assign(new Error('private token'), { telegram_phase: phase });
    const fields = safeErrorFields(error, { fallbackCode: 'telegram_timeout' });

    assert.equal(fields.telegram_phase, phase === 'private route details' ? undefined : phase);
    assert.doesNotMatch(JSON.stringify(fields), /private/);
  }
});
