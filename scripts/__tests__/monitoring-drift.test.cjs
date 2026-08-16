'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const config = require('../monitoring.config.json');
const { diffMonitoringState, normalizeMonitoringState } = require('../check-monitoring-drift.cjs');

function liveSnapshot() {
  return JSON.parse(JSON.stringify(config));
}

const ROOT = path.resolve(__dirname, '../..');

test('normalizes Estetika monitoring resources into a stable read-only contract', () => {
  const normalized = normalizeMonitoringState(config);

  assert.equal(normalized.logMetrics.length, 8);
  assert.equal(normalized.alerts.length, 13);
  assert.equal(normalized.notificationChannels.length, 2);
  assert.equal(normalized.dashboard.title, 'ZvenFit Estetika · production');
  assert.deepEqual(diffMonitoringState(config, liveSnapshot()), []);
});

test('reports taxonomy, channel and dashboard drift in addition to thresholds', () => {
  const snapshot = liveSnapshot();
  snapshot.logMetrics.find(item => item.id === 'zvenfit_estetika_storage_errors_1m').displayName =
    'Legacy storage errors';
  snapshot.alerts.find(item => item.id === 'zvenfit_estetika_storage_errors').delay = '4m';
  snapshot.alerts.find(item => item.id === 'zvenfit_estetika_storage_errors').labels.service =
    'wrong-service';
  snapshot.notificationChannels.find(item => item.id === 'zvenfit_estetika_telegram_alerts').name =
    'Legacy Telegram';
  snapshot.notificationPolicy.repeatMinutes = 15;
  snapshot.dashboard.runtimeErrors.metricSelector = '{name="legacy_runtime_errors"}';
  snapshot.alerts = snapshot.alerts.filter(
    item => item.id !== 'zvenfit_estetika_permanent_telegram_failures',
  );
  snapshot.alerts.push({ id: 'zvenfit_estetika_legacy_alert' });

  const output = diffMonitoringState(config, snapshot).join('\n');

  assert.match(output, /logMetrics\.zvenfit_estetika_storage_errors_1m\.displayName/);
  assert.match(output, /alerts\.zvenfit_estetika_storage_errors\.delay/);
  assert.match(output, /alerts\.zvenfit_estetika_storage_errors\.labels/);
  assert.match(output, /notificationChannels\.zvenfit_estetika_telegram_alerts\.name/);
  assert.match(output, /notificationPolicy/);
  assert.match(output, /dashboard/);
  assert.match(output, /zvenfit_estetika_permanent_telegram_failures: missing/);
  assert.match(output, /zvenfit_estetika_legacy_alert: unexpected/);
});

test('ignores ordering-only differences in channels, labels and dashboard queries', () => {
  const snapshot = liveSnapshot();
  snapshot.notificationPolicy.channelIds.reverse();
  snapshot.notificationPolicy.statuses.reverse();
  snapshot.dashboard.telegramQueue.metricSelectors.reverse();

  assert.deepEqual(diffMonitoringState(config, snapshot), []);
});

test('redacts notification recipients from drift output', () => {
  const snapshot = liveSnapshot();
  const channel = snapshot.notificationChannels.find(
    item => item.id === 'zvenfit_estetika_email_alerts',
  );
  channel.recipient = 'private-operator@example.test';

  const output = diffMonitoringState(config, snapshot).join('\n');

  assert.match(output, /notificationChannels\.zvenfit_estetika_email_alerts\.recipient/);
  assert.match(output, /\[redacted\]/);
  assert.doesNotMatch(output, /private-operator@example\.test|cloud-account/);
});

test('CLI reads a canonical snapshot without modifying it', () => {
  const snapshotPath = path.join(ROOT, 'scripts/monitoring.config.json');
  const before = fs.readFileSync(snapshotPath, 'utf8');
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts/check-monitoring-drift.cjs'), '--snapshot', snapshotPath],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /live snapshot matches/);
  assert.equal(fs.readFileSync(snapshotPath, 'utf8'), before);
});
