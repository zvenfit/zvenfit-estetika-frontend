'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const config = require('../monitoring.config.json');
const docs = fs.readFileSync(path.join(ROOT, 'docs/monitoring.md'), 'utf8');
const smokeScript = fs.readFileSync(path.join(ROOT, 'scripts/test-monitoring-alerts.sh'), 'utf8');
const source = [
  'functions/telegram-lead/src/handler.ts',
  'functions/telegram-lead/src/telegram/delivery.ts',
  'functions/telegram-lead/src/observability/ydb.ts',
]
  .map(filename => fs.readFileSync(path.join(ROOT, filename), 'utf8'))
  .join('\n');
const directMetricsSource = [
  'functions/telegram-lead/src/handler.ts',
  'functions/telegram-lead/src/observability/metrics.ts',
  'functions/telegram-lead/src/observability/otel-transport.ts',
]
  .map(filename => fs.readFileSync(path.join(ROOT, filename), 'utf8'))
  .join('\n');

test('every monitored event exists in code and monitoring documentation', () => {
  for (const metric of config.logMetrics) {
    for (const event of metric.events) {
      assert.match(source, new RegExp(`['"]${event}['"]`), `${event} is missing from code`);
      assert.match(docs, new RegExp(`\\b${event}\\b`), `${event} is missing from docs`);
    }
  }
});

test('alert taxonomy, thresholds and notification policy are fully tracked in Git', () => {
  const metricIds = new Set(config.logMetrics.map(metric => metric.id));
  const alertIds = new Set();

  for (const alert of config.alerts) {
    assert.equal(
      Boolean(metricIds.has(alert.metricId) || alert.metricSelector || alert.queries?.length),
      true,
      `${alert.id} has no metric source`,
    );
    assert.equal(alertIds.has(alert.id), false, `${alert.id} is duplicated`);
    assert.match(alert.displayName, /^ZvenFit Estetika · /);
    assert.equal(alert.labels.application, 'zvenfit-estetika-frontend');
    assert.equal(alert.labels.environment, 'production');
    assert.equal(typeof alert.labels.service, 'string');
    assert.equal(typeof alert.labels.resource_id, 'string');
    assert.match(docs, new RegExp(`\\b${alert.id}\\b`));
    const expectedNoData =
      alert.id === 'zvenfit_estetika_ydb_storage_usage'
        ? 'WARNING'
        : alert.id === 'zvenfit_estetika_retry_worker_heartbeat'
          ? 'ALARM'
          : 'OK';
    assert.equal(alert.noData, expectedNoData);
    assert.equal(alert.operator === '<' ? alert.alarm < alert.warning : alert.alarm > alert.warning, true);
    alertIds.add(alert.id);
  }

  assert.equal(alertIds.size, 13);
  assert.deepEqual(config.notificationChannels.map(channel => channel.id), [
    'zvenfit_estetika_telegram_alerts',
    'zvenfit_estetika_email_alerts',
  ]);
  assert.deepEqual(config.notificationPolicy, {
    channelIds: ['zvenfit_estetika_telegram_alerts', 'zvenfit_estetika_email_alerts'],
    statuses: ['ALARM', 'WARNING', 'OK'],
    repeatMinutes: 30,
  });
});

