'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const config = require('../monitoring.config.json');
const dashboard = require('../monitoring.dashboard.json');
const docs = fs.readFileSync(path.join(ROOT, 'docs/monitoring.md'), 'utf8');
const operatorHandoff = fs.readFileSync(path.join(ROOT, 'docs/operator-handoff.md'), 'utf8');
const smokeScript = fs.readFileSync(path.join(ROOT, 'scripts/test-monitoring-alerts.sh'), 'utf8');
const source = [
  'functions/telegram-lead/src/handler.ts',
  'functions/telegram-lead/src/application/retry-notifications.ts',
  'functions/telegram-lead/src/telegram/delivery.ts',
  'functions/telegram-lead/src/observability/metrics.ts',
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
    assert.ok(
      `${config.project}_${alert.id}`.length <= 64,
      `${alert.id} exceeds Monium's project-prefixed alert ID limit`,
    );
    assert.match(docs, new RegExp(`\\b${alert.id}\\b`));
    const expectedNoData =
      alert.id === 'zvenfit_estetika_ydb_storage_usage'
        ? 'WARNING'
        : alert.id === 'zfe_retry_worker_heartbeat'
          ? 'ALARM'
          : 'OK';
    assert.equal(alert.noData, expectedNoData);
    assert.equal(alert.operator === '<' ? alert.alarm < alert.warning : alert.alarm > alert.warning, true);
    alertIds.add(alert.id);
  }

  assert.equal(alertIds.size, 14);
  assert.deepEqual(config.notificationChannels.map(channel => channel.id), [
    'zvenfit_estetika_telegram_alerts',
    'zvenfit_estetika_email_alerts',
  ]);
  assert.deepEqual(config.notificationPolicy, {
    channelIds: ['zvenfit_estetika_telegram_alerts', 'zvenfit_estetika_email_alerts'],
    statuses: ['ALARM', 'WARNING', 'OK'],
    repeatMinutes: 30,
  });
  const slowYdbAlert = config.alerts.find(alert => alert.id === 'zvenfit_estetika_slow_ydb');
  assert.deepEqual(slowYdbAlert.notificationChannelIds, ['zvenfit_estetika_email_alerts']);
  assert.equal(slowYdbAlert.notificationRepeatMinutes, 24 * 60);
});

test('count-sensitive and caught events use true log aggregates', () => {
  const expected = [
    ['zvenfit_estetika_storage_errors', 'zvenfit_estetika_storage_errors_1m'],
    ['zfe_permanent_telegram_failures', 'zvenfit_estetika_telegram_failed_1m'],
    ['zvenfit_estetika_ydb_retries', 'zvenfit_estetika_ydb_retries_5m'],
    ['zvenfit_estetika_slow_ydb', 'zvenfit_estetika_ydb_slow_5m'],
    ['zvenfit_estetika_rate_limited', 'zvenfit_estetika_rate_limited_5m'],
    ['zvenfit_estetika_submission_volume', 'zvenfit_estetika_submissions_5m'],
    ['zvenfit_estetika_rate_limit_health', 'zvenfit_estetika_rate_limit_errors_5m'],
    ['zfe_monium_metrics_failures', 'zvenfit_estetika_monium_metrics_failures_5m'],
  ];

  for (const [alertId, metricId] of expected) {
    const alert = config.alerts.find(item => item.id === alertId);
    const metric = config.logMetrics.find(item => item.id === metricId);
    assert.equal(alert.metricId, metricId);
    assert.match(alert.metricSelector, /service="logging_aggregates"/);
    assert.match(alert.metricSelector, new RegExp(`name="${metricId}"`));
    assert.match(alert.metricSelector, /meta\.application="zvenfit-estetika-frontend"/);
    assert.match(alert.metricSelector, /meta\.environment="production"/);
    assert.match(alert.metricSelector, /meta\.service="zvenfit-estetika-telegram-lead"/);
    assert.equal(alert.delay, '3m');
    assert.match(metric.selector, /meta\.application="zvenfit-estetika-frontend"/);
    assert.match(metric.selector, /meta\.environment="production"/);
    assert.match(metric.selector, /meta\.service="zvenfit-estetika-telegram-lead"/);
    assert.match(metric.selector, /resource_id="\*"/);
    const expectedGroupBy =
      metricId === 'zvenfit_estetika_submissions_5m'
        ? ['meta.form_type', 'meta.application', 'meta.environment', 'meta.service']
        : ['meta.application', 'meta.environment', 'meta.service', 'resource_id'];
    assert.deepEqual(metric.groupBy, expectedGroupBy);
    assert.ok(metric.groupBy.length <= 4, `${metricId} exceeds Monium groupBy limit`);
  }
});

