'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/monitoring.config.json'), 'utf8'));
const docs = fs.readFileSync(path.join(ROOT, 'docs/monitoring.md'), 'utf8');
const source = [
  'functions/telegram-lead/src/handler.ts',
  'functions/telegram-lead/src/telegram/delivery.ts',
  'functions/telegram-lead/src/observability/ydb.ts',
]
  .map(filename => fs.readFileSync(path.join(ROOT, filename), 'utf8'))
  .join('\n');

test('every monitored event exists in code and monitoring documentation', () => {
  for (const metric of config.logMetrics) {
    for (const event of metric.events) {
      assert.match(source, new RegExp(`['\"]${event}['\"]`), `${event} is missing from code`);
      assert.match(docs, new RegExp(`\\b${event}\\b`), `${event} is missing from docs`);
    }
  }
});

test('alerts reference declared metrics and both notification channels are explicit', () => {
  const metricIds = new Set(config.logMetrics.map(metric => metric.id));
  for (const alert of config.alerts) {
    assert.equal(Boolean(alert.metricSelector) || metricIds.has(alert.metricId), true);
    assert.match(docs, new RegExp(`\\b${alert.id}\\b`));
  }
  assert.deepEqual(config.notificationChannels, [
    'zvenfit_estetika_telegram_alerts',
    'zvenfit_estetika_email_alerts',
  ]);
});

test('production log source and retention are explicit', () => {
  assert.equal(config.application, 'zvenfit-estetika-frontend');
  assert.equal(config.environment, 'production');
  assert.deepEqual(config.logGroup, { name: 'default', retentionDays: 3 });
});

test('persisted volume is grouped by lead and newsletter form type', () => {
  const metric = config.logMetrics.find(item => item.id === 'zvenfit_estetika_submissions_5m');

  assert.deepEqual(metric.groupBy, ['form_type']);
});
