'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { REQUIRED, validate } = require('../check-deploy-config.cjs');

const rootDir = path.join(__dirname, '..', '..');

function validEnvironment() {
  return {
    YC_SA_JSON_KEY: JSON.stringify({ service_account_id: 'aje-test', private_key: 'private-test' }),
    YC_FOLDER_ID: 'b1g-test',
    TELEGRAM_BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyz_ABCDE',
    TELEGRAM_CHAT_ID: '-1001234567890',
    LEAD_RATE_LIMIT_SECRET: 'a'.repeat(32),
    MONIUM_API_KEY: 'test-monium-api-key',
    YC_ACCESS_KEY_ID: 'access-test',
    YC_SECRET_ACCESS_KEY: 'secret-test',
    YC_LEAD_SERVICE_ACCOUNT_ID: 'aje-runtime-test',
    YDB_DATABASE_ID: 'etn-database-test',
    YANDEX_METRIKA_ID: '12345678',
  };
}

test('deploy preflight names every required secret and variable', () => {
  assert.deepEqual(validate({}).missing, REQUIRED);
});

test('deploy preflight validates formats without returning secret values', () => {
  assert.deepEqual(validate(validEnvironment()), { missing: [], invalid: [] });

  const invalid = validEnvironment();
  invalid.YC_SA_JSON_KEY = '{}';
  invalid.TELEGRAM_BOT_TOKEN = 'not-a-bot-token';
  invalid.TELEGRAM_CHAT_ID = 'not-a-chat-id';
  invalid.LEAD_RATE_LIMIT_SECRET = 'short';
  invalid.YANDEX_METRIKA_ID = 'not-numeric';
  assert.deepEqual(validate(invalid), {
    missing: [],
    invalid: [
      'YC_SA_JSON_KEY',
      'LEAD_RATE_LIMIT_SECRET',
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_CHAT_ID',
      'YANDEX_METRIKA_ID',
    ],
  });
});

test('site deploy preserves permanent redirects from legacy legal document URLs', () => {
  const workflow = fs.readFileSync(path.join(rootDir, '.github', 'workflows', 'main.yml'), 'utf8');
  const redirectScript = fs.readFileSync(
    path.join(rootDir, 'scripts', 'upload-legacy-redirects.sh'),
    'utf8',
  );
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

  for (const [legacyKey, targetPath] of [
    ['documents/privacy-policy.html', '/privacy/'],
    ['documents/personal-data-processing.html', '/personal-data-processing/'],
  ]) {
    assert.ok(workflow.includes(`s3://\${{ env.S3_BUCKET }}/${legacyKey}`));
    assert.ok(workflow.includes(`--website-redirect ${targetPath}`));
    assert.ok(redirectScript.includes(`upload_redirect "${legacyKey}" "${targetPath}"`));
  }

  assert.match(packageJson.scripts['deploy:yc'], /bash scripts\/upload-legacy-redirects\.sh$/);
});
