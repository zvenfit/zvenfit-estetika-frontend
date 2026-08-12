import assert from 'node:assert/strict';
import test from 'node:test';

import { _private } from '../context';

test('unwraps the first YDB result set', () => {
  assert.deepEqual(_private.firstResultSet([[{ id: 'one' }], [{ id: 'two' }]]), [{ id: 'one' }]);
  assert.deepEqual(_private.firstResultSet(undefined), []);
});
