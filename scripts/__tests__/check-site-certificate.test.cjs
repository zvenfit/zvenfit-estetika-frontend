'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { checkExpiry } = require('../check-site-certificate.cjs');

test('the public certificate must have at least 21 days left, including the exact boundary', () => {
  const now = Date.UTC(2026, 10, 1);
  const boundary = Date.UTC(2026, 10, 22);
  assert.match(checkExpiry(new Date(boundary), now), /21 full days left/);
  assert.throws(() => checkExpiry(new Date(boundary - 1), now), /minimum is 21 days/);
  assert.throws(() => checkExpiry(new Date(now - 1), now), /minimum is 21 days/);
});

test('a missing or invalid certificate expiry fails the check', () => {
  for (const value of [undefined, new Date(NaN)]) {
    assert.throws(() => checkExpiry(value), /valid certificate expiry date/);
  }
});