test('direct OTLP is limited to current-state gauges with canonical taxonomy', () => {
  const directAlerts = [
    config.alerts.find(item => item.id === 'zfe_retry_worker_heartbeat'),
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
  assert.match(config.dashboard.telegramQueue.metricSelectors[0], /telegram_pending_notifications/);
  assert.match(directMetricsSource, /telegram_pending_submissions/);
  assert.match(directMetricsSource, /telegram_pending_notifications/);
});

test('YDB monitoring uses only stable query execution timing', () => {
  assert.match(source, /tracing:ydb:query\.execute/);
  assert.match(source, /phase: 'query_execute'/);
  assert.doesNotMatch(source, /tracing:ydb:query\.session\.(?:acquire|create)/);
  assert.doesNotMatch(source, /ydb_slow_session_phase/);
  assert.equal('ydbSessionPhases' in config.dashboard, false);
  assert.equal(
    config.logMetrics.some(item => item.id === 'zvenfit_estetika_ydb_slow_session_phases_5m'),
    false,
  );
  assert.match(docs, /YDB session\s+phases[\s\S]*техдолг/i);
});

test('metrics exporter failures use logs so the alert survives a broken OTLP path', () => {
  const metric = config.logMetrics.find(
    item => item.id === 'zvenfit_estetika_monium_metrics_failures_5m',
  );
  const alert = config.alerts.find(item => item.id === 'zfe_monium_metrics_failures');
  const chart = config.dashboard.metricsExporterFailures;
  const widget = dashboard.widgets.find(
    item => item.multiSourceChart?.title === chart.title,
  );

  assert.deepEqual(metric.events, [
    'monium_metrics_export_error',
    'monium_metrics_init_error',
    'monium_metrics_misconfigured',
  ]);
  assert.deepEqual(metric.groupBy, [
    'meta.application',
    'meta.environment',
    'meta.service',
    'resource_id',
  ]);
  assert.equal(metric.synthetic, false);
  assert.equal(alert.metricId, metric.id);
  assert.match(alert.metricSelector, /service="logging_aggregates"/);
  assert.deepEqual(
    { warning: alert.warning, alarm: alert.alarm, window: alert.window, delay: alert.delay },
    { warning: 2, alarm: 5, window: '30m', delay: '3m' },
  );
  assert.match(docs, /Три ошибки за 30 минут дают `Warning`/);
  assert.match(docs, /шесть —\s+`Alarm`/);
  assert.equal(chart.source, metric.id);
  assert.equal(chart.query, widget.multiSourceChart.targets[0].query);
  assert.equal(chart.pagingAlert, true);
  assert.deepEqual(widget.position, { x: '0', y: '60', w: '36', h: '8' });
  assert.match(operatorHandoff, /zvenfit_estetika_storage_errors_1m/);
  assert.match(operatorHandoff, /zvenfit_estetika_storage_errors/);
  assert.match(operatorHandoff, /ZvenFit Estetika · Хранилище и outbox: ошибки/);
});

test('all log metrics stay within the Monium four-label grouping limit', () => {
  for (const metric of config.logMetrics) {
    assert.ok(
      metric.groupBy.length <= 4,
      `${metric.id} has ${metric.groupBy.length} groupBy labels; Monium allows at most 4`,
    );
  }
});

test('retry health covers direct heartbeat, queue age, trigger and log-pipeline diagnostics', () => {
  const heartbeat = config.alerts.find(item => item.id === 'zfe_retry_worker_heartbeat');
  const backlog = config.alerts.find(item => item.id === 'zvenfit_estetika_telegram_backlog');
  const trigger = config.alerts.find(item => item.id === 'zfe_retry_trigger_errors');
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
    selector: '{project="folder__b1ge1e4iopttj79hfdfm", cluster="default", service="default", meta.application="zvenfit-estetika-frontend", meta.environment="production", meta.service="zvenfit-estetika-telegram-lead", meta.event="retry_worker_completed", resource_id="*"}',
    aggregation: 'count',
    window: '1m',
    groupBy: ['meta.application', 'meta.environment', 'meta.service', 'resource_id'],
    synthetic: false,
  });
});

