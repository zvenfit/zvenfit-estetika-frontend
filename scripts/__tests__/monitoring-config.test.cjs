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
  'functions/telegram-lead/src/observability/event-metrics.ts',
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
    assert.equal(
      Boolean(alert.metricSelector) || metricIds.has(alert.metricId) || Boolean(alert.queries?.length),
      true,
    );
    assert.match(docs, new RegExp(`\\b${alert.id}\\b`));
  }
  assert.deepEqual(config.notificationChannels, [
    'zvenfit_estetika_telegram_alerts',
    'zvenfit_estetika_email_alerts',
  ]);
  assert.equal(config.alerts.length, 12);
});

test('lead-pipeline alerts use direct OTLP metrics with short evaluation delay', () => {
  const directAlerts = config.alerts.filter(alert =>
    alert.metricSelector?.includes('service="zvenfit-estetika-frontend"'),
  );

  assert.equal(directAlerts.length, 9);
  for (const alert of directAlerts) {
    assert.equal(alert.delay, '30s');
    assert.match(alert.metricSelector, /project="folder__b1ge1e4iopttj79hfdfm"/);
  }
  assert.deepEqual(config.directMetrics, {
    cluster: 'default',
    service: 'zvenfit-estetika-frontend',
    transport: 'OTLP delta',
    endpoint: 'https://ingest.monium.yandex.cloud/otlp/v1/metrics',
  });
});

test('retry health covers missing heartbeat and queue age', () => {
  const heartbeat = config.alerts.find(item => item.id === 'zvenfit_estetika_retry_worker_heartbeat');
  const backlog = config.alerts.find(item => item.id === 'zvenfit_estetika_telegram_backlog');
  const triggerErrors = config.alerts.find(item => item.id === 'zvenfit_estetika_retry_trigger_errors');

  assert.equal(heartbeat.noData, 'ALARM');
  assert.equal(heartbeat.operator, '<');
  assert.deepEqual(
    { warning: heartbeat.warning, alarm: heartbeat.alarm },
    { warning: 0.9, alarm: 0.5 },
  );
  assert.match(heartbeat.metricSelector, /zvenfit_estetika_retry_worker_heartbeat/);
  assert.deepEqual(
    { warning: backlog.warning, alarm: backlog.alarm, aggregation: backlog.aggregation },
    { warning: 600, alarm: 1800, aggregation: 'last' },
  );
  assert.equal(config.resources.retryTriggerId, 'a1sc2t1ro4alukatrf99');
  assert.match(triggerErrors.metricSelector, /serverless\.triggers\.access_error_per_second/);
  assert.match(triggerErrors.metricSelector, /trigger="a1sc2t1ro4alukatrf99"/);
  assert.deepEqual(
    { warning: triggerErrors.warning, alarm: triggerErrors.alarm, delay: triggerErrors.delay },
    { warning: 0, alarm: 0.5, delay: '30s' },
  );
});

test('YDB storage warning uses used and limit platform metrics', () => {
  const alert = config.alerts.find(item => item.id === 'zvenfit_estetika_ydb_storage_usage');
  const queries = alert.queries.map(item => item.query).join('\n');

  assert.match(queries, /resources\.storage\.used_bytes/);
  assert.match(queries, /resources\.storage\.limit_bytes/);
  assert.equal(alert.signal, 'C');
  assert.equal(alert.noData, 'WARNING');
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
