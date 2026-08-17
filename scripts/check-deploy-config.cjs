'use strict';

const { isIPv4 } = require('node:net');

const PRODUCTION = Object.freeze({
  siteUrl: 'https://estetika.zvenfit.ru',
  s3Bucket: 'zvenfit-estetika-frontend',
  functionName: 'zvenfit-estetika-telegram-lead',
  ydbDatabaseName: 'zvenfit-estetika-leads',
  allowedOrigins: 'https://estetika.zvenfit.ru',
});

const REQUIRED = [
  'YC_FOLDER_ID',
  'YC_DEPLOY_SERVICE_ACCOUNT_ID',
  'YC_YDB_VERIFY_SERVICE_ACCOUNT_ID',
  'YC_STORAGE_SERVICE_ACCOUNT_ID',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_API_FALLBACK_IPV4S',
  'LEAD_RATE_LIMIT_SECRET',
  'MONIUM_API_KEY',
  'YC_LEAD_SERVICE_ACCOUNT_ID',
  'YDB_DATABASE_ID',
  'YANDEX_METRIKA_ID',
  'SITE_URL',
  'S3_BUCKET',
  'FUNCTION_NAME',
  'YDB_DATABASE_NAME',
  'ALLOWED_ORIGINS',
];

function validate(environment) {
  const missing = REQUIRED.filter(name => !String(environment[name] || '').trim());
  const invalid = [];
  const exactValues = {
    SITE_URL: PRODUCTION.siteUrl,
    S3_BUCKET: PRODUCTION.s3Bucket,
    FUNCTION_NAME: PRODUCTION.functionName,
    YDB_DATABASE_NAME: PRODUCTION.ydbDatabaseName,
    ALLOWED_ORIGINS: PRODUCTION.allowedOrigins,
  };

  for (const [name, expected] of Object.entries(exactValues)) {
    if (!missing.includes(name) && environment[name].trim() !== expected) {
      invalid.push(name);
    }
  }

  for (const name of [
    'YC_FOLDER_ID',
    'YC_DEPLOY_SERVICE_ACCOUNT_ID',
    'YC_YDB_VERIFY_SERVICE_ACCOUNT_ID',
    'YC_STORAGE_SERVICE_ACCOUNT_ID',
    'YC_LEAD_SERVICE_ACCOUNT_ID',
    'YDB_DATABASE_ID',
  ]) {
    if (!missing.includes(name) && !/^[a-z0-9]{6,}$/.test(environment[name].trim())) {
      invalid.push(name);
    }
  }

  const identityNames = [
    'YC_DEPLOY_SERVICE_ACCOUNT_ID',
    'YC_YDB_VERIFY_SERVICE_ACCOUNT_ID',
    'YC_STORAGE_SERVICE_ACCOUNT_ID',
    'YC_LEAD_SERVICE_ACCOUNT_ID',
  ].filter(name => !missing.includes(name));
  const identityValues = identityNames.map(name => environment[name].trim());
  if (new Set(identityValues).size !== identityValues.length) {
    const counts = new Map();
    for (const value of identityValues) counts.set(value, (counts.get(value) || 0) + 1);
    invalid.push(...identityNames.filter(name => counts.get(environment[name].trim()) > 1));
  }

  if (
    !missing.includes('LEAD_RATE_LIMIT_SECRET') &&
    environment.LEAD_RATE_LIMIT_SECRET.trim().length < 32
  ) {
    invalid.push('LEAD_RATE_LIMIT_SECRET');
  }
  if (
    !missing.includes('TELEGRAM_BOT_TOKEN') &&
    !/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(environment.TELEGRAM_BOT_TOKEN.trim())
  ) {
    invalid.push('TELEGRAM_BOT_TOKEN');
  }
  if (
    !missing.includes('TELEGRAM_CHAT_ID') &&
    !/^-\d{6,}$/.test(environment.TELEGRAM_CHAT_ID.trim())
  ) {
    invalid.push('TELEGRAM_CHAT_ID');
  }
  if (
    !missing.includes('YANDEX_METRIKA_ID') &&
    !/^\d+$/.test(environment.YANDEX_METRIKA_ID.trim())
  ) {
    invalid.push('YANDEX_METRIKA_ID');
  }
  if (
    !missing.includes('TELEGRAM_API_FALLBACK_IPV4S') &&
    (() => {
      const values = environment.TELEGRAM_API_FALLBACK_IPV4S.split(/[\s,]+/).filter(Boolean);
      return values.length === 0 || values.length > 5 || values.some(value => !isIPv4(value));
    })()
  ) {
    invalid.push('TELEGRAM_API_FALLBACK_IPV4S');
  }

  return { missing, invalid: [...new Set(invalid)] };
}

if (require.main === module) {
  const result = validate(process.env);
  if (result.missing.length || result.invalid.length) {
    if (result.missing.length) console.error(`deploy-config: missing ${result.missing.join(', ')}`);
    if (result.invalid.length) console.error(`deploy-config: invalid ${result.invalid.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('deploy-config: production isolation and access inputs OK');
  }
}

module.exports = { PRODUCTION, REQUIRED, validate };
