'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const config = require('../monitoring.config.json');
const { diffMonitoringState, normalizeMonitoringState } = require('../check-monitoring-drift.cjs');

function liveSnapshot() {
  const snapshot = JSON.parse(JSON.stringify(config));
  for (const alert of snapshot.alerts) {
    alert.notificationChannelIds ??= [...snapshot.notificationPolicy.channelIds];
    alert.notificationRepeatMinutes ??= snapshot.notificationPolicy.repeatMinutes;
  }

  return snapshot;
}

const ROOT = path.resolve(__dirname, '../..');

test('normalizes Estetika monitoring resources into a stable read-only contract', () => {
  const normalized = normalizeMonitoringState(config);

  assert.equal(normalized.logMetrics.length, 9);
  assert.equal(normalized.alerts.length, 14);
  assert.equal(normalized.notificationChannels.length, 2);
  assert.equal(normalized.dashboard.title, 'ZvenFit Estetika · production');
  assert.deepEqual(diffMonitoringState(config, liveSnapshot()), []);
});

test('reports a live alert whose inherited notification settings are omitted', () => {
  const snapshot = liveSnapshot();
  const alert = snapshot.alerts.find(item => item.id === 'zfe_function_runtime_errors');
  delete alert.notificationChannelIds;
  delete alert.notificationRepeatMinutes;

  const output = diffMonitoringState(config, snapshot).join('\n');
  assert.match(output, /alerts\.zfe_function_runtime_errors\.notificationChannelIds/);
  assert.match(output, /alerts\.zfe_function_runtime_errors\.notificationRepeatMinutes/);
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
    item => item.id !== 'zfe_permanent_telegram_failures',
  );
  snapshot.alerts.push({ id: 'zvenfit_estetika_legacy_alert' });

  const output = diffMonitoringState(config, snapshot).join('\n');

  assert.match(output, /logMetrics\.zvenfit_estetika_storage_errors_1m\.displayName/);
  assert.match(output, /alerts\.zvenfit_estetika_storage_errors\.delay/);
  assert.match(output, /alerts\.zvenfit_estetika_storage_errors\.labels/);
  assert.match(output, /notificationChannels\.zvenfit_estetika_telegram_alerts\.name/);
  assert.match(output, /notificationPolicy/);
  assert.match(output, /dashboard/);
  assert.match(output, /zfe_permanent_telegram_failures: missing/);
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
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'zfe-monitoring-drift-'));
  const snapshotPath = path.join(temporaryDirectory, 'monium-live.json');

  try {
    fs.writeFileSync(snapshotPath, JSON.stringify(liveSnapshot()), 'utf8');
    const before = fs.readFileSync(snapshotPath, 'utf8');
    const result = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts/check-monitoring-drift.cjs'), '--snapshot', snapshotPath],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /live snapshot matches/);
    assert.equal(fs.readFileSync(snapshotPath, 'utf8'), before);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
