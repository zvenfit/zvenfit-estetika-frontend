'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { compare, normalizeSha } = require('../check-upstream-parity.cjs');

const ROOT = path.resolve(__dirname, '../..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/upstream-parity.json'), 'utf8'));
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/upstream-parity.yml'), 'utf8');
const docs = fs.readFileSync(path.join(ROOT, 'docs/upstream-parity.md'), 'utf8');

test('parity baseline is a full commit SHA and exact comparison catches drift', () => {
  assert.equal(normalizeSha(config.baselineSha), config.baselineSha);
  assert.deepEqual(compare(config.baselineSha, config.baselineSha), { ok: true, reason: 'current' });
  assert.deepEqual(compare(config.baselineSha, 'a'.repeat(40)), {
    ok: false,
    reason: 'upstream_changed',
  });
});

test('scheduled check and audit instructions use the same upstream repository', () => {
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /UPSTREAM_HEAD_SHA/);
  assert.match(workflow, new RegExp(config.repository.replace('/', '\\/')));
  assert.match(docs, new RegExp(config.baselineSha));
  assert.match(docs, /не копируются автоматически/);
});
