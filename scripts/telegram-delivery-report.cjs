'use strict';

// Weekly lead → Telegram delivery report from one read-only YDB snapshot.
// Input: the result of the query below copied from the YDB console (TSV or CSV with a header).
// Output: aggregates only. No lead IDs, names, phones or payloads are printed.
//
// $o = (SELECT notification_id, status, attempts, created_at, delivered_at
//       FROM telegram_outbox WHERE kind = 'lead_created');
// SELECT
//     CurrentUtcTimestamp() AS snapshot_t,
//     Substring(CAST(COALESCE(l.lead_id, o.notification_id) AS String), 0, 8) AS id8,
//     l.created_at AS lead_created_at,
//     o.created_at AS outbox_created_at,
//     o.status AS status,
//     o.attempts AS attempts,
//     o.delivered_at AS delivered_at,
//     l.lead_id IS NULL AS no_lead,
//     o.notification_id IS NULL AS no_outbox
// FROM leads AS l
// FULL JOIN $o AS o ON l.lead_id = o.notification_id
// ORDER BY lead_created_at;
//
// Usage: node scripts/telegram-delivery-report.cjs --week 2026-11-16 [--threshold-minutes 10] [--cutoff <ISO>] < snapshot.tsv

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const COLUMNS = ['snapshot_t', 'lead_created_at', 'outbox_created_at', 'status', 'attempts', 'delivered_at', 'no_lead', 'no_outbox'];
const OPEN_STATUSES = new Set(['pending', 'sending']);

function parseTable(text) {
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
  if (lines.length === 0) throw new Error('empty_input');
  const split = line => (line.includes('\t') ? line.split('\t') : line.includes(',') ? line.split(',') : line.trim().split(/ {2,}/))
    .map(cell => cell.trim());
  const header = split(lines[0]);
  const idColumn = header.includes('id') ? 'id' : 'id8';
  for (const column of [...COLUMNS, idColumn]) {
    if (!header.includes(column)) throw new Error(`missing_column_${column}`);
  }
  return lines.slice(1).map(line => {
    const cells = split(line);
    if (cells.length !== header.length) throw new Error('column_count_mismatch');
    const raw = Object.fromEntries(header.map((column, index) => [column, cells[index] ?? '']));
    return { ...raw, id: raw[idColumn] };
  });
}

function time(value, field) {
  if (value === undefined || value === '' || /^null$/i.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`invalid_time_${field}`);
  return ms;
}

function bool(value, field) {
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  throw new Error(`invalid_bool_${field}`);
}

function normalize(raw) {
  return {
    id: raw.id,
    snapshot: time(raw.snapshot_t, 'snapshot_t'),
    createdAt: time(raw.lead_created_at, 'lead_created_at'),
    outboxCreatedAt: time(raw.outbox_created_at, 'outbox_created_at'),
    status: /^null$/i.test(raw.status) ? '' : raw.status,
    attempts: raw.attempts === '' || /^null$/i.test(raw.attempts) ? null : Number(raw.attempts),
    deliveredAt: time(raw.delivered_at, 'delivered_at'),
    noLead: bool(raw.no_lead, 'no_lead'),
    noOutbox: bool(raw.no_outbox, 'no_outbox'),
  };
}

function weekStartUtc(week) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new Error('invalid_week');
  const day = Date.parse(`${week}T00:00:00Z`);
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== week) throw new Error('invalid_week');
  const start = day - MSK_OFFSET_MS;
  if (new Date(start + MSK_OFFSET_MS).getUTCDay() !== 1) throw new Error('week_must_start_on_monday');
  return start;
}

