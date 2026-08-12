'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { compare, localBranchHead, normalizeSha } = require('../check-upstream-parity.cjs');

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

test('local parity resolves origin/main instead of the currently checked out feature branch', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zvenfit-parity-'));
  const git = (...args) =>
    childProcess.execFileSync('git', ['-C', directory, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  try {
    git('init', '-b', 'main');
    git('config', 'user.email', 'parity@example.invalid');
    git('config', 'user.name', 'Parity Test');
    fs.writeFileSync(path.join(directory, 'fixture.txt'), 'main\n');
    git('add', 'fixture.txt');
    git('commit', '-m', 'main');
    const mainSha = git('rev-parse', 'HEAD').trim();
    git('update-ref', 'refs/remotes/origin/main', mainSha);
    git('switch', '-c', 'feature');
    fs.writeFileSync(path.join(directory, 'fixture.txt'), 'feature\n');
    git('commit', '-am', 'feature');

    assert.deepEqual(localBranchHead(directory, 'main'), { sha: mainSha, ref: 'origin/main' });
    assert.notEqual(git('rev-parse', 'HEAD').trim(), mainSha);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
