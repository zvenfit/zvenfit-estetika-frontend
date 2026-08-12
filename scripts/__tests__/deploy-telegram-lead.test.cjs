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
  const functionDeploy = workflow.indexOf('  deploy-function:');
  const siteDeploy = workflow.indexOf('  deploy-site:');

  assert.equal(quality >= 0, true);
  assert.equal(functionDeploy > quality, true);
  assert.equal(siteDeploy > functionDeploy, true);
  const functionJob = workflow.slice(functionDeploy, siteDeploy);
  assert.match(functionJob, /needs: quality-checks/);
  assert.match(functionJob, /environment: production/);
});

test('function deploy verifies YDB, migrates and then creates a version', () => {
  const integration = deployScript.indexOf('run test:integration');
  const migration = deployScript.indexOf('run migrate');
  const deploy = deployScript.indexOf('yc serverless function version create');

  assert.equal(integration >= 0, true);
  assert.equal(migration > integration, true);
  assert.equal(deploy > migration, true);
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

test('CI deploy requires pre-provisioned infrastructure and does not grant access', () => {
  assert.doesNotMatch(deployScript, /yc ydb database create/);
  assert.doesNotMatch(deployScript, /\nyc serverless function allow-unauthenticated-invoke/);
  assert.match(deployScript, /function list-access-bindings/);
  assert.match(deployScript, /missing the one-time public functionInvoker binding/);
});

test('existing retry trigger is resolved and updated by id', () => {
  const updateStart = deployScript.indexOf('yc serverless trigger update timer');
  const createStart = deployScript.indexOf('yc serverless trigger create timer');
  const updateBlock = deployScript.slice(updateStart, createStart);

  assert.match(deployScript, /TRIGGER_ID=.*trigger get/);
  assert.match(updateBlock, /--id="\$\{TRIGGER_ID\}"/);
  assert.doesNotMatch(updateBlock, /--name="\$\{TRIGGER_NAME\}"/);
});
