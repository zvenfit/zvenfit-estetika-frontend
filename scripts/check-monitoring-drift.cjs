'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG = path.join(ROOT, 'scripts/monitoring.config.json');
const LOG_METRIC_FIELDS = [
  'id',
  'displayName',
  'events',
  'selector',
  'filters',
  'sourceType',
  'aggregation',
  'window',
  'grouping',
  'groupBy',
  'synthetic',
];
const NOTIFICATION_CHANNEL_FIELDS = ['id', 'name', 'method', 'recipient', 'sendScreenshot'];
const ALERT_FIELDS = [
  'id',
  'displayName',
  'scope',
  'metricId',
  'metricSelector',
  'queries',
  'signal',
  'aggregation',
  'operator',
  'warning',
  'alarm',
  'window',
  'delay',
  'noData',
  'level',
  'labels',
  'decomposeBy',
  'groupNotifications',
  'notificationChannelIds',
];

function normalizeValue(value) {
  if (Array.isArray(value)) {
    const normalized = value.map(normalizeValue);
    if (normalized.every(item => ['string', 'number', 'boolean'].includes(typeof item))) {
      return normalized.sort((left, right) => String(left).localeCompare(String(right)));
    }

    return normalized.sort((left, right) =>
      String(left?.id ?? left?.name ?? JSON.stringify(left)).localeCompare(
        String(right?.id ?? right?.name ?? JSON.stringify(right)),
      ),
    );
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalizeValue(nested)]),
    );
  }

  return value ?? null;
}

function normalizeEntry(entry, fields) {
  return Object.fromEntries(fields.map(field => [field, normalizeValue(entry[field])]));
}

function normalizeCollection(items, fields, name) {
  if (!Array.isArray(items)) {
    throw new Error(`monitoring drift snapshot must contain an array named ${name}`);
  }

  return items
    .map(item => normalizeEntry(item, fields))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function normalizeMonitoringState(state) {
  const defaultChannelIds = state.notificationPolicy?.channelIds;
  const alerts = state.alerts?.map(alert => ({
    ...alert,
    notificationChannelIds: alert.notificationChannelIds ?? defaultChannelIds,
  }));

  return {
    logMetrics: normalizeCollection(state.logMetrics, LOG_METRIC_FIELDS, 'logMetrics'),
    alerts: normalizeCollection(alerts, ALERT_FIELDS, 'alerts'),
    notificationChannels: normalizeCollection(
      state.notificationChannels,
      NOTIFICATION_CHANNEL_FIELDS,
      'notificationChannels',
    ),
    notificationPolicy: normalizeValue(state.notificationPolicy ?? {}),
    dashboard: normalizeValue(state.dashboard ?? {}),
  };
}

function printableDifferenceValue(kind, field, value) {
  if (kind === 'notificationChannels' && field === 'recipient') {
    return '"[redacted]"';
  }

  return JSON.stringify(value);
}

function diffCollection(kind, expectedItems, actualItems) {
  const expected = new Map(expectedItems.map(item => [item.id, item]));
  const actual = new Map(actualItems.map(item => [item.id, item]));
  const differences = [];

  for (const [id, expectedItem] of expected) {
    const actualItem = actual.get(id);
    if (!actualItem) {
      differences.push(`${kind}.${id}: missing in live snapshot`);
      continue;
    }

    for (const field of Object.keys(expectedItem)) {
      const expectedValue = JSON.stringify(expectedItem[field]);
      const actualValue = JSON.stringify(actualItem[field]);
      if (expectedValue !== actualValue) {
        differences.push(
          `${kind}.${id}.${field}: expected ${printableDifferenceValue(kind, field, expectedItem[field])}, received ${printableDifferenceValue(kind, field, actualItem[field])}`,
        );
      }
    }
  }

  for (const id of actual.keys()) {
    if (!expected.has(id)) {
      differences.push(`${kind}.${id}: unexpected live resource`);
    }
  }

  return differences;
}

function diffMonitoringState(expectedState, actualState) {
  const expected = normalizeMonitoringState(expectedState);
  const actual = normalizeMonitoringState(actualState);

  return [
    ...diffCollection('logMetrics', expected.logMetrics, actual.logMetrics),
    ...diffCollection('alerts', expected.alerts, actual.alerts),
    ...diffCollection('notificationChannels', expected.notificationChannels, actual.notificationChannels),
    ...(JSON.stringify(expected.notificationPolicy) === JSON.stringify(actual.notificationPolicy)
      ? []
      : [
          `notificationPolicy: expected ${JSON.stringify(expected.notificationPolicy)}, received ${JSON.stringify(actual.notificationPolicy)}`,
        ]),
    ...(JSON.stringify(expected.dashboard) === JSON.stringify(actual.dashboard)
      ? []
      : [`dashboard: expected ${JSON.stringify(expected.dashboard)}, received ${JSON.stringify(actual.dashboard)}`]),
  ];
}

function argumentValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  if (!argv[index + 1]) {
    throw new Error(`monitoring drift: ${name} requires a value`);
  }

  return argv[index + 1];
}

function readJson(filename) {
  const source =
    filename === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(filename), 'utf8');

  return JSON.parse(source);
}

function run(argv = process.argv.slice(2)) {
  const snapshotPath = argumentValue(argv, '--snapshot');
  const configPath = argumentValue(argv, '--config') || DEFAULT_CONFIG;
  if (!snapshotPath) {
    throw new Error(
      'Usage: node scripts/check-monitoring-drift.cjs --snapshot <live-export.json|-> [--config <desired.json>]',
    );
  }

  const differences = diffMonitoringState(readJson(configPath), readJson(snapshotPath));
  if (differences.length > 0) {
    console.error(`monitoring drift: ${differences.length} difference(s)`);
    for (const difference of differences) {
      console.error(`- ${difference}`);
    }
    process.exitCode = 1;

    return differences;
  }

  console.log('monitoring drift: live snapshot matches scripts/monitoring.config.json');

  return [];
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  }
}

module.exports = { diffMonitoringState, normalizeMonitoringState, run };