test('count-sensitive and caught events use true log aggregates', () => {
  const expected = [
    ['zvenfit_estetika_storage_errors', 'zvenfit_estetika_storage_errors_1m'],
    ['zvenfit_estetika_permanent_telegram_failures', 'zvenfit_estetika_telegram_failed_1m'],
    ['zvenfit_estetika_ydb_retries', 'zvenfit_estetika_ydb_retries_5m'],
    ['zvenfit_estetika_slow_ydb', 'zvenfit_estetika_ydb_slow_5m'],
    ['zvenfit_estetika_rate_limited', 'zvenfit_estetika_rate_limited_5m'],
    ['zvenfit_estetika_submission_volume', 'zvenfit_estetika_submissions_5m'],
    ['zvenfit_estetika_rate_limit_health', 'zvenfit_estetika_rate_limit_errors_5m'],
  ];

  for (const [alertId, metricId] of expected) {
    const alert = config.alerts.find(item => item.id === alertId);
    assert.equal(alert.metricId, metricId);
    assert.match(alert.metricSelector, /service="logging_aggregates"/);
    assert.match(alert.metricSelector, new RegExp(`name="${metricId}"`));
    assert.match(alert.metricSelector, /meta\.application="zvenfit-estetika-frontend"/);
    assert.match(alert.metricSelector, /meta\.environment="production"/);
    assert.match(alert.metricSelector, /meta\.service="zvenfit-estetika-telegram-lead"/);
    assert.equal(alert.delay, '3m');
  }
});

test('direct OTLP is limited to current-state gauges with canonical taxonomy', () => {
  const directAlerts = [
    config.alerts.find(item => item.id === 'zvenfit_estetika_retry_worker_heartbeat'),
    config.alerts.find(item => item.id === 'zvenfit_estetika_telegram_backlog'),
  ];

  for (const alert of directAlerts) {
    assert.match(alert.metricSelector, /service="zvenfit-estetika-frontend"/);
    assert.match(alert.metricSelector, /application="zvenfit-estetika-frontend"/);
    assert.match(alert.metricSelector, /environment="production"/);
    assert.match(alert.metricSelector, /component="zvenfit-estetika-telegram-lead"/);
    assert.match(alert.metricSelector, /resource_id="zvenfit-estetika-telegram-lead"/);
    assert.equal(alert.delay, '30s');
  }

  assert.doesNotMatch(directMetricsSource, /addCounter/);
  assert.deepEqual(config.directMetrics.labels, {
    application: 'zvenfit-estetika-frontend',
    environment: 'production',
    component: 'zvenfit-estetika-telegram-lead',
    resource_id: 'zvenfit-estetika-telegram-lead',
  });
  assert.equal(config.directMetrics.transport, 'OTLP cumulative gauges');
});

test('retry health covers direct heartbeat, queue age, trigger and log-pipeline diagnostics', () => {
  const heartbeat = config.alerts.find(item => item.id === 'zvenfit_estetika_retry_worker_heartbeat');
  const backlog = config.alerts.find(item => item.id === 'zvenfit_estetika_telegram_backlog');
  const trigger = config.alerts.find(item => item.id === 'zvenfit_estetika_retry_trigger_errors');
  const logHeartbeat = config.logMetrics.find(
    item => item.id === 'zvenfit_estetika_retry_worker_log_heartbeat_1m',
  );

  assert.deepEqual(
    { operator: heartbeat.operator, warning: heartbeat.warning, alarm: heartbeat.alarm, noData: heartbeat.noData },
    { operator: '<', warning: 0.9, alarm: 0.5, noData: 'ALARM' },
  );
  assert.deepEqual(
    { warning: backlog.warning, alarm: backlog.alarm, aggregation: backlog.aggregation },
    { warning: 600, alarm: 1800, aggregation: 'last' },
  );
  assert.match(trigger.metricSelector, /serverless\.triggers\.access_error_per_second/);
  assert.match(trigger.metricSelector, /serverless\.triggers\.error_per_second/);
  assert.match(trigger.metricSelector, /trigger="a1sc2t1ro4alukatrf99"/);
  assert.deepEqual(logHeartbeat, {
    id: 'zvenfit_estetika_retry_worker_log_heartbeat_1m',
    displayName: 'ZvenFit Estetika · Retry-worker: поставка логов',
    events: ['retry_worker_completed'],
    filters: { resource_id: '*' },
    aggregation: 'count',
    window: '1m',
    grouping: ['meta.application', 'meta.environment', 'meta.service', 'resource_id'],
    synthetic: false,
  });
});

