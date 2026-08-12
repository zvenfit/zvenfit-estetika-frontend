'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(__dirname, 'upstream-parity.json');

function normalizeSha(value) {
  const sha = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : '';
}

function localHead(directory) {
  try {
    return normalizeSha(
      childProcess.execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return '';
  }
}

function resolveHead(environment = process.env) {
  const explicit = normalizeSha(environment.UPSTREAM_HEAD_SHA);
  if (explicit) {
    return { sha: explicit, source: 'UPSTREAM_HEAD_SHA' };
  }

  const directory = environment.ZVENFIT_FRONTEND_DIR || path.resolve(ROOT, '../zvenfit-frontend');
  const sha = localHead(directory);
  return sha ? { sha, source: directory } : { sha: '', source: directory };
}

function compare(baselineSha, currentSha) {
  const baseline = normalizeSha(baselineSha);
  const current = normalizeSha(currentSha);
  if (!baseline || !current) {
    return { ok: false, reason: 'invalid_sha' };
  }

  return baseline === current
    ? { ok: true, reason: 'current' }
    : { ok: false, reason: 'upstream_changed' };
}

function run(environment = process.env) {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const resolved = resolveHead(environment);
  if (!resolved.sha) {
    console.error(
      `upstream-parity: cannot resolve ${config.repository}@${config.branch}; set UPSTREAM_HEAD_SHA or ZVENFIT_FRONTEND_DIR`,
    );
    return 2;
  }

  const result = compare(config.baselineSha, resolved.sha);
  if (!result.ok) {
    console.error(
      `upstream-parity: audit required; baseline=${config.baselineSha.slice(0, 7)} current=${resolved.sha.slice(0, 7)} source=${resolved.source}`,
    );
    console.error(
      `upstream-parity: review https://github.com/${config.repository}/compare/${config.baselineSha}...${resolved.sha}`,
    );
    return 1;
  }

  console.log(
    `upstream-parity: OK (${config.repository}@${resolved.sha.slice(0, 7)}, audited ${config.auditedAt})`,
  );
  return 0;
}

if (require.main === module) {
  process.exitCode = run();
}

module.exports = { compare, normalizeSha, resolveHead, run };
