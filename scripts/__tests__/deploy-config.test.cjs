'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { PRODUCTION, REQUIRED, validate } = require('../check-deploy-config.cjs');

const rootDir = path.join(__dirname, '..', '..');

function validEnvironment() {
  return {
    YC_FOLDER_ID: 'b1gtest123',
    YC_DEPLOY_SERVICE_ACCOUNT_ID: 'ajedeploy123',
    YC_YDB_VERIFY_SERVICE_ACCOUNT_ID: 'ajeverify123',
    YC_STORAGE_SERVICE_ACCOUNT_ID: 'ajestorage123',
    TELEGRAM_BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyz_ABCDE',
    TELEGRAM_CHAT_ID: '-1001234567890',
    TELEGRAM_API_IPV4: '149.154.167.220',
    LEAD_RATE_LIMIT_SECRET: 'a'.repeat(32),
    MONIUM_API_KEY: 'test-monium-api-key',
    YC_LEAD_SERVICE_ACCOUNT_ID: 'ajeruntime123',
    YDB_DATABASE_ID: 'etndatabase123',
    YANDEX_METRIKA_ID: '12345678',
    SITE_URL: PRODUCTION.siteUrl,
    S3_BUCKET: PRODUCTION.s3Bucket,
    FUNCTION_NAME: PRODUCTION.functionName,
    YDB_DATABASE_NAME: PRODUCTION.ydbDatabaseName,
    ALLOWED_ORIGINS: PRODUCTION.allowedOrigins,
  };
}

test('deploy preflight names every required secret and variable', () => {
  assert.deepEqual(validate({}).missing, REQUIRED);
});

test('deploy preflight validates formats without returning secret values', () => {
  assert.deepEqual(validate(validEnvironment()), { missing: [], invalid: [] });

  const invalid = validEnvironment();
  invalid.YC_DEPLOY_SERVICE_ACCOUNT_ID = 'bad id';
  invalid.TELEGRAM_BOT_TOKEN = 'not-a-bot-token';
  invalid.TELEGRAM_CHAT_ID = 'not-a-chat-id';
  invalid.TELEGRAM_API_IPV4 = 'not-an-ip';
  invalid.LEAD_RATE_LIMIT_SECRET = 'short';
  invalid.YANDEX_METRIKA_ID = 'not-numeric';
  assert.deepEqual(validate(invalid), {
    missing: [],
    invalid: [
      'YC_DEPLOY_SERVICE_ACCOUNT_ID',
      'LEAD_RATE_LIMIT_SECRET',
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_CHAT_ID',
      'YANDEX_METRIKA_ID',
      'TELEGRAM_API_IPV4',
    ],
  });
});

test('deploy preflight requires separate deploy, verifier, storage and runtime identities', () => {
  const invalid = validEnvironment();
  invalid.YC_YDB_VERIFY_SERVICE_ACCOUNT_ID = invalid.YC_DEPLOY_SERVICE_ACCOUNT_ID;

  assert.deepEqual(validate(invalid).invalid, [
    'YC_DEPLOY_SERVICE_ACCOUNT_ID',
    'YC_YDB_VERIFY_SERVICE_ACCOUNT_ID',
  ]);
});

test('deploy preflight rejects resource names from the main ZvenFit project', () => {
  const invalid = validEnvironment();
  invalid.S3_BUCKET = 'zvenfit-frontend';
  invalid.FUNCTION_NAME = 'zvenfit-telegram-lead';
  invalid.YDB_DATABASE_NAME = 'zvenfit-leads';

  assert.deepEqual(validate(invalid).invalid, ['S3_BUCKET', 'FUNCTION_NAME', 'YDB_DATABASE_NAME']);
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
  assert.match(setupStorage, /zvenfit-estetika-site-storage-sa/);
  assert.match(setupStorage, /required storage identity/);
  assert.doesNotMatch(setupStorage, /zvenfit-estetika-frontend-ci-sa/);
  assert.doesNotMatch(workflow, /--website-redirect/);
  assert.doesNotMatch(packageJson.scripts['deploy:yc'], /upload-legacy-redirects/);
});
