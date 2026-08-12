'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const deployScript = fs.readFileSync(path.join(ROOT, 'scripts/deploy-telegram-lead.sh'), 'utf8');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/main.yml'), 'utf8');

test('production deploy jobs wait for quality checks', () => {
  const quality = workflow.indexOf('  quality-checks:');
  const preflight = workflow.indexOf('  deploy-preflight:');
  const functionDeploy = workflow.indexOf('  deploy-function:');
  const siteDeploy = workflow.indexOf('  deploy-site:');

  assert.equal(quality >= 0, true);
  assert.equal(preflight > quality, true);
  assert.equal(functionDeploy > preflight, true);
  assert.equal(siteDeploy > functionDeploy, true);
  const functionJob = workflow.slice(functionDeploy, siteDeploy);
  assert.match(functionJob, /needs: \[quality-checks, deploy-preflight\]/);
  assert.match(functionJob, /environment: production/);
});

test('deploy fails fast on missing configuration and smoke-checks production', () => {
  assert.match(workflow, /deploy-preflight:[\s\S]*node scripts\/check-deploy-config\.cjs/);
  assert.match(workflow, /Smoke production deployment[\s\S]*node scripts\/smoke-production\.cjs/);
});

test('function deploy integration-tests and verifies the pre-provisioned schema before creating a version', () => {
  const integration = deployScript.indexOf('run test:integration');
  const schemaVerification = deployScript.indexOf('run verify:schema');
  const deploy = deployScript.indexOf('yc serverless function version create');

  assert.equal(integration >= 0, true);
  assert.equal(schemaVerification > integration, true);
  assert.equal(deploy > schemaVerification, true);
  assert.doesNotMatch(deployScript, /run migrate/);
});

test('deployment package contains compiled runtime modules only', () => {
  assert.match(deployScript, /telegram-lead\/build\/\./);
  assert.match(deployScript, /npm pkg delete devDependencies/);
  assert.doesNotMatch(deployScript, /submission-store\.js/);
});

test('Telegram retry settings fit inside the Cloud Function timeout', () => {
  assert.match(deployScript, /TELEGRAM_RETRY_BATCH_SIZE="\$\{TELEGRAM_RETRY_BATCH_SIZE:-5\}"/);
  assert.match(deployScript, /TELEGRAM_TIMEOUT_MS="\$\{TELEGRAM_TIMEOUT_MS:-15000\}"/);
  assert.match(deployScript, /TIMEOUT="\$\{YC_LEAD_TIMEOUT:-120s\}"/);
  assert.match(deployScript, /--environment TELEGRAM_RETRY_BATCH_SIZE=/);
  assert.match(deployScript, /--environment TELEGRAM_TIMEOUT_MS=/);
  assert.match(workflow, /TELEGRAM_RETRY_BATCH_SIZE:.*'5'/);
  assert.match(workflow, /TELEGRAM_TIMEOUT_MS:.*'15000'/);
  assert.match(workflow, /YC_LEAD_TIMEOUT:.*'120s'/);
});

test('production runtime defaults match the proven upstream settings', () => {
  assert.match(deployScript, /YDB_QUERY_TIMEOUT_MS="\$\{YDB_QUERY_TIMEOUT_MS:-10000\}"/);
  assert.match(workflow, /YDB_QUERY_TIMEOUT_MS:.*'10000'/);
  assert.match(workflow, /ALLOWED_ORIGINS: 'https:\/\/estetika\.zvenfit\.ru'/);
  assert.doesNotMatch(workflow, /www\.estetika\.zvenfit\.ru/);
});

test('CI deploy requires pre-provisioned infrastructure and does not grant access', () => {
  assert.doesNotMatch(deployScript, /yc ydb database create/);
  assert.doesNotMatch(deployScript, /yc serverless function create/);
  assert.doesNotMatch(deployScript, /\nyc serverless function allow-unauthenticated-invoke/);
  assert.match(deployScript, /function list-access-bindings/);
  assert.match(deployScript, /missing the one-time public functionInvoker binding/);
});

test('CI deploy leaves the one-time retry trigger untouched', () => {
  assert.doesNotMatch(deployScript, /yc serverless trigger create/);
  assert.doesNotMatch(deployScript, /yc serverless trigger update/);
  assert.doesNotMatch(deployScript, /yc serverless trigger delete/);
  assert.match(deployScript, /LEAD_RETRY_TRIGGER=/);
});
