'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('compiled CommonJS entrypoint exports the cloud handler', () => {
  const artifact = require('../../build/index.js');

  assert.equal(typeof artifact.handler, 'function');
});