test('platform alerts cover runtime errors, throttling and storage capacity', () => {
  const runtime = config.alerts.find(item => item.id === 'zfe_function_runtime_errors');
  const throttles = config.alerts.find(item => item.id === 'zvenfit_estetika_function_throttles');
  const storage = config.alerts.find(item => item.id === 'zvenfit_estetika_ydb_storage_usage');

  for (const alert of [runtime, throttles]) {
    assert.match(alert.metricSelector, /resource_id="zvenfit-estetika-telegram-lead"/);
    assert.equal(alert.delay, '30s');
  }
  assert.match(runtime.metricSelector, /name="functions_errors"/);
  assert.match(runtime.metricSelector, /cluster="default"/);
  assert.match(runtime.metricSelector, /service="__serverless-functions__"/);
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
  assert.deepEqual(config.dashboard.readingGuide, {
    title: 'Как читать дашборд',
    steps: [
      'Статусы: красный — реагировать; жёлтый — проверить; зелёный — норма.',
      'Поток обращения: Cloud Function → YDB/outbox → Telegram queue → retry-worker.',
      'Диагностика: runtime/throttling и p95 → storage/Telegram errors → YDB query_execute и rate limiter/retry-trigger.',
      'Доставка: сначала размер и возраст очереди, затем heartbeat; окончательная ошибка Telegram означает, что уведомление не доставлено.',
    ],
    note: 'Пустой событийный график при зелёном статусе означает, что ошибок не было. Обновление — раз в минуту.',
    layout: { widthColumns: 36, heightRows: 5 },
  });
  assert.deepEqual(config.dashboard.alertOverview, {
    title: 'Состояние production',
    selector: '{labels.application = "zvenfit-estetika-frontend", labels.environment = "production", labels.service = "zvenfit-estetika-telegram-lead"}',
    visualization: 'alert-list',
    pageSize: 100,
    layout: { widthColumns: 36, heightRows: 5 },
  });
  assert.match(config.dashboard.runtimeErrors.metricSelector, /functions_errors/);
  assert.equal(
    config.dashboard.runtimeErrors.metricSelector,
    config.alerts.find(item => item.id === 'zfe_function_runtime_errors').metricSelector,
  );
  assert.equal(
    config.dashboard.functionThrottles.metricSelector,
    config.alerts.find(item => item.id === 'zvenfit_estetika_function_throttles').metricSelector,
  );
  assert.match(config.dashboard.functionDurationP95.query, /^histogram_percentile\(95,/);
  assert.match(config.dashboard.retryWorkerHeartbeat.metricSelector, /retry_worker_heartbeat/);
  assert.match(config.dashboard.deliveryErrors.metricSelector, /storage_errors_1m/);
  assert.match(config.dashboard.deliveryErrors.metricSelector, /telegram_failed_1m/);
  assert.equal(config.dashboard.telegramQueue.metricSelectors.length, 2);
  assert.deepEqual(config.dashboard.telegramQueue.layout, {
    widthColumns: 36,
    heightRows: 8,
  });
  assert.deepEqual(config.dashboard.submissionVolume.decomposeBy, ['meta.form_type']);
  assert.match(config.dashboard.submissionVolume.query, /^series_sum\("meta\.form_type",/);
  assert.equal(
    config.dashboard.logPipelineHeartbeat.source,
    'zvenfit_estetika_retry_worker_log_heartbeat_1m',
  );
  assert.match(config.dashboard.ydbQueryHealth.metricSelector, /ydb_retries_5m/);
  assert.match(config.dashboard.ydbQueryHealth.metricSelector, /ydb_slow_5m/);
  assert.equal(config.dashboard.ydbQueryHealth.stablePhase, 'query_execute');
  assert.doesNotMatch(config.dashboard.ydbQueryHealth.metricSelector, /session_(acquire|create)/);
  assert.match(config.dashboard.ydbStorage.queries.join('\n'), /zvenfit-estetika-leads/);
  assert.match(config.dashboard.rateLimitAndRetryTrigger.queries[0], /rate_limit_errors_5m/);
  assert.match(config.dashboard.rateLimitAndRetryTrigger.queries[0], /rate_limited_5m/);
  assert.match(config.dashboard.rateLimitAndRetryTrigger.queries[1], /a1sc2t1ro4alukatrf99/);
  assert.equal(
    config.dashboard.metricsExporterFailures.source,
    'zvenfit_estetika_monium_metrics_failures_5m',
  );
  assert.deepEqual(config.dashboard.nativeJson, {
    artifact: 'scripts/monitoring.dashboard.json',
    scope: 'dashboard-only',
    workflow: 'settings-json-export-import',
  });
  assert.deepEqual(config.dashboard.ydbStorage.layout, {
    widthColumns: 18,
    heightRows: 8,
  });
});

test('dashboard quick links open canonical INFO and ERROR logs for the last hour', () => {
  assert.equal(config.dashboard.quickLogAccess.title, 'Быстрый доступ к логам');
  assert.equal(config.dashboard.quickLogAccess.position, 'top');
  assert.deepEqual(config.dashboard.quickLogAccess.layout, {
    widthColumns: 36,
    heightRows: 2,
  });
  assert.deepEqual(
    config.dashboard.quickLogAccess.links.map(link => [link.label, link.level]),
    [
      ['INFO за час', 'INFO'],
      ['ERROR за час', 'ERROR'],
    ],
  );

  const queryTokens = new Set();
  for (const link of config.dashboard.quickLogAccess.links) {
    assert.equal(link.window, '1h');
    const url = new URL(link.url);
    assert.equal(url.hostname, 'monium.yandex.cloud');
    assert.equal(url.pathname, `/projects/${config.project}/logs`);
    assert.equal(url.searchParams.get('from'), 'now-1h');
    assert.equal(url.searchParams.get('to'), 'now');
    assert.equal(url.searchParams.get('tab'), 'logs');
    assert.ok(url.searchParams.get('queries'));
    queryTokens.add(url.searchParams.get('queries'));
    assert.match(docs, new RegExp(link.label));
  }
  assert.equal(queryTokens.size, 2, 'INFO and ERROR must use different encoded selectors');
});

test('native Monium JSON mirrors the reviewed desired dashboard layout', () => {
  assert.equal(dashboard.title, config.dashboard.title);
  assert.equal(dashboard.name, config.dashboard.id);
  assert.equal(dashboard.widgets.length, 15);

  const quickWidget = dashboard.widgets[0];
  assert.equal(quickWidget.widget, 'text');
  assert.deepEqual(quickWidget.position, { x: '0', y: '0', w: '36', h: '2' });
  for (const link of config.dashboard.quickLogAccess.links) {
    assert.match(quickWidget.text.text, new RegExp(link.label));
    assert.ok(quickWidget.text.text.includes(link.url));
  }

  const guideWidget = dashboard.widgets[1];
  assert.equal(guideWidget.widget, 'text');
  assert.deepEqual(guideWidget.position, { x: '0', y: '2', w: '36', h: '5' });
  assert.match(guideWidget.text.text, new RegExp(config.dashboard.readingGuide.title));
  for (const step of config.dashboard.readingGuide.steps) {
    assert.ok(guideWidget.text.text.includes(step));
  }
  assert.ok(guideWidget.text.text.includes(config.dashboard.readingGuide.note));

  const alertWidgets = dashboard.widgets.filter(widget => widget.alertList);
  assert.equal(alertWidgets.length, 1);
  assert.equal(alertWidgets[0].widget, 'alertList');
  assert.equal(alertWidgets[0].alertList.title, config.dashboard.alertOverview.title);
  assert.equal(alertWidgets[0].alertList.selectors, config.dashboard.alertOverview.selector);
  assert.deepEqual(alertWidgets[0].position, { x: '0', y: '7', w: '36', h: '5' });

  const chartWidgets = dashboard.widgets.filter(widget => widget.multiSourceChart);
  assert.equal(chartWidgets.length, 12);
  for (const widget of chartWidgets) {
    assert.equal(widget.widget, 'multiSourceChart');
  }

  const chartQueries = chartWidgets
    .flatMap(widget => widget.multiSourceChart.targets.map(target => target.query));
  for (const query of [
    config.dashboard.runtimeErrors.metricSelector,
    config.dashboard.functionThrottles.metricSelector,
    config.dashboard.functionDurationP95.query,
    config.dashboard.retryWorkerHeartbeat.metricSelector,
    config.dashboard.deliveryErrors.metricSelector,
    ...config.dashboard.telegramQueue.metricSelectors,
    config.dashboard.submissionVolume.query,
    config.dashboard.ydbQueryHealth.metricSelector,
    config.dashboard.logPipelineHeartbeat.query,
    ...config.dashboard.ydbStorage.queries,
    ...config.dashboard.rateLimitAndRetryTrigger.queries,
    config.dashboard.metricsExporterFailures.query,
  ]) {
    assert.ok(chartQueries.includes(query), `native dashboard is missing query: ${query}`);
  }

  const storageWidget = dashboard.widgets.find(
    widget => widget.multiSourceChart?.title === config.dashboard.ydbStorage.title,
  );
  assert.deepEqual(storageWidget.position, { x: '18', y: '44', w: '18', h: '8' });
  const finalWidget = dashboard.widgets.at(-1);
  assert.equal(finalWidget.multiSourceChart.title, config.dashboard.metricsExporterFailures.title);
  assert.deepEqual(finalWidget.position, { x: '0', y: '60', w: '36', h: '8' });

  for (let left = 0; left < dashboard.widgets.length; left += 1) {
    const a = Object.fromEntries(
      Object.entries(dashboard.widgets[left].position).map(([key, value]) => [key, Number(value)]),
    );
    for (let right = left + 1; right < dashboard.widgets.length; right += 1) {
      const b = Object.fromEntries(
        Object.entries(dashboard.widgets[right].position).map(([key, value]) => [key, Number(value)]),
      );
      const overlaps = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
      assert.equal(overlaps, false, `dashboard widgets ${left} and ${right} overlap`);
    }
  }

  const serialized = JSON.stringify(dashboard);
  assert.doesNotMatch(serialized, /session_(acquire|create)/);
  assert.doesNotMatch(serialized, /TELEGRAM_BOT_TOKEN|MONIUM_API_KEY|YC_SA_JSON_KEY/);
  assert.doesNotMatch(serialized, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
});

test('production log source, metric output and provisioning boundary are explicit', () => {
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
      dashboard: 'native-json-import',
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
  assert.match(smokeScript, /RESOURCE_TYPE="serverless\.function"/);
  assert.match(smokeScript, /RESOURCE_ID="zvenfit-estetika-telegram-lead"/);
  assert.match(smokeScript, /--resource-type="\$\{RESOURCE_TYPE\}"/);
  assert.match(smokeScript, /--resource-id="\$\{RESOURCE_ID\}"/);
  assert.match(smokeScript, /\\"synthetic\\":true/);
  assert.doesNotMatch(smokeScript, /retry_worker_completed/);
  assert.doesNotMatch(smokeScript, /TELEGRAM_BOT_TOKEN|telegram_username|phone|utm|\\"name\\"/i);
});
