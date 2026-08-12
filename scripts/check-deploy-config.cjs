'use strict';

const REQUIRED = [
  'YC_SA_JSON_KEY',
  'YC_FOLDER_ID',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'LEAD_RATE_LIMIT_SECRET',
  'MONIUM_API_KEY',
  'YC_ACCESS_KEY_ID',
  'YC_SECRET_ACCESS_KEY',
  'YC_LEAD_SERVICE_ACCOUNT_ID',
  'YANDEX_METRIKA_ID',
];

function validate(environment) {
  const missing = REQUIRED.filter(name => !String(environment[name] || '').trim());
  const invalid = [];

  if (!missing.includes('YC_SA_JSON_KEY')) {
    try {
      const key = JSON.parse(environment.YC_SA_JSON_KEY);
      if (!key || typeof key !== 'object' || !key.service_account_id || !key.private_key) {
        invalid.push('YC_SA_JSON_KEY');
      }
    } catch {
      invalid.push('YC_SA_JSON_KEY');
    }
  }

  if (!missing.includes('LEAD_RATE_LIMIT_SECRET') && environment.LEAD_RATE_LIMIT_SECRET.trim().length < 32) {
    invalid.push('LEAD_RATE_LIMIT_SECRET');
  }
  if (
    !missing.includes('TELEGRAM_BOT_TOKEN') &&
    !/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(environment.TELEGRAM_BOT_TOKEN.trim())
  ) {
    invalid.push('TELEGRAM_BOT_TOKEN');
  }
  if (!missing.includes('TELEGRAM_CHAT_ID') && !/^-\d{6,}$/.test(environment.TELEGRAM_CHAT_ID.trim())) {
    invalid.push('TELEGRAM_CHAT_ID');
  }
  if (!missing.includes('YANDEX_METRIKA_ID') && !/^\d+$/.test(environment.YANDEX_METRIKA_ID.trim())) {
    invalid.push('YANDEX_METRIKA_ID');
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
    console.log('deploy-config: OK');
  }
}

module.exports = { REQUIRED, validate };
