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

test('storage setup preserves permanent redirects from legacy legal document URLs', () => {
  const workflow = fs.readFileSync(path.join(rootDir, '.github', 'workflows', 'main.yml'), 'utf8');
  const setupStorage = fs.readFileSync(path.join(rootDir, 'scripts', 'setup-storage.sh'), 'utf8');
  const websiteSettings = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'scripts', 'website-settings.json'), 'utf8'),
  );
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

  assert.deepEqual(websiteSettings, {
    index: 'index.html',
    error: '404.html',
    routingRules: [
      {
        condition: { keyPrefixEquals: 'documents/privacy-policy.html' },
        redirect: {
          hostname: 'estetika.zvenfit.ru',
          httpRedirectCode: '301',
          protocol: 'PROTOCOL_HTTPS',
          replaceKeyWith: 'privacy/',
        },
      },
      {
        condition: { keyPrefixEquals: 'documents/personal-data-processing.html' },
        redirect: {
          hostname: 'estetika.zvenfit.ru',
          httpRedirectCode: '301',
          protocol: 'PROTOCOL_HTTPS',
          replaceKeyWith: 'personal-data-processing/',
        },
      },
    ],
  });
  assert.match(setupStorage, /--website-settings-from-file "\$\{WEBSITE_SETTINGS_FILE\}"/);
  assert.doesNotMatch(workflow, /--website-redirect/);
  assert.doesNotMatch(packageJson.scripts['deploy:yc'], /upload-legacy-redirects/);
});