test('platform alerts cover runtime errors, throttling and storage capacity', () => {
  const runtime = config.alerts.find(item => item.id === 'zvenfit_estetika_function_runtime_errors');
  const throttles = config.alerts.find(item => item.id === 'zvenfit_estetika_function_throttles');
  const storage = config.alerts.find(item => item.id === 'zvenfit_estetika_ydb_storage_usage');

  for (const alert of [runtime, throttles]) {
    assert.match(alert.metricSelector, /resource_id="zvenfit-estetika-telegram-lead"/);
    assert.equal(alert.delay, '30s');
  }
  assert.match(runtime.metricSelector, /name="functions_errors"/);
  assert.match(throttles.metricSelector, /name="functions_throttles"/);
  assert.match(storage.queries.map(query => query.query).join('\n'), /zvenfit-estetika-leads/);
  assert.equal(storage.signal, 'C');
  assert.equal(storage.warning, 70);
  assert.equal(storage.alarm, 85);
  assert.equal(storage.noData, 'WARNING');
});

test('dashboard contains the compact Estetika operational view', () => {
  assert.equal(config.dashboard.id, 'zvenfit-estetika-production-monitoring');
  assert.equal(config.dashboard.title, 'ZvenFit Estetika · production');
  assert.match(config.dashboard.runtimeErrors.metricSelector, /functions_errors/);
  assert.match(config.dashboard.functionDurationP95.query, /^histogram_percentile\(95,/);
  assert.match(config.dashboard.retryWorkerHeartbeat.metricSelector, /retry_worker_heartbeat/);
  assert.equal(config.dashboard.telegramQueue.metricSelectors.length, 2);
  assert.deepEqual(config.dashboard.submissionVolume.decomposeBy, ['meta.form_type']);
  assert.match(config.dashboard.submissionVolume.query, /^series_sum\("meta\.form_type",/);
  assert.equal(
    config.dashboard.logPipelineHeartbeat.source,
    'zvenfit_estetika_retry_worker_log_heartbeat_1m',
  );
  assert.match(config.dashboard.ydbStorage.queries.join('\n'), /zvenfit-estetika-leads/);
});

test('production log source, metric output and manual provisioning boundary are explicit', () => {
  assert.deepEqual(config.source, {
    cluster: 'default',
    service: 'default',
    labels: {
      'meta.application': 'zvenfit-estetika-frontend',
      'meta.environment': 'production',
      'meta.service': 'zvenfit-estetika-telegram-lead',
    },
    retentionDays: 3,
  });
  assert.deepEqual(config.metricOutput, {
    cluster: 'default',
    service: 'logging_aggregates',
    idLabel: 'name',
  });
  assert.deepEqual(
    {
      logMetrics: config.provisioning.logMetrics,
      alerts: config.provisioning.alerts,
      channels: config.provisioning.notificationChannels,
      dashboard: config.provisioning.dashboard,
    },
    {
      logMetrics: 'manual-console',
      alerts: 'manual-console',
      channels: 'manual-console',
      dashboard: 'manual-console',
    },
  );
});

test('safe smoke script exercises only synthetic application events', () => {
  for (const event of [
    'submission_storage_error',
    'telegram_delivery_failed_permanently',
    'ydb_retry',
    'ydb_slow_operation',
    'submission_rate_limit_error',
    'submission_blocked',
    'submission_persisted',
  ]) {
    assert.match(smokeScript, new RegExp(`\\b${event}\\b`));
  }
  assert.match(smokeScript, /\\"service\\":\\"\$\{SERVICE_NAME\}\\"/);
  assert.match(smokeScript, /MONITORING_ENVIRONMENT="production"/);
  assert.doesNotMatch(smokeScript, /MONITORING_ENVIRONMENT="\$\{NODE_ENV/);
  assert.match(smokeScript, /\\"synthetic\\":true/);
  assert.doesNotMatch(smokeScript, /retry_worker_completed/);
  assert.doesNotMatch(smokeScript, /TELEGRAM_BOT_TOKEN|telegram_username|phone|utm|\\"name\\"/i);
});