// Nearest-rank percentile: with three delays p95 is the maximum.
function percentile(sorted, p) {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

function share(numerator, denominator) {
  return denominator === 0 ? null : { numerator, denominator, value: numerator / denominator };
}

function report(rows, { week, thresholdMs = 10 * 60 * 1000, cutoff } = {}) {
  const parsed = rows.map(row => (typeof row.snapshot === 'number' ? row : normalize(row)));
  const snapshots = new Set(parsed.map(row => row.snapshot));
  if (snapshots.size !== 1) throw new Error('expected_one_snapshot');
  const [snapshot] = snapshots;
  const T = cutoff === undefined ? snapshot : cutoff;
  if (T > snapshot) throw new Error('cutoff_after_snapshot');
  const start = weekStartUtc(week);
  const end = start + 7 * DAY_MS;
  if (T < start) throw new Error('cutoff_before_week');
  const exact = T === snapshot;

  // One record per ID; an identical repeat is ignored, a conflicting one stops the report.
  const byId = new Map();
  let duplicatesIgnored = 0;
  for (const row of parsed) {
    const key = `${row.noLead ? 'outbox' : 'lead'}:${row.id}`;
    const seen = byId.get(key);
    if (!seen) byId.set(key, row);
    else if (JSON.stringify(seen) === JSON.stringify(row)) duplicatesIgnored += 1;
    else throw new Error('conflicting_duplicate_id');
  }
  const unique = [...byId.values()];

  const outboxWithoutLead = unique.filter(row => row.noLead && row.outboxCreatedAt !== null
    && row.outboxCreatedAt >= start && row.outboxCreatedAt < end && row.outboxCreatedAt <= T).length;
  const cohort = unique.filter(row => !row.noLead && row.createdAt >= start && row.createdAt < end && row.createdAt <= T);

  const buckets = { delivered: 0, open: 0, failed: 0, no_outbox: 0, unknown_at_cutoff: 0 };
  const delays = [];
  const openAges = [];
  let mature = 0;
  let onTime = 0;
  let retried = 0;
  for (const lead of cohort) {
    const delivered = !lead.noOutbox && lead.deliveredAt !== null && lead.deliveredAt <= T;
    if (lead.attempts !== null && lead.attempts > 1) retried += 1;
    if (lead.noOutbox) buckets.no_outbox += 1;
    else if (delivered) {
      buckets.delivered += 1;
      delays.push(lead.deliveredAt - lead.createdAt);
    } else if (!exact) buckets.unknown_at_cutoff += 1;
    else if (OPEN_STATUSES.has(lead.status)) {
      buckets.open += 1;
      openAges.push(T - lead.createdAt);
    } else if (lead.status === 'failed') buckets.failed += 1;
    else buckets.unknown_at_cutoff += 1;

    if (lead.createdAt + thresholdMs <= T) {
      mature += 1;
      if (delivered && lead.deliveredAt - lead.createdAt <= thresholdMs) onTime += 1;
    }
  }
  delays.sort((a, b) => a - b);
  const seconds = ms => Math.round(ms / 100) / 10;

  return {
    week_start_msk: week,
    cutoff: new Date(T).toISOString(),
    snapshot: new Date(snapshot).toISOString(),
    period: T >= end ? 'full' : 'interim',
    cohort_exact: exact,
    threshold_minutes: thresholdMs / 60000,
    leads: cohort.length,
    duplicates_ignored: duplicatesIgnored,
    buckets,
    outbox_without_lead: outboxWithoutLead,
    delivered_by_cutoff: share(buckets.delivered, cohort.length),
    delivered_within_threshold: share(onTime, mature),
    young: cohort.length - mature,
    delivery_seconds: delays.length === 0 ? null : {
      n: delays.length,
      median: seconds(percentile(delays, 0.5)),
      p95: seconds(percentile(delays, 0.95)),
      max: seconds(delays[delays.length - 1]),
    },
    open: exact ? {
      n: openAges.length,
      max_age_seconds: openAges.length === 0 ? null : seconds(Math.max(...openAges)),
      overdue: openAges.filter(age => age > thresholdMs).length,
    } : null,
    retried_leads: retried,
    recipient_messages: 'unknown',
  };
}

function args(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--week') options.week = value;
    else if (flag === '--threshold-minutes') options.thresholdMs = Number(value) * 60000;
    else if (flag === '--cutoff') options.cutoff = time(value, 'cutoff');
    else throw new Error(`unknown_argument_${flag}`);
  }
  if (!options.week) throw new Error('missing_week');
  if (options.thresholdMs !== undefined && !(options.thresholdMs > 0)) throw new Error('invalid_threshold');
  return options;
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      console.log(JSON.stringify(report(parseTable(input), args(process.argv.slice(2))), null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'report_failed');
      process.exitCode = 1;
    }
  });
}

module.exports = { parseTable, report };
