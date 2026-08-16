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
