import assert from 'node:assert/strict';
import test from 'node:test';

import { readRetryDelayMs } from '../read-retry-policy';

test('backs off short failures and caps later delays without a three-attempt cutoff', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 20].map(attempt => readRetryDelayMs(attempt, 0)),
    [500, 1000, 2000, 2000, 2000],
  );
  for (const attempt of [0, 1, 2, 3, 20]) {
    const minimum = readRetryDelayMs(attempt, 0);
    const jittered = readRetryDelayMs(attempt, 0.999);
    assert.ok(jittered >= minimum);
    assert.ok(jittered < minimum * 1.5);
    assert.ok(jittered < 3000);
  }
});
